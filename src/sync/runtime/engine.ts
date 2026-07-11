import type { Plugin } from "obsidian";

import { hashBytes } from "../core/content";
import { SyncAutoLoop } from "../engine/auto-sync";
import type { SyncTokenResponse } from "../remote/client";
import { SyncEventGate } from "../engine/event-gate";
import { SyncEventRecorder } from "../engine/event-recorder";
import type { SyncFileRules } from "../core/file-rules";
import {
  type ReconcileOnceResult,
  SyncLocalReconcileService,
} from "../engine/local-reconcile-service";
import { ObsidianSyncVaultAdapter } from "../vault/obsidian-vault-adapter";
import { SyncErrorEscalator } from "./sync-error-escalator";
import { SyncPullService } from "../engine/pull-service";
import { SyncPushService } from "../engine/push-service";
import { SyncHttpClient } from "../remote/http-client";
import { SyncBlobClient } from "../remote/blob-client";
import { SyncPullClient } from "../remote/pull-client";
import type { SyncCryptoService } from "../core/crypto-service";
import { metadataContextFromRemoteState } from "../engine/pull-entry-state-internal";
import {
  type EntryVersion,
  type EntryVersionPageCursor,
  type SyncRealtimeSession,
  type SyncStorageStatus,
} from "../remote/realtime-client";
import type { DeletedSyncEntryRow, SyncStore } from "../store/store";
import type { SyncStoreCorruptionListener } from "../store/ports";
import { cleanupOrphanSyncStores } from "../store/dexie/database";
import { readOwnedLocalVaultIds } from "../store/dexie/local-vault";
import { findExcludedRemoteEntries } from "../engine/purge-excluded";
import { queueLocalDeleteMutation } from "../core/mutation-queue";
import {
  getOrCreateStoredLocalVaultId,
  readStoredSyncConnection,
  writeStoredSyncConnection,
} from "../store/connection";
import type { UserVisibleSyncState } from "./user-visible-status";
import type { UserVisibleSyncProgress } from "./user-visible-status";
import { SyncVaultEventHandler } from "./vault-event-handler";
import {
  SyncVersionHistoryService,
  type SyncEntryVersionsPage,
} from "./version-history-service";

type SyncActivityKind = "push" | "pull" | "local";

interface ActiveSyncActivity {
  id: number;
  kind: SyncActivityKind;
  done: Promise<void>;
  settle: () => void;
}

export interface SyncEngineDeps {
  plugin: Plugin;
  getApiBaseUrl: () => string;
  getSyncToken: () => Promise<SyncTokenResponse>;
  invalidateSyncToken: () => void;
  crypto: SyncCryptoService;
  getSyncFileRules: () => SyncFileRules;
  hasActiveRemoteVaultSession: () => boolean;
  notify: (message: string, timeout?: number) => void;
  notifyError: (error: unknown, prefix: string) => void;
  notifySyncConflict: (event: {
    entryId?: string;
    op: "upsert" | "delete";
    reason?:
      | "local_pending_mutation"
      | "local_pending_mutation_wins"
      | "remote_path_collision"
      | "remote_path_collision_client_wins";
    originalPath: string;
    conflictPath: string | null;
  }) => void;
  setSyncProgress: (progress: UserVisibleSyncProgress | null) => void;
  setSyncStatus: (status: UserVisibleSyncState) => void;
  setStorageStatus: (status: SyncStorageStatus | null) => void;
}

