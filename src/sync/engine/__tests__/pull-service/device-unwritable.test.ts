import { describe, expect, it } from "vitest";

import { VaultKeyCryptoService } from "../../../core/crypto-service";
import { DEFAULT_SYNC_FILE_RULES, shouldSyncPath } from "../../../core/file-rules";
import {
  describeDeviceWriteIssue,
  type DevicePathPolicy,
} from "../../../core/path-portability";
import type { SyncStore } from "../../../store/store";
import { SyncLocalReconcileService } from "../../local-reconcile-service";
import type { PullDeviceIssueEvent } from "../../pull-entry-state-applier";
import { SyncPullService } from "../../pull-service";
import {
  createInitializedTestSyncStore,
  createTestPlugin,
} from "../../../../test-support/test-plugin";
import {
  createCommit,
  createEventGate,
  createPullClient,
  createRealtimeSession,
  createToken,
  createVaultAdapter,
  encryptFolderMetadata,
  encryptRemoteMetadata,
  encryptTestBlob,
  hashText,
  ignoreProgress,
  TEST_VAULT_KEY,
} from "./helpers";

const WINDOWS_POLICY: DevicePathPolicy = {
  describeUnwritable: (path) => describeDeviceWriteIssue(path, { isWin: true }),
};
const BAD_PATH = "2026/260719 너희는 나를 누구라 하느냐?.md";
const GOOD_PATH = "2026/260720 ok.md";

type VaultAdapter = ReturnType<typeof createVaultAdapter>;

async function fileCommit(input: {
  cursor: number;
  entryId: string;
  revision?: number;
  path: string;
  body: string;
  deleted?: boolean;
}) {
  const revision = input.revision ?? 1;
  const blobId = input.deleted ? null : `blob-${input.entryId}-${revision}`;
  return createCommit({
    cursor: input.cursor,
    entryId: input.entryId,
    revision,
    op: input.deleted ? "delete" : "upsert",
    blobId,
    encryptedMetadata: await encryptRemoteMetadata({
      entryId: input.entryId,
      revision,
      blobId,
      deleted: input.deleted,
      path: input.path,
      hash: input.deleted ? undefined : await hashText(input.body),
    }),
  });
}

async function blobsFor(
  entries: Array<{ entryId: string; revision?: number; body: string }>,
): Promise<Record<string, Uint8Array>> {
  const blobs: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    const blobId = `blob-${entry.entryId}-${entry.revision ?? 1}`;
    blobs[blobId] = await encryptTestBlob(blobId, new TextEncoder().encode(entry.body));
  }
  return blobs;
}

function createService(input: {
  store: SyncStore;
  adapter: Pick<
    VaultAdapter,
    "exists" | "mkdir" | "readBytes" | "writeText" | "writeBinary" | "remove" | "isFolderEmpty"
  >;
  blobs: Record<string, Uint8Array>;
  policy?: DevicePathPolicy;
  events: PullDeviceIssueEvent[];
  rules?: typeof DEFAULT_SYNC_FILE_RULES;
}) {
  return new SyncPullService({
    getApiBaseUrl: () => "http://127.0.0.1:8787",
    getSyncToken: async () => createToken(),
    getSyncStore: () => input.store,
    crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
    vaultAdapter: input.adapter,
    eventGate: createEventGate([]),
    pullClient: createPullClient({ blobs: input.blobs }),
    getSyncFileRules: () => input.rules ?? DEFAULT_SYNC_FILE_RULES,
    getDevicePathPolicy: input.policy ? () => input.policy! : undefined,
    onDeviceIssue: (event) => input.events.push(event),
    onProgress: ignoreProgress,
  });
}

function createReconcile(
  store: SyncStore,
  adapter: VaultAdapter,
  shouldSync: (path: string) => boolean,
) {
  return new SyncLocalReconcileService({
    getSyncStore: () => store,
    crypto: new VaultKeyCryptoService(() => TEST_VAULT_KEY),
    shouldSyncPath: shouldSync,
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
        return [...adapter.directories];
      },
    },
  });
}

