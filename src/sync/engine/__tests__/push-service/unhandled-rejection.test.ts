import { describe, expect, it } from "vitest";
import { VaultKeyCryptoService } from "../../../core/crypto-service";

import { hashBytes } from "../../../core/content";
import { SyncRealtimeError } from "../../../remote/realtime-client";
import { createInitializedTestSyncStore, createTestPlugin } from "../../../../test-support/test-plugin";
import { SyncPushService } from "../../push-service";
import {
  createPushSession,
  createToken,
  encryptMutationMetadata,
  ignoreProgress,
  TEST_VAULT_KEY,
} from "./helpers";

describe("SyncPushService unhandled rejection isolation", () => {
  it("blocks a mutation rejected with an unclassified code instead of aborting the whole drain", async () => {
    const plugin = createTestPlugin();
    const store = await createInitializedTestSyncStore(plugin);
    const body = new TextEncoder().encode("body");
    const hash = await hashBytes(body);

    for (const [id, entry] of [
      ["mutation-bad", "entry-bad"],
      ["mutation-good", "entry-good"],
    ] as const) {
      await store.markEntryDirty({
        mutationId: id,
        entryId: entry,
        op: "upsert",
        baseRevision: 0,
        blobId: `blob-${entry}`,
        hash,
        encryptedMetadata: await encryptMutationMetadata({
          entryId: entry,
          baseRevision: 0,
          op: "upsert",
          blobId: `blob-${entry}`,
          path: `Folder/${entry}.md`,
          hash,
        }),
        createdAt: 1,
      });
    }

    const session = createPushSession(async (mutation) => {
      if (mutation.entryId === "entry-bad") {
        // A rejection code the client does not classify (e.g. the new server-side
        // mutation_id_conflict). This must not throw and kill the whole push.
        throw new SyncRealtimeError("mutation_id_conflict", "id reused for another entry");
      }
      return { cursor: 5, entryId: mutation.entryId, revision: 1 };
    });

    const service = new SyncPushService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
      fileReader: { async readBytes() { return body; } },
      blobClient: { async uploadBlob() {} },
      onProgress: ignoreProgress,
    });

    // The push must complete without throwing despite the unclassified rejection.
    const result = await service.pushPendingMutations(session);

    // The healthy mutation still went through.
    expect(result.mutationsPushed).toBe(1);
    // The bad one is no longer a live dirty entry (it was blocked, not retried forever).
    const stillDirty = await store.listDirtyEntries(10);
    expect(stillDirty.some((m) => m.entryId === "entry-bad")).toBe(false);
  });
});
