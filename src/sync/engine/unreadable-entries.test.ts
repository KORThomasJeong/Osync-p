import { afterEach, describe, expect, it, vi } from "vitest";

import { decryptSyncMetadata, encryptSyncMetadata } from "../core/crypto";
import { VaultKeyCryptoService } from "../core/crypto-service";
import type { CommitMutationPayload, SyncRealtimeSession } from "../remote/realtime-client";
import { SyncLocalReconcileService } from "./local-reconcile-service";
import { SyncPullService } from "./pull-service";
import type { RemoteEntryState } from "../remote/changes";
import type { SyncStore } from "../store/store";
import {
  commitUnreadableRemovals,
  detachLocalEntries,
  isUnreadablePlaceholderPath,
  recoverUnreadableEntries,
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
  encryptPendingMetadata,
  encryptRemoteMetadata,
  encryptTestBlob,
  hashText,
  ignoreProgress,
  TEST_VAULT_KEY,
} from "./__tests__/pull-service/helpers";

afterEach(() => {
  vi.restoreAllMocks();
});

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

async function readableCommit(input: {
  cursor: number;
  entryId: string;
  path: string;
  body: string;
}) {
  const blobId = `blob-${input.entryId}`;
  return createCommit({
    cursor: input.cursor,
    entryId: input.entryId,
    revision: 1,
    blobId,
    encryptedMetadata: await encryptRemoteMetadata({
      entryId: input.entryId,
      revision: 1,
      blobId,
      path: input.path,
      hash: await hashText(input.body),
    }),
  });
}

async function queueLocalNewFile(store: SyncStore, entryId: string, path: string, body: string) {
  const hash = await hashText(body);
  await store.upsertEntry({
    entryId,
    path,
    revision: 0,
    blobId: `blob-${entryId}`,
    hash,
    deleted: false,
    updatedAt: 1,
  });
  await store.markEntryDirty({
    mutationId: `mutation-${entryId}`,
    entryId,
    op: "upsert",
    baseRevision: 0,
    blobId: `blob-${entryId}`,
    hash,
    encryptedMetadata: await encryptPendingMetadata({
      entryId,
      baseRevision: 0,
      op: "upsert",
      blobId: `blob-${entryId}`,
      path,
      hash,
    }),
    createdAt: 2,
  });
}

// While this device held another vault's key, its pulls quarantined entries it could
// not decrypt and the cursor moved past them. Once the key is corrected those entries
// must be fetched again (their current server state, below the cursor) and applied
// through the normal pull path, without moving the cursor or deleting anything local.
describe("recoverUnreadableEntries", () => {
  async function arrange() {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    await store.setCursor(40);
    const adapter = createVaultAdapter({
      "Notes/same.md": "same body",
      "Notes/diverged.md": "my local body",
    });
    // Seen by the local scan while the remote entries were quarantined: queued as new.
    await queueLocalNewFile(store, "local-same", "Notes/same.md", "same body");
    await queueLocalNewFile(store, "local-diverged", "Notes/diverged.md", "my local body");
    const blobs: Record<string, Uint8Array> = {};
    for (const [entryId, body] of [
      ["rec-new", "server new"],
      ["rec-same", "same body"],
      ["rec-diverged", "server body"],
      ["unrelated", "not requested"],
    ] as const) {
      blobs[`blob-${entryId}`] = await encryptTestBlob(
        `blob-${entryId}`,
        new TextEncoder().encode(body),
      );
    }
    const conflicts: string[] = [];
    const pull = new SyncPullService({
      getApiBaseUrl: () => "http://127.0.0.1:8787",
      getSyncToken: async () => createToken(),
      getSyncStore: () => store,
      crypto,
      vaultAdapter: adapter,
      eventGate: createEventGate([]),
      pullClient: createPullClient({ blobs }),
      onProgress: ignoreProgress,
      onConflict: (event) => conflicts.push(event.originalPath),
    });
    const session = sessionWithCommits([
      [
        await readableCommit({ cursor: 3, entryId: "rec-new", path: "Notes/new.md", body: "server new" }),
        await commitWith(WRONG_KEY, { cursor: 5, entryId: "still-bad", path: "Notes/bad.md" }),
        await readableCommit({
          cursor: 7,
          entryId: "unrelated",
          path: "Notes/unrelated.md",
          body: "not requested",
        }),
      ],
      [
        await readableCommit({ cursor: 9, entryId: "rec-same", path: "Notes/same.md", body: "same body" }),
        await readableCommit({
          cursor: 11,
          entryId: "rec-diverged",
          path: "Notes/diverged.md",
          body: "server body",
        }),
      ],
    ]);
    return { store, adapter, pull, session, conflicts };
  }

  it("applies the entries that now decrypt through the pull path, in batches, without moving the cursor", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { store, adapter, pull, session, conflicts } = await arrange();
    const batches: string[][] = [];

    const result = await recoverUnreadableEntries({
      session,
      crypto,
      entryIds: ["rec-new", "still-bad", "rec-same", "rec-diverged", "gone"],
      applyRemoteEntryStates: async (states: RemoteEntryState[]) => {
        batches.push(states.map((state) => state.entryId));
        await pull.applyRemoteEntryStates(states);
      },
      batchSize: 2,
    });

    expect([...result.applied].sort()).toEqual(["rec-diverged", "rec-new", "rec-same"]);
    expect(result.stillUnreadable).toEqual(["still-bad"]);
    expect(result.notFound).toEqual(["gone"]);
    expect(result.failed).toEqual([]);
    expect(batches.map((batch) => batch.length)).toEqual([2, 1]);
    expect(batches.flat()).not.toContain("unrelated");

    // Recovered: written, adopted (identical local file), or a conflict keeping both.
    expect(adapter.text("Notes/new.md")).toBe("server new");
    expect(adapter.text("Notes/same.md")).toBe("same body");
    const bodies = [...adapter.files.keys()].map((path) => adapter.text(path));
    expect(bodies).toContain("my local body");
    expect(bodies).toContain("server body");
    expect(conflicts).toEqual(["Notes/diverged.md"]);
    // Still unreadable: never written, never a reason to delete anything.
    expect(adapter.text("Notes/bad.md")).toBeNull();
    expect(adapter.text("Notes/unrelated.md")).toBeNull();
    expect(adapter.files.size).toBe(4);
    expect(await store.getCursor()).toBe(40);
    await store.close();
  });

  it("keeps a batch whose apply failed as a candidate and still applies the others", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { store, adapter, pull, session } = await arrange();

    const result = await recoverUnreadableEntries({
      session,
      crypto,
      entryIds: ["rec-new", "rec-same"],
      applyRemoteEntryStates: async (states: RemoteEntryState[]) => {
        if (states.some((state) => state.entryId === "rec-new")) {
          throw new Error("network down");
        }
        await pull.applyRemoteEntryStates(states);
      },
      batchSize: 1,
    });

    expect(result.failed).toEqual(["rec-new"]);
    expect(result.applied).toEqual(["rec-same"]);
    expect(adapter.text("Notes/new.md")).toBeNull();
    await store.close();
  });
});