export class SyncEngine {
  private syncStore: SyncStore | null = null;
  private corruptionListener: SyncStoreCorruptionListener | null = null;
  private actionableAttention = false;
  private readonly syncErrorEscalator = new SyncErrorEscalator();
  private lastActionableMessage: string | null = null;
  private localMutationQueue: Promise<void> = Promise.resolve();
  private activeSyncActivities: ActiveSyncActivity[] = [];
  private nextSyncActivityId = 1;
  private readonly syncEventGate = new SyncEventGate((path) =>
    this.syncVaultEventHandler.replayPath(path),
  );
  private readonly vaultAdapter = new ObsidianSyncVaultAdapter(
    this.deps.plugin,
    () => this.deps.getSyncFileRules(),
  );
  private readonly syncEventRecorder = new SyncEventRecorder({
    getSyncStore: () => this.syncStore,
    crypto: this.deps.crypto,
    eventGate: this.syncEventGate,
  });
  private readonly syncHttpClient = new SyncHttpClient({
    getApiBaseUrl: () => this.deps.getApiBaseUrl(),
    getSyncToken: async () => await this.deps.getSyncToken(),
    invalidateSyncToken: () => this.deps.invalidateSyncToken(),
  });
  private readonly syncPushService = new SyncPushService({
    getApiBaseUrl: () => this.deps.getApiBaseUrl(),
    getSyncToken: async () => await this.deps.getSyncToken(),
    getSyncStore: () => this.syncStore,
    crypto: this.deps.crypto,
    fileReader: this.vaultAdapter,
    conflictFileWriter: this.vaultAdapter,
    blobClient: new SyncBlobClient(this.syncHttpClient),
    onProgress: async (progress) => {
      this.reportActivityProgress(progress);
    },
    onConflict: (event) => this.deps.notifySyncConflict(event),
  });
  private readonly syncLocalReconcileService = new SyncLocalReconcileService({
    getSyncStore: () => this.syncStore,
    crypto: this.deps.crypto,
    shouldSyncPath: (path) => this.vaultAdapter.isSyncablePath(path),
    scanner: this.vaultAdapter,
  });
  private readonly syncAutoLoop = new SyncAutoLoop({
    getApiBaseUrl: () => this.deps.getApiBaseUrl(),
    getSyncToken: async () => await this.deps.getSyncToken(),
    getSyncStore: () => this.syncStore,
    pushPendingMutations: async (session) =>
      await this.withSyncActivity("push", async () => {
        return await this.syncPushService.pushPendingMutations(session);
      }),
    pullOnce: async (session) =>
      await this.withSyncActivity("pull", async () => {
        return await this.syncPullService.pullOnce(session);
      }),
    onConnectionStateChange: (state) => {
      if (state === "reconnecting") {
        // Keep an actionable attention state visible while the loop quietly
        // retries; only show the neutral "reconnecting" status otherwise.
        if (!this.actionableAttention) {
          this.deps.setSyncStatus("reconnecting");
        }
        return;
      }

      if (state === "connecting") {
        this.deps.setSyncStatus("syncing");
      }
    },
    onStorageStatusChange: (status) => {
      this.deps.setStorageStatus(status);
    },
    onSyncScheduled: () => {
      this.clearActionableAttention();
      this.deps.setSyncStatus("syncing");
    },
    onIdle: () => {
      this.clearActionableAttention();
      this.deps.setSyncStatus("up_to_date");
    },
    onError: (error) => {
      const decision = this.syncErrorEscalator.recordError(error);
      if (!decision.escalate) {
        // Below the repeat threshold: likely a transient network blip. Keep retrying
        // quietly, but log so a persistent failure leaves a trail before it escalates.
        console.error("[osync] sync error (retrying)", error);
        return;
      }

      console.error("[osync] sync error (escalated)", error);
      this.actionableAttention = true;
      this.deps.setSyncStatus("attention_needed");
      const message = decision.message;
      if (message !== this.lastActionableMessage) {
        this.lastActionableMessage = message;
        this.deps.notify(message);
      }
    },
  });
  private readonly syncVaultEventHandler = new SyncVaultEventHandler({
    plugin: this.deps.plugin,
    vaultAdapter: this.vaultAdapter,
    eventRecorder: this.syncEventRecorder,
    autoLoop: this.syncAutoLoop,
    runLocalMutationWork: async (work) => await this.runLocalMutationWork(work),
    hasActiveRemoteVaultSession: () => this.deps.hasActiveRemoteVaultSession(),
    onError: (error) => {
      this.deps.setSyncStatus("attention_needed");
      this.deps.notifyError(error, "Sync event handling failed");
    },
    onDeleteBurst: () => {
      // Many files deleted at once while Obsidian is open (script/tool). Pause pushing
      // those deletions and alert so the user can restore from server if unintended.
      this.syncAutoLoop.pause();
      this.deps.setSyncStatus("attention_needed");
      this.deps.notify(
        "Osync: 대량 삭제가 감지되어 동기화를 일시정지했습니다. 의도한 삭제면 동기화를 재개하고, 아니면 서버에서 복원하세요.",
      );
    },
  });
  private readonly syncPullClient = new SyncPullClient(this.syncHttpClient);
  private readonly syncPullService = new SyncPullService({
    getApiBaseUrl: () => this.deps.getApiBaseUrl(),
    getSyncToken: async () => await this.deps.getSyncToken(),
    getSyncStore: () => this.syncStore,
    crypto: this.deps.crypto,
    eventGate: this.syncEventGate,
    vaultAdapter: this.vaultAdapter,
    pullClient: this.syncPullClient,
    getSyncFileRules: () => this.deps.getSyncFileRules(),
    onProgress: async (progress) => {
      this.reportActivityProgress(progress);
    },
    onConflict: (event) => this.deps.notifySyncConflict(event),
    isInitialDownloadSync: async () => {
      if (!this.syncStore) return false;
      const conn = await readStoredSyncConnection(this.syncStore);
      return conn?.initialSyncMode === "download" && conn?.initialSyncComplete !== true;
    },
    onInitialPullComplete: async () => {
      if (!this.syncStore) return;
      const conn = await readStoredSyncConnection(this.syncStore);
      if (!conn) return;
      await writeStoredSyncConnection(this.syncStore, {
        ...conn,
        initialSyncComplete: true,
      });
    },
  });
  private readonly syncVersionHistoryService = new SyncVersionHistoryService({
    getStore: () => this.requireStore(),
    crypto: this.deps.crypto,
    withRealtimeSession: async (work) => await this.withRealtimeSession(work),
    runLocalMutationWork: async (work) => await this.runLocalMutationWork(work),
    pullOnce: async (session) => {
      await this.withSyncActivity("pull", async () => {
        await this.syncPullService.pullOnce(session);
      });
    },
  });
  constructor(private readonly deps: SyncEngineDeps) {}

