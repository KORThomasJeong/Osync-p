import { hashBytes } from "../core/content";
import { mapWithConcurrency } from "../core/concurrency";
import type { SyncCryptoService } from "../core/crypto-service";
import type { SyncTokenResponse } from "../remote/client";
import type { RemoteEntryState } from "../remote/changes";
import type { SyncPullClient } from "../remote/pull-client";
import type { SyncBlobStore } from "../store/ports";
import { isAutoMergeTextPath } from "./text-merge-policy";
import {
  DEFAULT_PREPARE_CONCURRENCY,
  type PlannedEntryState,
  type PreparedEntryBlob,
  requireBlobId,
} from "./pull-entry-state-internal";

interface PullBlobPreparerDeps {
  getApiBaseUrl: () => string;
  crypto: SyncCryptoService;
  pullClient: Pick<SyncPullClient, "downloadBlob">;
  prepareConcurrency?: number;
  // Notified (best-effort) when a blob was downloaded but permanently failed
  // verification (undecryptable ciphertext or content-hash mismatch) and was
  // quarantined. Never throws the pull.
  onDecryptFailure?: (entryId: string) => void;
}

/**
 * A blob that downloaded successfully (HTTP 200) but failed verification in a
 * way that is deterministic and permanent — the ciphertext will not decrypt, or
 * the decrypted content does not match the metadata hash. Retrying re-downloads
 * the identical bytes and fails identically, so a plain throw here would stall
 * the pull at this cursor and re-download the whole batch forever. These are
 * quarantined (skipped) instead. Transient failures (missing blob, network,
 * 5xx) are NOT this error — they still propagate so the window rolls back and
 * retries, which can succeed later.
 */
export class BlobVerificationError extends Error {
  constructor(
    readonly entryId: string,
    message: string,
  ) {
    super(message);
    this.name = "BlobVerificationError";
  }
}

export class PullBlobPreparer {
  constructor(private readonly deps: PullBlobPreparerDeps) {}

  async preparePathBatchBlobs(
    store: SyncBlobStore,
    token: SyncTokenResponse,
    plans: PlannedEntryState[],
  ): Promise<PreparedEntryBlob[]> {
    const blobPlans = plans.filter(
      (plan) =>
        plan.finalPath &&
        !plan.state.deleted &&
        plan.state.entryType !== "folder",
    );

    const prepared = await mapWithConcurrency(
      blobPlans,
      this.deps.prepareConcurrency ?? DEFAULT_PREPARE_CONCURRENCY,
      async (plan): Promise<PreparedEntryBlob | null> => {
        try {
          return {
            plan,
            bytes: await this.downloadAndVerifyEntryBlob(store, token, plan),
          };
        } catch (error) {
          if (error instanceof BlobVerificationError) {
            // Permanent failure: quarantine this entry so the healthy entries in
            // the batch still apply and the cursor advances past the poison blob.
            this.deps.onDecryptFailure?.(error.entryId);
            return null;
          }
          // Transient failure (missing blob, network, 5xx): preserve the
          // all-or-nothing rollback + retry behavior.
          throw error;
        }
      },
    );

    return prepared.filter(
      (entry): entry is PreparedEntryBlob => entry !== null,
    );
  }

  private async downloadEntryBlob(
    token: SyncTokenResponse,
    state: RemoteEntryState,
  ): Promise<Uint8Array> {
    if (!state.blobId) {
      throw new Error(`Entry state ${state.entryId}@${state.revision} is missing a blob.`);
    }

    return await this.deps.pullClient.downloadBlob(
      this.deps.getApiBaseUrl(),
      token.token,
      token.vaultId,
      state.blobId,
    );
  }

  private async downloadAndVerifyEntryBlob(
    store: SyncBlobStore,
    token: SyncTokenResponse,
    plan: PlannedEntryState,
  ): Promise<Uint8Array> {
    const blobId = requireBlobId(plan.state);
    const encryptedBytes = await this.downloadEntryBlob(token, plan.state);
    let bytes: Uint8Array;
    try {
      bytes = await this.deps.crypto.decryptBlob(encryptedBytes, { blobId });
    } catch (error) {
      console.error(
        `[osync] pull: failed to decrypt blob ${blobId} for entry ${plan.state.entryId} rev=${plan.state.revision}`,
        error,
      );
      throw new BlobVerificationError(
        plan.state.entryId,
        `Entry state ${plan.state.entryId}@${plan.state.revision} blob could not be decrypted.`,
      );
    }
    const actualHash = await hashBytes(bytes);
    if (actualHash !== plan.hash) {
      throw new BlobVerificationError(
        plan.state.entryId,
        `Entry state ${plan.state.entryId}@${plan.state.revision} hash does not match metadata.`,
      );
    }
    if (plan.finalPath && isAutoMergeTextPath(plan.finalPath)) {
      await store.putBlob({
        blobId,
        hash: actualHash,
        encryptedBytes,
        role: "remote",
        refEntryId: plan.state.entryId,
        cachedAt: Date.now(),
      });
    }

    return bytes;
  }
}
