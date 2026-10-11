import { describe, expect, it } from "vitest";

import { decryptSyncMetadata, encryptSyncMetadata } from "../core/crypto";
import { VaultKeyCryptoService } from "../core/crypto-service";
import type { CommitMutationPayload, SyncRealtimeSession } from "../remote/realtime-client";
import { SyncLocalReconcileService } from "./local-reconcile-service";
import { SyncPullService } from "./pull-service";
import {
  commitUnreadableRemovals,
  detachLocalEntries,
  isUnreadablePlaceholderPath,
  scanUnreadableRemoteEntries,
  unreadablePlaceholderPath,
} from "./unreadable-entries";
import {
  createInitializedTestSyncStore,
  createTestPlugin,
} from "../../test-support/test-plugin";
import {
  createCommit,
  createEventGate,
  createPullClient,
  createRealtimeSession,
  createToken,
  createVaultAdapter,
  hashText,
  ignoreProgress,
  TEST_VAULT_KEY,
} from "./__tests__/pull-service/helpers";

const WRONG_KEY = new Uint8Array(32).fill(7);
const crypto = new VaultKeyCryptoService(() => TEST_VAULT_KEY);

async function commitWith(
  key: Uint8Array,
  input: { cursor: number; entryId: string; path: string; deleted?: boolean; revision?: number },
) {
  const revision = input.revision ?? 1;
  const blobId = input.deleted ? null : `blob-${input.entryId}`;
  return createCommit({
    cursor: input.cursor,
    entryId: input.entryId,
    op: input.deleted ? "delete" : "upsert",
    revision,
    blobId,
    encryptedMetadata: await encryptSyncMetadata(
      key,
      { path: input.path, hash: input.deleted ? null : "h" },
      { entryId: input.entryId, revision, op: input.deleted ? "delete" : "upsert", blobId },
    ),
  });
}

function sessionWithCommits(
  pages: Array<ReturnType<typeof createCommit>[]>,
  committed: CommitMutationPayload[] = [],
  reject: Set<string> = new Set(),
): SyncRealtimeSession {
  const base = createRealtimeSession({
    pages: pages.map((commits, index) => ({
      cursor: Math.max(0, ...commits.map((commit) => commit.cursor)),
      hasMore: index < pages.length - 1,
      commits,
    })),
  });
  return {
    ...base,
    async commitMutations(mutations) {
      committed.push(...mutations);
      return {
        cursor: 100,
        results: mutations.map((mutation, index) =>
          reject.has(mutation.entryId)
            ? {
                status: "rejected" as const,
                mutationId: mutation.mutationId,
                entryId: mutation.entryId,
                code: "stale_revision",
                message: "changed",
              }
            : {
                status: "accepted" as const,
                mutationId: mutation.mutationId,
                cursor: 100 + index,
                entryId: mutation.entryId,
                revision: mutation.baseRevision + 1,
              },
        ),
      };
    },
  };
}

describe("scanUnreadableRemoteEntries", () => {
  it("lists live entries this key cannot decrypt, across pages, with progress", async () => {
    const progress: Array<[number, number]> = [];
    const session = sessionWithCommits([
      [
        await commitWith(TEST_VAULT_KEY, { cursor: 1, entryId: "ok", path: "a.md" }),
        await commitWith(WRONG_KEY, { cursor: 2, entryId: "bad-1", path: "b.md", revision: 4 }),
      ],
      [
        await commitWith(WRONG_KEY, { cursor: 3, entryId: "bad-gone", path: "c.md", deleted: true }),
        await commitWith(WRONG_KEY, { cursor: 4, entryId: "bad-2", path: "d.md" }),
      ],
    ]);

    const result = await scanUnreadableRemoteEntries({
      session,
      crypto,
      onProgress: (scanned, total) => progress.push([scanned, total]),
    });

    expect(result.unreadable.map((entry) => [entry.entryId, entry.revision])).toEqual([
      ["bad-1", 4],
      ["bad-2", 1],
    ]);
    expect(result.scannedEntries).toBe(4);
    expect(progress.at(-1)).toEqual([4, 4]);
  });
});

