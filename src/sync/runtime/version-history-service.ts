import type { SyncCryptoService } from "../core/crypto-service";
import type {
  EntryVersion,
  EntryVersionPageCursor,
  SyncRealtimeSession,
} from "../remote/realtime-client";
import type {
  DeletedSyncEntryRow,
  SyncEntryRow,
} from "../store/store";
import type {
  SyncEntryStore,
  SyncMutationStore,
} from "../store/ports";

const VERSION_RESTORE_PAGE_SIZE = 25;

export interface SyncVersionHistoryServiceDeps {
  getStore: () => SyncVersionHistoryStore;
  crypto: SyncCryptoService;
  withRealtimeSession: <T>(
    work: (session: SyncRealtimeSession) => Promise<T>,
  ) => Promise<T>;
  runLocalMutationWork: <T>(work: () => Promise<T>) => Promise<T>;
  pullOnce: (session: SyncRealtimeSession) => Promise<void>;
}

export interface SyncVersionHistoryStore
  extends Pick<
      SyncEntryStore,
      "getEntryById" | "getEntryByPath" | "listDeletedEntries"
    >,
    Pick<SyncMutationStore, "getDirtyEntryMutation"> {}

export class SyncVersionHistoryService {
  constructor(private readonly deps: SyncVersionHistoryServiceDeps) {}

  async listEntryVersionsForPath(
    path: string,
    before: EntryVersionPageCursor | null,
    limit: number,
  ): Promise<SyncEntryVersionsPage | null> {
    const store = this.deps.getStore();
    const entry = await store.getEntryByPath(path);
    if (!entry || entry.deleted || entry.revision <= 0) {
      return null;
    }

    return await this.deps.withRealtimeSession(async (session) => {
      const page = await session.listEntryVersions({
        entryId: entry.entryId,
        before,
        limit,
      });
      const dirty = await store.getDirtyEntryMutation(entry.entryId);
      return {
        path,
        entryId: entry.entryId,
        dirty: dirty !== null,
        versions: page.versions,
        hasMore: page.hasMore,
        nextBefore: page.nextBefore,
      };
    });
  }

  async restoreEntryVersionForPath(
    path: string,
    version: EntryVersion,
  ): Promise<void> {
    await this.deps.runLocalMutationWork(async () => {
      const store = this.deps.getStore();
      const entry = await store.getEntryByPath(path);
      if (!entry || entry.deleted) {
        throw new Error("The active file is not synced.");
      }
      const dirty = await store.getDirtyEntryMutation(entry.entryId);
      if (dirty) {
        throw new Error("Sync local changes before restoring version history.");
      }

      await this.restoreEntryVersion(store, entry, version);
    });
  }

  async listDeletedEntries(): Promise<DeletedSyncEntryRow[]> {
    return await this.deps.getStore().listDeletedEntries();
  }

  async restoreDeletedEntry(entryId: string): Promise<void> {
    await this.deps.runLocalMutationWork(async () => {
      const store = this.deps.getStore();
      const entry = await store.getEntryById(entryId);
      if (!entry || !entry.deleted || entry.revision <= 0) {
        throw new Error("Deleted file is not synced.");
      }
      const dirty = await store.getDirtyEntryMutation(entry.entryId);
      if (dirty) {
        throw new Error("Sync local changes before restoring this deleted file.");
      }

      const version = await this.findLatestRestorableEntryVersion(entry.entryId);
      if (!version) {
        throw new Error("No restorable version exists for this deleted file.");
      }

      await this.restoreEntryVersion(store, entry, version);
    });
  }

  private async findLatestRestorableEntryVersion(
    entryId: string,
  ): Promise<EntryVersion | null> {
    let before: EntryVersionPageCursor | null = null;

    return await this.deps.withRealtimeSession(async (session) => {
      do {
        const page = await session.listEntryVersions({
          entryId,
          before,
          limit: VERSION_RESTORE_PAGE_SIZE,
        });
        const version = page.versions.find(
          (candidate) => candidate.op === "upsert" && candidate.blobId,
        );
        if (version) {
          return version;
        }
        before = page.nextBefore;
      } while (before);

      return null;
    });
  }

  private async restoreEntryVersion(
    store: SyncVersionHistoryStore,
    entry: SyncEntryRow,
    version: EntryVersion,
  ): Promise<void> {
    const metadata = await this.deps.crypto.decryptMetadata(
      version.encryptedMetadata,
      {
        entryId: entry.entryId,
        revision: version.sourceRevision,
        op: version.op,
        blobId: version.blobId,
      },
    );
    const encryptedMetadata = await this.deps.crypto.encryptMetadata(
      metadata,
      {
        entryId: entry.entryId,
        revision: entry.revision + 1,
        op: version.op,
        blobId: version.blobId,
      },
    );

    await this.deps.withRealtimeSession(async (session) => {
      await session.restoreEntryVersion({
        entryId: entry.entryId,
        versionId: version.versionId,
        baseRevision: entry.revision,
        op: version.op,
        blobId: version.blobId,
        encryptedMetadata,
      });
      await this.deps.pullOnce(session);
    });
  }
}

export interface SyncEntryVersionsPage {
  path: string;
  entryId: string;
  dirty: boolean;
  versions: EntryVersion[];
  hasMore: boolean;
  nextBefore: EntryVersionPageCursor | null;
}