describe("SyncPullService device-unwritable paths", () => {
  it("skips a Windows-invalid remote path, writes the rest and advances the cursor", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const adapter = createVaultAdapter();
    const events: PullDeviceIssueEvent[] = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 2,
          hasMore: false,
          commits: [
            await fileCommit({ cursor: 1, entryId: "bad", path: BAD_PATH, body: "sermon" }),
            await fileCommit({ cursor: 2, entryId: "good", path: GOOD_PATH, body: "fine" }),
          ],
        },
      ],
    });

    const result = await createService({
      store,
      adapter,
      blobs: await blobsFor([
        { entryId: "bad", body: "sermon" },
        { entryId: "good", body: "fine" },
      ]),
      policy: WINDOWS_POLICY,
      events,
    }).pullOnce(session);

    expect(result.cursor).toBe(2);
    expect(adapter.text(GOOD_PATH)).toBe("fine");
    expect(adapter.files.has(BAD_PATH)).toBe(false);
    expect((await store.getRemoteStateById("bad"))?.revision).toBe(1);
    // Never recorded as present locally, so no scan can turn it into a delete even if
    // the device policy changes or is lost.
    expect(await store.getLocalStateById("bad")).toBeNull();
    expect(events).toContainEqual({
      kind: "skipped",
      entryId: "bad",
      path: BAD_PATH,
      reason: 'Name not allowed on Windows (contains "?")',
    });
    expect(events).toContainEqual({ kind: "resolved", entryId: "good", path: GOOD_PATH });

    // The skipped entry is device-excluded: a later scan must not delete it remotely.
    const reconcile = await createReconcile(store, adapter, (path) =>
      shouldSyncPath(path, DEFAULT_SYNC_FILE_RULES, WINDOWS_POLICY),
    ).reconcileOnce();
    expect(reconcile.filesQueuedForDelete).toBe(0);
    expect(await store.getDirtyEntryMutation("bad")).toBeNull();

    await store.close();
  });

  it("routes the path-limit skip through the same device exclusion (no delete afterwards)", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const adapter = createVaultAdapter();
    const events: PullDeviceIssueEvent[] = [];
    const longPath = `Notes/${"가".repeat(85)}.md`;
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 1,
          hasMore: false,
          commits: [await fileCommit({ cursor: 1, entryId: "long", path: longPath, body: "x" })],
        },
      ],
    });

    // No device policy: the default path limits still apply.
    await createService({
      store,
      adapter,
      blobs: await blobsFor([{ entryId: "long", body: "x" }]),
      events,
    }).pullOnce(session);

    expect(adapter.files.size).toBe(0);
    expect(events).toEqual([
      {
        kind: "skipped",
        entryId: "long",
        path: longPath,
        reason: "File name too long (258 bytes, limit 250)",
      },
    ]);

    const reconcile = await createReconcile(store, adapter, (path) =>
      shouldSyncPath(path, DEFAULT_SYNC_FILE_RULES),
    ).reconcileOnce();
    expect(reconcile.filesQueuedForDelete).toBe(0);
    expect(await store.getDirtyEntryMutation("long")).toBeNull();

    await store.close();
  });

  it("keeps an entry whose write failed out of local state when it is pulled again", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const adapter = createVaultAdapter();
    const failed = new Set<string>();
    const policy: DevicePathPolicy = {
      describeUnwritable: (path) => (failed.has(path) ? "EBUSY" : null),
    };
    const events: PullDeviceIssueEvent[] = [];
    const blobs = await blobsFor([
      { entryId: "e", body: "v1" },
      { entryId: "e", revision: 2, body: "v2" },
    ]);
    const lockedAdapter = {
      ...adapter,
      async writeText(path: string): Promise<void> {
        throw new Error(`EBUSY: ${path}`);
      },
    };

    await createService({ store, adapter: lockedAdapter, blobs, policy, events }).pullOnce(
      createRealtimeSession({
        pages: [
          {
            cursor: 1,
            hasMore: false,
            commits: [await fileCommit({ cursor: 1, entryId: "e", path: "a.md", body: "v1" })],
          },
        ],
      }),
    );
    failed.add("a.md");

    // Edited remotely: now skipped because it is in the failure set.
    const result = await createService({ store, adapter, blobs, policy, events }).pullOnce(
      createRealtimeSession({
        pages: [
          {
            cursor: 2,
            hasMore: false,
            commits: [
              await fileCommit({ cursor: 2, entryId: "e", revision: 2, path: "a.md", body: "v2" }),
            ],
          },
        ],
      }),
    );

    expect(result.cursor).toBe(2);
    expect(adapter.files.has("a.md")).toBe(false);
    expect((await store.getRemoteStateById("e"))?.revision).toBe(2);
    expect(await store.getLocalStateById("e")).toBeNull();
    // Even a scan that has forgotten the failure queues no delete.
    const reconcile = await createReconcile(store, adapter, () => true).reconcileOnce();
    expect(reconcile.filesQueuedForDelete).toBe(0);
    await store.close();
  });

  it("does not report user-excluded paths as device issues", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const adapter = createVaultAdapter();
    const events: PullDeviceIssueEvent[] = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 1,
          hasMore: false,
          commits: [
            await fileCommit({ cursor: 1, entryId: "ex", path: "Archive/what?.md", body: "x" }),
          ],
        },
      ],
    });

    await createService({
      store,
      adapter,
      blobs: await blobsFor([{ entryId: "ex", body: "x" }]),
      policy: WINDOWS_POLICY,
      events,
      rules: { ...DEFAULT_SYNC_FILE_RULES, excludedFolders: ["Archive"] },
    }).pullOnce(session);

    expect(events).toEqual([{ kind: "resolved", entryId: "ex", path: "Archive/what?.md" }]);
    await store.close();
  });

  it("isolates a failing write: the pull completes, the rest is written and no delete follows", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const adapter = createVaultAdapter();
    const failingPath = "2026/locked.md";
    const failingAdapter = {
      ...adapter,
      async writeText(path: string, content: string): Promise<void> {
        if (path === failingPath) {
          throw new Error(`ENOENT: no such file or directory, open '${path}'`);
        }
        await adapter.writeText(path, content);
      },
    };
    const events: PullDeviceIssueEvent[] = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 2,
          hasMore: false,
          commits: [
            await fileCommit({ cursor: 1, entryId: "fail", path: failingPath, body: "a" }),
            await fileCommit({ cursor: 2, entryId: "good", path: GOOD_PATH, body: "b" }),
          ],
        },
      ],
    });

    const result = await createService({
      store,
      adapter: failingAdapter,
      blobs: await blobsFor([
        { entryId: "fail", body: "a" },
        { entryId: "good", body: "b" },
      ]),
      events,
    }).pullOnce(session);

    expect(result.cursor).toBe(2);
    expect(await store.getCursor()).toBe(2);
    expect(adapter.text(GOOD_PATH)).toBe("b");
    expect(adapter.files.has(failingPath)).toBe(false);
    expect(events).toContainEqual({
      kind: "write_failed",
      entryId: "fail",
      path: failingPath,
      reason: `ENOENT: no such file or directory, open '${failingPath}'`,
    });
    // Remote state is recorded (cursor moved past it) but the entry is not marked as
    // present locally, so its absence can never be propagated as a delete — even by a
    // scan that does not know about the failure.
    expect((await store.getRemoteStateById("fail"))?.revision).toBe(1);
    expect(await store.getLocalStateById("fail")).toBeNull();
    const reconcile = await createReconcile(store, adapter, () => true).reconcileOnce();
    expect(reconcile.filesQueuedForDelete).toBe(0);
    expect(await store.getDirtyEntryMutation("fail")).toBeNull();

    await store.close();
  });

  it("isolates a failing parent-folder mkdir to the files below it", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const adapter = createVaultAdapter();
    const failingAdapter = {
      ...adapter,
      async mkdir(path: string): Promise<void> {
        if (path === "Broken") {
          throw new Error("EPERM: operation not permitted, mkdir 'Broken'");
        }
        await adapter.mkdir(path);
      },
    };
    const events: PullDeviceIssueEvent[] = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 2,
          hasMore: false,
          commits: [
            await fileCommit({ cursor: 1, entryId: "under", path: "Broken/a.md", body: "a" }),
            await fileCommit({ cursor: 2, entryId: "good", path: "Fine/b.md", body: "b" }),
          ],
        },
      ],
    });

    const result = await createService({
      store,
      adapter: failingAdapter,
      blobs: await blobsFor([
        { entryId: "under", body: "a" },
        { entryId: "good", body: "b" },
      ]),
      events,
    }).pullOnce(session);

    expect(result.cursor).toBe(2);
    expect(adapter.text("Fine/b.md")).toBe("b");
    expect(events.filter((event) => event.kind === "write_failed")).toEqual([
      {
        kind: "write_failed",
        entryId: "under",
        path: "Broken/a.md",
        reason: "EPERM: operation not permitted, mkdir 'Broken'",
      },
    ]);
    expect(await store.getLocalStateById("under")).toBeNull();
    await store.close();
  });

  it("isolates a failing folder entry mkdir", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const adapter = createVaultAdapter();
    const failingAdapter = {
      ...adapter,
      async mkdir(path: string): Promise<void> {
        if (path === "Locked") {
          throw new Error("EPERM: mkdir 'Locked'");
        }
        await adapter.mkdir(path);
      },
    };
    const events: PullDeviceIssueEvent[] = [];
    const session = createRealtimeSession({
      pages: [
        {
          cursor: 1,
          hasMore: false,
          commits: [
            createCommit({
              cursor: 1,
              entryId: "folder",
              revision: 1,
              entryType: "folder",
              encryptedMetadata: await encryptFolderMetadata({
                entryId: "folder",
                revision: 1,
                path: "Locked",
              }),
            }),
          ],
        },
      ],
    });

    const result = await createService({
      store,
      adapter: failingAdapter,
      blobs: {},
      events,
      rules: { ...DEFAULT_SYNC_FILE_RULES, includeOtherFiles: true },
    }).pullOnce(session);

    expect(result.cursor).toBe(1);
    expect(events).toContainEqual({
      kind: "write_failed",
      entryId: "folder",
      path: "Locked",
      reason: "EPERM: mkdir 'Locked'",
    });
    const local = await store.getLocalStateById("folder");
    expect(local?.path ?? null).toBeNull();
    const reconcile = await createReconcile(store, adapter, () => true).reconcileOnce();
    expect(reconcile.filesQueuedForDelete).toBe(0);
    await store.close();
  });

  it("never touches the disk to delete or move away from an unwritable path", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const adapter = createVaultAdapter();
    const removed: string[] = [];
    const strictAdapter = {
      ...adapter,
      async exists(path: string): Promise<boolean> {
        if (path.includes("?")) throw new Error(`EINVAL: ${path}`);
        return await adapter.exists(path);
      },
      async remove(path: string): Promise<void> {
        removed.push(path);
        await adapter.remove(path);
      },
    };
    const events: PullDeviceIssueEvent[] = [];
    const blobs = await blobsFor([
      { entryId: "bad", body: "v1" },
      { entryId: "moved", body: "m" },
      { entryId: "moved", revision: 2, body: "m" },
    ]);

    await createService({ store, adapter: strictAdapter, blobs, policy: WINDOWS_POLICY, events })
      .pullOnce(
        createRealtimeSession({
          pages: [
            {
              cursor: 2,
              hasMore: false,
              commits: [
                await fileCommit({ cursor: 1, entryId: "bad", path: BAD_PATH, body: "v1" }),
                await fileCommit({ cursor: 2, entryId: "moved", path: "Q/what?.md", body: "m" }),
              ],
            },
          ],
        }),
      );

    // Remote deletes the bad entry and renames the other one to a valid path.
    const result = await createService({
      store,
      adapter: strictAdapter,
      blobs,
      policy: WINDOWS_POLICY,
      events,
    }).pullOnce(
      createRealtimeSession({
        pages: [
          {
            cursor: 4,
            hasMore: false,
            commits: [
              await fileCommit({ cursor: 3, entryId: "bad", revision: 2, path: BAD_PATH, body: "", deleted: true }),
              await fileCommit({ cursor: 4, entryId: "moved", revision: 2, path: "Q/what.md", body: "m" }),
            ],
          },
        ],
      }),
    );

    expect(result.cursor).toBe(4);
    expect(removed).toEqual([]);
    // Arriving later under a valid path, the same entry writes normally.
    expect(adapter.text("Q/what.md")).toBe("m");
    expect(events).toContainEqual({ kind: "resolved", entryId: "moved", path: "Q/what.md" });
    expect(events).toContainEqual({ kind: "resolved", entryId: "bad", path: BAD_PATH });
    await store.close();
  });

  it("keeps pulling when removing a stale local file fails", async () => {
    const store = await createInitializedTestSyncStore(createTestPlugin());
    const adapter = createVaultAdapter();
    const blobs = await blobsFor([{ entryId: "e", body: "x" }]);
    const events: PullDeviceIssueEvent[] = [];

    await createService({ store, adapter, blobs, events }).pullOnce(
      createRealtimeSession({
        pages: [
          {
            cursor: 1,
            hasMore: false,
            commits: [await fileCommit({ cursor: 1, entryId: "e", path: "a.md", body: "x" })],
          },
        ],
      }),
    );
    const lockedAdapter = {
      ...adapter,
      async remove(): Promise<void> {
        throw new Error("EBUSY: resource busy or locked");
      },
    };

    const result = await createService({ store, adapter: lockedAdapter, blobs, events }).pullOnce(
      createRealtimeSession({
        pages: [
          {
            cursor: 2,
            hasMore: false,
            commits: [
              await fileCommit({ cursor: 2, entryId: "e", revision: 2, path: "a.md", body: "", deleted: true }),
            ],
          },
        ],
      }),
    );

    expect(result.cursor).toBe(2);
    expect(await store.getCursor()).toBe(2);
    await store.close();
  });
});