describe("commitUnreadableRemovals", () => {
  it("deletes each unreadable entry at its current revision with a placeholder path encrypted with this key", async () => {
    const committed: CommitMutationPayload[] = [];
    const session = sessionWithCommits([], committed, new Set(["bad-2"]));

    const result = await commitUnreadableRemovals({
      session,
      crypto,
      targets: [
        { entryId: "bad-1", revision: 4, entryType: "file" },
        { entryId: "bad-2", revision: 1, entryType: "file" },
      ],
      now: () => 42,
    });

    expect(result.removed).toEqual(["bad-1"]);
    expect(result.failed).toEqual([{ entryId: "bad-2", code: "stale_revision" }]);
    expect(committed[0]).toMatchObject({
      entryId: "bad-1",
      op: "delete",
      baseRevision: 4,
      blobId: null,
      entryType: "file",
    });
    const metadata = await decryptSyncMetadata(TEST_VAULT_KEY, committed[0]!.encryptedMetadata, {
      entryId: "bad-1",
      revision: 5,
      op: "delete",
      blobId: null,
    });
    expect(metadata.path).toBe(unreadablePlaceholderPath("bad-1"));
    expect(isUnreadablePlaceholderPath(metadata.path)).toBe(true);
    expect(isUnreadablePlaceholderPath("Notes/.osync-unreadable-ish.md")).toBe(false);
  });
});

// Item 6: the device that encrypted with the wrong key reconnects with the right one.
// Its own entries on the server are unreadable to it now, but the files are plaintext on
// its disk. They must be re-uploaded as new entries; nothing local may be deleted.
describe("repair after reconnecting with the correct key", () => {
  it("re-uploads local files whose server entries are unreadable and deletes nothing", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const adapter = createVaultAdapter({
      "Notes/written-with-wrong-key.md": "iphone note",
      "Notes/readable.md": "shared note",
    });
    // Local store from the wrong-key era: both files known and in sync.
    await store.setCursor(2);
    for (const [entryId, path, body] of [
      ["entry-wrong", "Notes/written-with-wrong-key.md", "iphone note"],
      ["entry-ok", "Notes/readable.md", "shared note"],
    ] as const) {
      await store.upsertEntry({
        entryId,
        path,
        revision: 1,
        blobId: `blob-${entryId}`,
        hash: await hashText(body),
        deleted: false,
        updatedAt: 1,
        localMtime: 10,
        localSize: 1,
      });
    }

    const session = sessionWithCommits([
      [
        await commitWith(WRONG_KEY, { cursor: 1, entryId: "entry-wrong", path: "Notes/written-with-wrong-key.md" }),
        await commitWith(TEST_VAULT_KEY, { cursor: 2, entryId: "entry-ok", path: "Notes/readable.md" }),
      ],
    ]);

    const scan = await scanUnreadableRemoteEntries({ session, crypto });
    const detached = await detachLocalEntries(
      store,
      scan.unreadable.map((entry) => entry.entryId),
    );
    expect(detached).toEqual(["entry-wrong"]);

    const reconcile = new SyncLocalReconcileService({
      getSyncStore: () => store,
      crypto,
      shouldSyncPath: () => true,
      scanner: {
        async listFiles() {
          return [...adapter.files.entries()].map(([path, bytes]) => ({
            path,
            mtime: 10,
            size: bytes.byteLength,
            readBytes: async () => bytes,
          }));
        },
        listFolders() {
          return [];
        },
      },
    });
    const result = await reconcile.reconcileOnce();

    expect(result.filesQueuedForDelete).toBe(0);
    expect(result.filesQueuedForUpsert).toBe(1);
    const pending = await store.listDirtyEntries();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.op).toBe("upsert");
    expect(pending[0]!.entryId).not.toBe("entry-wrong");
    expect(pending[0]!.baseRevision).toBe(0);
    const pendingMeta = await crypto.decryptMetadata(pending[0]!.encryptedMetadata, {
      entryId: pending[0]!.entryId,
      revision: 1,
      op: "upsert",
      blobId: pending[0]!.blobId,
    });
    expect(pendingMeta.path).toBe("Notes/written-with-wrong-key.md");

    // Later, another device removes the unreadable entry from the server. Pulling that
    // removal must not touch the re-uploaded local file.
    const pull = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto,
      vaultAdapter: adapter,
      eventGate: createEventGate([]),
      pullClient: createPullClient({}),
      onProgress: ignoreProgress,
    });
    await pull.pullOnce(
      createRealtimeSession({
        pages: [
          {
            cursor: 3,
            hasMore: false,
            commits: [
              createCommit({
                cursor: 3,
                entryId: "entry-wrong",
                op: "delete",
                revision: 2,
                baseRevision: 1,
                blobId: null,
                encryptedMetadata: await encryptSyncMetadata(
                  TEST_VAULT_KEY,
                  { path: unreadablePlaceholderPath("entry-wrong"), hash: null },
                  { entryId: "entry-wrong", revision: 2, op: "delete", blobId: null },
                ),
              }),
            ],
          },
        ],
      }),
    );

    expect(adapter.text("Notes/written-with-wrong-key.md")).toBe("iphone note");
    expect(adapter.text("Notes/readable.md")).toBe("shared note");
    expect(await store.listDirtyEntries()).toHaveLength(1);
    await store.close();
  });
});