  setStore(store: SyncStore): void {
    this.syncStore = store;
    this.syncStore.setCorruptionListener(this.corruptionListener);
    this.cleanupOrphanStoresInBackground(store);
  }

  private cleanupOrphanStoresInBackground(store: SyncStore): void {
    void store
      .readLocalVaultId()
      .then(async (localVaultId) => {
        if (!localVaultId) return;
        const owned = readOwnedLocalVaultIds(this.deps.plugin);
        const result = await cleanupOrphanSyncStores(localVaultId, owned);
        if (result.deleted.length > 0) {
          console.info(
            `[osync:orphan-cleanup] removed ${result.deleted.length} orphan sync store(s)`,
          );
        }
        if (result.failed.length > 0) {
          console.warn(
            `[osync:orphan-cleanup] failed to remove ${result.failed.length} store(s)`,
          );
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[osync:orphan-cleanup] error during cleanup: ${message}`);
      });
  }

  setStoreCorruptionListener(listener: SyncStoreCorruptionListener | null): void {
    this.corruptionListener = listener;
    this.syncStore?.setCorruptionListener(listener);
  }

  hasStore(): boolean {
    return this.syncStore !== null;
  }

  getStoreOrNull(): SyncStore | null {
    return this.syncStore;
  }

  detachStore(): SyncStore | null {
    const store = this.syncStore;
    this.syncStore = null;
    return store;
  }

  async closeStore(): Promise<void> {
    const store = this.detachStore();
    await store?.close();
  }

  async readLocalVaultId(): Promise<string> {
    return (await readStoredSyncConnection(this.requireStore()))?.localVaultId ?? "";
  }

  async getOrCreateLocalVaultId(
    remoteVaultId: string,
    initialSyncMode?: "download" | "merge",
  ): Promise<string> {
    return await getOrCreateStoredLocalVaultId(
      this.requireStore(),
      remoteVaultId,
      initialSyncMode,
    );
  }

  startAutoSync(): Promise<boolean> {
    return this.syncAutoLoop.start();
  }

  stopAutoSync(): void {
    this.syncAutoLoop.stop();
  }

  pauseAutoSync(): void {
    this.syncAutoLoop.pause();
  }

  resumeAutoSyncFromPause(): void {
    this.syncAutoLoop.resume();
  }

  reconnectAutoSync(): void {
    this.syncAutoLoop.reconnectNow();
  }

  async resumeAutoSyncConnection(): Promise<void> {
    await this.syncAutoLoop.resumeConnection();
  }

  registerVaultEvents(): void {
    this.syncVaultEventHandler.register();
  }

  notifyLocalChange(): void {
    this.syncAutoLoop.notifyLocalChange();
  }

  setStorageStatusWatching(enabled: boolean): void {
    this.syncAutoLoop.setStorageStatusWatching(enabled);
  }

  getMaxFileSizeBytes(): number {
    return this.syncAutoLoop.getMaxFileSizeBytes();
  }

  async reconcileOnce(options?: {
    allowMassDelete?: boolean;
  }): Promise<ReconcileOnceResult> {
    return await this.runLocalMutationWork(async () => {
      return await this.syncLocalReconcileService.reconcileOnce(options);
    });
  }

  async isInitialPullRequired(): Promise<boolean> {
    const store = this.syncStore;
    if (!store) return false;
    const conn = await readStoredSyncConnection(store);
    if (conn?.initialSyncMode === "download" && conn.initialSyncComplete !== true) {
      return true;
    }
    return (await store.countLocalStates()) === 0;
  }

  async runInitialPullIfRequired(): Promise<void> {
    if (!(await this.isInitialPullRequired())) return;
    await this.withRealtimeSession(async (session) => {
      await this.withSyncActivity("pull", async () => {
        await this.syncPullService.pullOnce(session);
      });
    });
  }

  async cacheCollisionBytes(
    paths: ReadonlyArray<string>,
  ): Promise<Map<string, { bytes: Uint8Array; mtime: number; size: number }>> {
    const result = new Map<
      string,
      { bytes: Uint8Array; mtime: number; size: number }
    >();
    if (paths.length === 0) return result;
    const localFiles = await this.vaultAdapter.listFiles();
    const byPath = new Map(localFiles.map((file) => [file.path, file]));
    for (const path of paths) {
      const local = byPath.get(path);
      if (!local) continue;
      result.set(path, {
        bytes: await local.readBytes(),
        mtime: local.mtime,
        size: local.size,
      });
    }
    return result;
  }

  async writeBackLocalCollision(
    path: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const adapter = this.deps.plugin.app.vault.adapter;
    if (await adapter.exists(path)) {
      await adapter.writeBinary(path, bytes.buffer instanceof ArrayBuffer ? bytes.buffer : bytes.slice().buffer);
    } else {
      const parts = path.split("/").slice(0, -1);
      let current = "";
      for (const part of parts) {
        if (!part) continue;
        current = current ? `${current}/${part}` : part;
        if (!(await adapter.exists(current))) {
          await adapter.mkdir(current);
        }
      }
      await adapter.writeBinary(path, bytes.buffer instanceof ArrayBuffer ? bytes.buffer : bytes.slice().buffer);
    }
  }

  async previewInitialCollisions(): Promise<InitialCollisionPreview[]> {
    const localFiles = await this.vaultAdapter.listFiles();
    const localByPath = new Map(localFiles.map((file) => [file.path, file]));
    if (localByPath.size === 0) {
      return [];
    }

    return await this.withRealtimeSession(async (session) => {
      const collisions: InitialCollisionPreview[] = [];
      let after: { updatedSeq: number; entryId: string } | null = null;
      let hasMore = true;
      while (hasMore) {
        const page = await session.listEntryStates({
          sinceCursor: 0,
          targetCursor: null,
          after,
          limit: 100,
        });
        for (const state of page.entries) {
          if (state.deleted || state.entryType === "folder" || !state.blobId) {
            continue;
          }
          let metadata;
          try {
            metadata = await this.deps.crypto.decryptMetadata(
              state.encryptedMetadata,
              metadataContextFromRemoteState(state),
            );
          } catch {
            continue;
          }
          const local = localByPath.get(metadata.path);
          if (!local || !metadata.hash) continue;
          const localHash = await hashBytes(await local.readBytes());
          if (localHash === metadata.hash) continue;
          collisions.push({
            path: metadata.path,
            localHash,
            localMtime: local.mtime,
            localSize: local.size,
            remoteHash: metadata.hash,
            remoteUpdatedAt: state.updatedAt,
            remoteEditedAt: metadata.editedAt,
            remoteEntryId: state.entryId,
          });
        }
        hasMore = page.hasMore;
        after = page.nextAfter;
      }
      return collisions;
    });
  }

  async refreshSyncProgress(): Promise<void> {
    const store = this.syncStore;
    if (!store) {
      this.reportBaselineProgress({
        completedEntries: 0,
        totalEntries: 0,
      });
      return;
    }

    this.reportBaselineProgress(await store.countSyncProgress());
  }

  async hasPendingMutations(): Promise<boolean> {
    const pending = await this.syncStore?.listDirtyEntries(1);
    return (pending?.length ?? 0) > 0;
  }

  async wipeLocalEntriesForRestore(): Promise<void> {
    const store = this.requireStore();
    for (const local of await store.listLocalStates()) {
      await store.clearLocalState(local.entryId);
    }
    for (const pending of await store.listDirtyEntries(10_000)) {
      await store.clearDirtyEntryByMutationId(pending.mutationId);
    }
    await store.setCursor(0);
    const conn = await readStoredSyncConnection(store);
    if (conn) {
      await writeStoredSyncConnection(store, {
        ...conn,
        lastPulledCursor: 0,
        initialSyncMode: "download",
        initialSyncComplete: false,
      });
    }
    await store.flush();
  }

  async listEntryVersionsForPath(
    path: string,
    before: EntryVersionPageCursor | null,
    limit: number,
  ): Promise<SyncEngineEntryVersionsPage | null> {
    return await this.syncVersionHistoryService.listEntryVersionsForPath(
      path,
      before,
      limit,
    );
  }

  async restoreEntryVersionForPath(
    path: string,
    version: EntryVersion,
  ): Promise<void> {
    await this.syncVersionHistoryService.restoreEntryVersionForPath(path, version);
  }

  async listDeletedEntries(): Promise<DeletedSyncEntryRow[]> {
    return await this.syncVersionHistoryService.listDeletedEntries();
  }

  async restoreDeletedEntry(entryId: string): Promise<void> {
    await this.syncVersionHistoryService.restoreDeletedEntry(entryId);
  }

  async downloadAndDecryptVersionBlob(blobId: string): Promise<Uint8Array> {
    const token = await this.deps.getSyncToken();
    const encrypted = await this.syncPullClient.downloadBlob(
      this.deps.getApiBaseUrl(),
      token.token,
      token.vaultId,
      blobId,
    );
    return this.deps.crypto.decryptBlob(encrypted, { blobId });
  }

  async waitForLocalMutationWork(): Promise<void> {
    await this.localMutationQueue;
  }

  private async withRealtimeSession<T>(
    work: (session: SyncRealtimeSession) => Promise<T>,
  ): Promise<T> {
    return await this.syncAutoLoop.withRealtimeSession(work);
  }

  private runLocalMutationWork<T>(work: () => Promise<T>): Promise<T> {
    const run = this.localMutationQueue.then(
      () => this.withSyncActivity("local", work),
      () => this.withSyncActivity("local", work),
    );
    this.localMutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async withSyncActivity<T>(
    kind: SyncActivityKind,
    work: () => Promise<T>,
  ): Promise<T> {
    const activity = this.beginSyncActivity(kind);
    try {
      return await work();
    } finally {
      await this.finishSyncActivity(activity);
    }
  }

  private beginSyncActivity(kind: SyncActivityKind): ActiveSyncActivity {
    let settle: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const activity: ActiveSyncActivity = {
      id: this.nextSyncActivityId,
      kind,
      done,
      settle,
    };
    this.nextSyncActivityId += 1;
    this.activeSyncActivities.push(activity);
    return activity;
  }

  private async finishSyncActivity(activity: ActiveSyncActivity): Promise<void> {
    this.activeSyncActivities = this.activeSyncActivities.filter(
      (activeActivity) => activeActivity.id !== activity.id,
    );
    activity.settle();
    await this.refreshSyncProgress();
  }

  // Count the server-side zombie entries a purge would remove (for a dry-run preview).
  async countExcludedRemoteEntries(): Promise<number> {
    const store = this.requireStore();
    return findExcludedRemoteEntries(
      await store.listRemoteStates(),
      this.deps.getSyncFileRules(),
    ).length;
  }

  // Queue delete mutations for live remote entries whose path this device's rules exclude
  // (folders the event handler never propagated a local delete for). The next push
  // tombstones them on the server, ending the re-download churn. Returns how many.
  async purgeExcludedRemoteEntries(): Promise<number> {
    const store = this.requireStore();
    const targets = findExcludedRemoteEntries(
      await store.listRemoteStates(),
      this.deps.getSyncFileRules(),
    );
    for (const target of targets) {
      await this.runLocalMutationWork(async () => {
        await queueLocalDeleteMutation(store, {
          crypto: this.deps.crypto,
          entryId: target.entryId,
          base: target,
          path: target.path as string,
          entryType: target.entryType,
          editedAt: Date.now(),
        });
        await store.applyLocalState({
          entryId: target.entryId,
          path: null,
          blobId: null,
          hash: null,
          entryType: target.entryType,
          deleted: true,
          updatedAt: Date.now(),
          localMtime: null,
          localSize: null,
        });
      });
    }
    await store.flush();
    if (targets.length > 0) {
      this.syncAutoLoop.notifyLocalChange();
    }
    return targets.length;
  }

  // Wait for any in-flight pull/push and queued local work to settle. Callers that are
  // about to detach/close/delete the store (reset, restore) must await this first, or an
  // in-flight pullOnce keeps writing to a store being torn down underneath it.
  async drainInFlightSync(): Promise<void> {
    await this.waitForLocalMutationWork();
    const pending = this.activeSyncActivities
      .filter((activity) => activity.kind !== "local")
      .map((activity) => activity.done);
    await Promise.allSettled(pending);
  }

  private reportActivityProgress(progress: UserVisibleSyncProgress): void {
    if (!this.hasActiveRemoteActivity()) {
      return;
    }

    this.deps.setSyncProgress(progress);
  }

  private reportBaselineProgress(progress: UserVisibleSyncProgress): void {
    if (this.activeSyncActivities.length === 0) {
      this.deps.setSyncProgress(progress);
    }
  }

  private hasActiveRemoteActivity(): boolean {
    return this.activeSyncActivities.some((activity) => activity.kind !== "local");
  }

  private clearActionableAttention(): void {
    this.actionableAttention = false;
    this.lastActionableMessage = null;
    this.syncErrorEscalator.recordSuccess();
  }

  private requireStore(): SyncStore {
    if (!this.syncStore) {
      throw new Error("Local sync store is not initialized.");
    }

    return this.syncStore;
  }
}

export type SyncEngineEntryVersionsPage = SyncEntryVersionsPage;

export interface InitialCollisionPreview {
  path: string;
  localHash: string;
  localMtime: number;
  localSize: number;
  remoteHash: string;
  remoteUpdatedAt: number;
  remoteEditedAt: number | undefined;
  remoteEntryId: string;
}
