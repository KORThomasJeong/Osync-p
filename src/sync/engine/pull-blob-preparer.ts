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

    return await mapWithConcurrency(
      blobPlans,
      this.deps.prepareConcurrency ?? DEFAULT_PREPARE_CONCURRENCY,
      async (plan) => {
        return {
          plan,
          bytes: await this.downloadAndVerifyEntryBlob(store, token, plan),
        };
      },
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
      throw error;
    }
    const actualHash = await hashBytes(bytes);
    if (actualHash !== plan.hash) {
      throw new Error(
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
