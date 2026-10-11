import { Platform, type Plugin } from "obsidian";

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
import { type BlockedMutationEvent, SyncPushService } from "../engine/push-service";
import { StaleEntryResolver } from "../engine/stale-entry-resolver";
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
import type {
  DeletedSyncEntryRow,
  PendingMutationBlockedReason,
  SyncStore,
} from "../store/store";
import { tryDecryptPendingMetadata } from "../engine/undecryptable-pending";
import type { SyncStoreCorruptionListener } from "../store/ports";
import {
  createDetachableSyncStore,
  type DetachableSyncStore,
  isSyncStoreDetachedError,
} from "../store/detachable-store";
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
import { DeviceSyncIssues } from "./device-sync-issues";
import type { PullDeviceIssueEvent } from "../engine/pull-entry-state-applier";
import { writeVaultBytes } from "../vault/vault-writer";
import {
  describeActivityError,
  type SyncActivityKind as SyncActivityLogKind,
} from "./activity-log";
import type { PullOnceResult } from "../engine/pull-service";
import type { PushPendingMutationsResult } from "../engine/push-service";
import {
  SyncVersionHistoryService,
  type SyncEntryVersionsPage,
} from "./version-history-service";
import { RemoteVaultKeyMismatchError } from "../../remote-vault/types";
import {
  commitUnreadableRemovals,
  detachLocalEntries,
  scanUnreadableRemoteEntries,
  type UnreadableRemoteEntry,
  type UnreadableRemovalResult,
  type UnreadableScanResult,
} from "../engine/unreadable-entries";

type SyncActivityKind = "push" | "pull" | "local";

type SyncConflictEvent = Parameters<SyncEngineDeps["notifySyncConflict"]>[0];

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
  // Diagnostics trail (see activity-log.ts). Optional so tests can omit it.
  recordActivity?: (kind: SyncActivityLogKind, message: string) => void;
  // Paths this device cannot hold + portability warnings. Defaults to an in-memory
  // tracker for the current platform.
  deviceSyncIssues?: DeviceSyncIssues;
  // The server refused this device's vault key (it is another vault's key). Auto sync
  // is already stopped; the caller must have the user re-enter the vault password.
  onVaultKeyMismatch?: () => void;
}

// More new portability warnings than this in one go collapse into a single Notice.
const MAX_INDIVIDUAL_PORTABILITY_NOTICES = 3;

export class SyncEngine {
  // Services only ever see the detachable handle (see detachable-store.ts).
  private syncStore: SyncStore | null = null;
  private storeHandle: DetachableSyncStore | null = null;
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
  private readonly deviceSyncIssues =
    this.deps.deviceSyncIssues ?? new DeviceSyncIssues({ platform: { isWin: Platform.isWin } });
  // Device issues first seen during the pull in progress (one Notice per pull).
  private newDeviceIssuesThisPull = 0;
  // Undecryptable entries first seen during the pull in progress (one log line per pull).
  private newUnreadableThisPull = 0;
  // Queued local changes dropped because this key cannot decrypt them, and entries
  // forgotten so their files upload as new entries, not yet followed by the re-scan
  // that queues those files again.
  private readonly pendingRescan = { dropped: 0, detached: 0, queued: false };
  private readonly vaultAdapter = new ObsidianSyncVaultAdapter(
    this.deps.plugin,
    () => this.deps.getSyncFileRules(),
    () => this.deviceSyncIssues,
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
    onConflict: (event) => this.handleSyncConflict(event),
    onUndecryptablePendingDropped: () => this.noteUndecryptablePendingDropped(),
    staleEntryResolver: new StaleEntryResolver({
      crypto: this.deps.crypto,
      applyRemoteEntryStates: async (states) => {
        await this.syncPullService.applyRemoteEntryStates(states);
      },
      onEntriesDetached: (entryIds) => this.noteEntriesDetached(entryIds),
    }),
    onMutationBlocked: (event) => this.handleMutationBlocked(event),
  });
  private readonly syncLocalReconcileService = new SyncLocalReconcileService({
    getSyncStore: () => this.syncStore,
    crypto: this.deps.crypto,
    shouldSyncPath: (path) => this.vaultAdapter.isSyncablePath(path),
    scanner: this.vaultAdapter,
    onLocalFilesScanned: (paths) => this.notePortability(paths, { complete: true }),
    onUndecryptablePendingDropped: () => this.noteUndecryptablePendingDropped(),
  });
  private readonly syncAutoLoop = new SyncAutoLoop({
    getApiBaseUrl: () => this.deps.getApiBaseUrl(),
    getSyncToken: async () => await this.deps.getSyncToken(),
    getSyncStore: () => this.syncStore,
    pushPendingMutations: async (session) =>
      await this.withSyncActivity("push", async () => {
        const result = await this.syncPushService.pushPendingMutations(session);
        this.recordPushResult(result);
        return result;
      }),
    pullOnce: async (session) => await this.pullWithActivity(session),
    onActivity: (kind, message) => this.recordActivity(kind, message),
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
    onVerificationStarted: () => {
      // Leave an escalated failure visible; it clears once the catch-up succeeds.
      if (!this.actionableAttention) {
        this.deps.setSyncStatus("checking");
      }
    },
    onIdle: () => {
      this.clearActionableAttention();
      this.deps.setSyncStatus("up_to_date");
    },
    onError: (error) => {
      if (isSyncStoreDetachedError(error)) {
        // Work that outlived a reset or disconnect: not a sync failure.
        console.info("[osync] sync step stopped: local store detached");
        return;
      }
      const decision = this.syncErrorEscalator.recordError(error);
      if (!decision.escalate) {
        // Below the repeat threshold: likely a transient network blip. Keep retrying
        // quietly, but log so a persistent failure leaves a trail before it escalates.
        console.error("[osync] sync error (retrying)", error);
        this.recordActivity("error", `Error (retrying): ${describeActivityError(error)}`);
        return;
      }

      console.error("[osync] sync error (escalated)", error);
      this.recordActivity("error", `Error (escalated): ${describeActivityError(error)}`);
      this.actionableAttention = true;
      if (error instanceof RemoteVaultKeyMismatchError) {
        // Retrying can never succeed and must not run with this key: stop until the
        // user re-enters the vault password.
        this.syncAutoLoop.stop();
      }
      this.deps.setSyncStatus("attention_needed");
      const message = decision.message;
      if (message !== this.lastActionableMessage) {
        this.lastActionableMessage = message;
        this.deps.notify(message);
      }
      if (error instanceof RemoteVaultKeyMismatchError) {
        this.deps.onVaultKeyMismatch?.();
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
      this.recordActivity(
        "error",
        `Sync event handling failed: ${describeActivityError(error)}`,
      );
      this.deps.setSyncStatus("attention_needed");
      this.deps.notifyError(error, "Sync event handling failed");
    },
    onDeleteBurst: () => {
      this.recordActivity("error", "Paused: many files deleted at once");
      // Many files deleted at once while Obsidian is open (script/tool). Pause pushing
      // those deletions and alert so the user can restore from server if unintended.
      this.syncAutoLoop.pause();
      this.deps.setSyncStatus("attention_needed");
      this.deps.notify(
        "Osync: 대량 삭제가 감지되어 동기화를 일시정지했습니다. 의도한 삭제면 동기화를 재개하고, 아니면 서버에서 복원하세요.",
      );
    },
    onLocalPathSeen: (path) => this.notePortability([path]),
    onLocalPathGone: (path) => this.deviceSyncIssues.forgetLocalPath(path),
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
    getDevicePathPolicy: () => this.deviceSyncIssues,
    onDeviceIssue: (event) => this.handleDeviceIssue(event),
    onDecryptFailure: (entryId) => this.handleDecryptFailure(entryId),
    onEntryDecrypted: (entryId) => this.deviceSyncIssues.forgetUnreadableEntry(entryId),
    onUndecryptablePendingDropped: () => this.noteUndecryptablePendingDropped(),
    onProgress: async (progress) => {
      this.reportActivityProgress(progress);
    },
    onConflict: (event) => this.handleSyncConflict(event),
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
      await this.pullWithActivity(session);
    },
  });
  constructor(private readonly deps: SyncEngineDeps) {}

  setStore(store: SyncStore): void {
    this.storeHandle?.detach();
    this.storeHandle = createDetachableSyncStore(store);
    this.syncStore = this.storeHandle.store;
    this.syncStore.setCorruptionListener(this.corruptionListener);
    this.cleanupOrphanStoresInBackground(this.syncStore);
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

  // Hands back the underlying store for closing. Every handle given out before keeps
  // failing with SyncStoreDetachedError from now on, so work still running against it
  // cannot touch a store that is being closed or deleted.
  detachStore(): SyncStore | null {
    const handle = this.storeHandle;
    this.storeHandle = null;
    this.syncStore = null;
    return handle?.detach() ?? null;
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

  // Stops auto sync and waits until nothing started before is still running: the
  // loop's drain and connect, pushes, pulls, scans and queued local work. Callers
  // that tear down the store (reset, disconnect) await this first.
  async stopAutoSyncAndWait(): Promise<void> {
    await this.syncAutoLoop.stopAndWait();
    await this.drainInFlightSync();
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

  isAutoSyncStarted(): boolean {
    return this.syncAutoLoop.isStarted();
  }

  // Push queued local mutations now, skipping the debounce. Waits for vault events
  // still being recorded so their mutations are part of the push.
  async flushPendingPush(): Promise<void> {
    await this.waitForLocalMutationWork();
    await this.syncAutoLoop.flushPendingPush();
  }

  recordActivity(kind: SyncActivityLogKind, message: string): void {
    try {
      this.deps.recordActivity?.(kind, message);
    } catch {
      // Diagnostics must never break sync.
    }
  }

  getLastVerifiedAt(): number | null {
    return this.syncAutoLoop.getLastVerifiedAt();
  }

  // Entry point for other confirmations that we are caught up with the server
  // (e.g. a heartbeat ack whose cursor is not ahead of ours).
  markVerified(): void {
    this.syncAutoLoop.markVerified();
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
      await this.pullWithActivity(session);
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

  async countPendingMutations(): Promise<number> {
    const pending = await this.syncStore?.listDirtyEntries();
    return pending?.length ?? 0;
  }

  async hasPendingMutations(): Promise<boolean> {
    const pending = await this.syncStore?.listDirtyEntries(1);
    return (pending?.length ?? 0) > 0;
  }

  // Local changes this device keeps but no longer pushes, with a reason to show.
  async listBlockedUploads(): Promise<BlockedUpload[]> {
    const store = this.syncStore;
    if (!store) {
      return [];
    }
    const blocked: BlockedUpload[] = [];
    for (const mutation of await store.listBlockedDirtyEntries()) {
      const local = await store.getLocalStateById(mutation.entryId);
      const path =
        local?.path ??
        (await tryDecryptPendingMetadata(this.deps.crypto, mutation))?.path ??
        mutation.entryId;
      blocked.push({
        entryId: mutation.entryId,
        path,
        reason: describeBlockedReason(mutation.blockedReason ?? null),
      });
    }
    return blocked;
  }

  // Sends changes the server rejected again (a fresh start for their rejection count).
  // Too-large and over-quota changes stay blocked until the server policy allows them.
  async retryBlockedUploads(): Promise<number> {
    const store = this.requireStore();
    const retryable = (await store.listBlockedDirtyEntries()).filter(
      (mutation) =>
        mutation.blockedReason === "repeated_rejection" ||
        mutation.blockedReason === "unresolved_rejection",
    );
    await store.unblockDirtyEntriesByReason("repeated_rejection");
    await store.unblockDirtyEntriesByReason("unresolved_rejection");
    await store.flush();
    if (retryable.length > 0) {
      this.recordActivity(
        "resume",
        `Retrying ${retryable.length} rejected upload${retryable.length === 1 ? "" : "s"}`,
      );
      this.notifyLocalChange();
    }
    return retryable.length;
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

  private async pullWithActivity(session: SyncRealtimeSession): Promise<PullOnceResult> {
    return await this.withSyncActivity("pull", async () => {
      this.newDeviceIssuesThisPull = 0;
      this.newUnreadableThisPull = 0;
      try {
        const result = await this.syncPullService.pullOnce(session);
        this.recordPullResult(result);
        return result;
      } finally {
        this.notifyNewDeviceIssues();
        this.notifyNewUnreadableEntries();
      }
    });
  }

  getDeviceSyncIssues(): DeviceSyncIssues {
    return this.deviceSyncIssues;
  }

  // A file this device skipped or could not write never fails the pull and never
  // needs attention; it is logged, listed in the status modal, and announced once.
  private handleDeviceIssue(event: PullDeviceIssueEvent): void {
    const isNew = this.deviceSyncIssues.applyPullEvent(event);
    if (!isNew || event.kind === "resolved") {
      return;
    }
    this.newDeviceIssuesThisPull += 1;
    this.recordActivity("skip", `Not written on this device: ${event.path} (${event.reason})`);
  }

  // An entry this device's key cannot decrypt is quarantined by the pull (never applied,
  // never a reason to delete anything). Recorded so it is visible, not silently skipped.
  private handleDecryptFailure(entryId: string): void {
    if (this.deviceSyncIssues.noteUnreadableEntry(entryId)) {
      this.newUnreadableThisPull += 1;
    }
  }

  private notifyNewUnreadableEntries(): void {
    const count = this.newUnreadableThisPull;
    this.newUnreadableThisPull = 0;
    if (count === 0) {
      return;
    }
    const entries = count === 1 ? "1 entry" : `${count} entries`;
    this.recordActivity("error", `${entries} can't be decrypted with this vault's key`);
    this.deps.notify(
      `Osync: ${entries} on the server can't be decrypted with this vault's key. Run "Verify vault key" for details.`,
    );
  }

  // Read-only scan of every server entry with this device's key (see
  // unreadable-entries.ts). The result replaces the recorded unreadable entries.
  async scanUnreadableRemoteEntries(
    onProgress?: (scanned: number, total: number) => void,
  ): Promise<UnreadableScanResult & { knownLocally: string[] }> {
    const result = await this.withRealtimeSession(
      async (session) =>
        await scanUnreadableRemoteEntries({ session, crypto: this.deps.crypto, onProgress }),
    );
    this.deviceSyncIssues.replaceUnreadableEntries(
      result.unreadable.map((entry) => entry.entryId),
    );
    const knownLocally: string[] = [];
    const store = this.syncStore;
    if (store) {
      for (const entry of result.unreadable) {
        const state = await store.getEntryStateById(entry.entryId);
        if (state?.local && !state.local.deleted && state.local.path) {
          knownLocally.push(entry.entryId);
        }
      }
    }
    return { ...result, knownLocally };
  }

  // Deletes unreadable entries on the server. Only call after confirming this
  // device's key matches the vault's fingerprint. Local files are never touched: a
  // removed entry this device still maps to a file is forgotten by the follow-up pull
  // and the file re-uploads as a new entry.
  async removeUnreadableRemoteEntries(
    targets: readonly UnreadableRemoteEntry[],
  ): Promise<UnreadableRemovalResult> {
    const result = await this.withRealtimeSession(async (session) => {
      const removal = await commitUnreadableRemovals({
        session,
        crypto: this.deps.crypto,
        targets,
      });
      for (const entryId of removal.removed) {
        this.deviceSyncIssues.forgetUnreadableEntry(entryId);
      }
      this.recordActivity(
        "push",
        `Removed ${removal.removed.length} unreadable entries from the server${
          removal.failed.length > 0 ? `, ${removal.failed.length} failed` : ""
        }`,
      );
      await this.pullWithActivity(session);
      return removal;
    });
    await this.reconcileOnce();
    this.syncAutoLoop.notifyLocalChange();
    return result;
  }

  // Repair for a device that encrypted with the wrong key: its own entries on the
  // server are unreadable now, but the files are plaintext on disk. Forget those
  // entries locally (files untouched) so the scan uploads the files as new entries.
  async reuploadUnreadableLocalEntries(entryIds: readonly string[]): Promise<number> {
    const store = this.requireStore();
    const detached = await this.runLocalMutationWork(
      async () => await detachLocalEntries(store, entryIds),
    );
    await store.flush();
    if (detached.length > 0) {
      this.recordActivity(
        "scan",
        `Re-uploading ${detached.length} local file${detached.length === 1 ? "" : "s"} whose server entries were unreadable`,
      );
      await this.reconcileOnce();
      this.syncAutoLoop.notifyLocalChange();
    }
    return detached.length;
  }

  // A queued change recorded with another vault's key was dropped (by a push, a pull
  // or a scan). The re-scan that follows first drops every other such change, so the
  // files on disk are queued again with the current key. Local files are never touched.
  private noteUndecryptablePendingDropped(): void {
    this.pendingRescan.dropped += 1;
    this.scheduleRescan();
  }

  // A stale change had no readable server state to rebase onto; its entry was
  // forgotten locally so the re-scan uploads the file as a new entry.
  private noteEntriesDetached(entryIds: readonly string[]): void {
    this.pendingRescan.detached += entryIds.length;
    this.scheduleRescan();
  }

  // Once the sync step that asked for it is done, log why and run one full local scan.
  private scheduleRescan(): void {
    if (this.pendingRescan.queued) {
      return;
    }
    this.pendingRescan.queued = true;
    void this.runLocalMutationWork(async () => {
      await this.waitForRemoteSyncActivities();
      const { dropped, detached } = this.pendingRescan;
      this.pendingRescan.dropped = 0;
      this.pendingRescan.detached = 0;
      this.pendingRescan.queued = false;
      if (!this.syncStore) {
        return; // Reset or disconnected meanwhile: nothing left to re-scan.
      }
      if (dropped > 0) {
        this.recordActivity(
          "scan",
          `Dropped ${dropped} queued change${dropped === 1 ? "" : "s"} encrypted with an old key; re-scanning files`,
        );
      }
      if (detached > 0) {
        this.recordActivity(
          "scan",
          `Re-uploading ${detached} file${detached === 1 ? "" : "s"} as new entries: their server entries were removed or unreadable`,
        );
      }
      const result = await this.syncLocalReconcileService.reconcileOnce({
        sanitizePendingMetadata: dropped > 0,
      });
      this.recordActivity(
        "scan",
        `Re-scan: ${result.filesQueuedForUpsert} upserts, ${result.filesQueuedForDelete} deletes queued (${result.filesScanned} scanned)`,
      );
      this.notifyLocalChange();
    }).catch((error: unknown) => {
      this.pendingRescan.queued = false;
      this.recordActivity("error", `Re-scan failed: ${describeActivityError(error)}`);
    });
  }

  // The server kept rejecting a change; it is blocked (listed in the sync status) so
  // the push stops retrying it. The file itself is untouched.
  private handleMutationBlocked(event: BlockedMutationEvent): void {
    const target = event.path ?? `entry ${event.entryId}`;
    this.recordActivity(
      "error",
      `Stopped uploading ${target}: the server rejected it ${event.rejections} times (${event.code})`,
    );
    this.deps.notify(
      `Osync: "${target}" couldn't be uploaded. Open sync status to retry.`,
    );
  }

  private async waitForRemoteSyncActivities(): Promise<void> {
    for (;;) {
      const remote = this.activeSyncActivities.filter((activity) => activity.kind !== "local");
      if (remote.length === 0) {
        return;
      }
      await Promise.allSettled(remote.map((activity) => activity.done));
    }
  }

  private notifyNewDeviceIssues(): void {
    const count = this.newDeviceIssuesThisPull;
    this.newDeviceIssuesThisPull = 0;
    if (count === 0) {
      return;
    }
    const files = count === 1 ? "1 file" : `${count} files`;
    this.deps.notify(
      `Osync: ${files} couldn't be written on this device. Open sync status for details.`,
    );
  }

  // Local files other platforms cannot hold still upload; warn once per path.
  private notePortability(
    paths: readonly string[],
    options?: { complete?: boolean },
  ): void {
    const fresh = this.deviceSyncIssues.noteLocalPaths(paths, options);
    for (const warning of fresh) {
      this.recordActivity("warning", `Won't open on Windows: ${warning.path} (${warning.reason})`);
    }
    if (fresh.length > MAX_INDIVIDUAL_PORTABILITY_NOTICES) {
      this.deps.notify(
        `Osync: ${fresh.length} files can't be opened on Windows. Open sync status for details.`,
      );
      return;
    }
    for (const warning of fresh) {
      this.deps.notify(
        `Osync: "${warning.name}" can't be opened on Windows (${warning.reason}). Rename it to sync to Windows devices.`,
      );
    }
  }

  // Re-applies entries whose write failed on this device. The pull cursor is already
  // past them, so instead of rewinding it we write the recorded remote state directly
  // (download + verify + write), the same way the pull would have. Entries that fail
  // again go back on the list. Returns how many were attempted and how many failed.
  async retryUnwritablePaths(): Promise<{ retried: number; failed: number }> {
    const store = this.requireStore();
    const targets = this.deviceSyncIssues.takeWriteFailures();
    let failed = 0;
    for (const target of targets) {
      try {
        await this.runLocalMutationWork(async () => {
          await this.reapplyRemoteEntry(store, target.entryId);
        });
        this.recordActivity("pull", `Retried write: ${target.path}`);
      } catch (error) {
        failed += 1;
        const reason = describeActivityError(error);
        console.error(`[osync] retry: could not write ${target.path}`, error);
        this.deviceSyncIssues.applyPullEvent({
          kind: "write_failed",
          entryId: target.entryId,
          path: target.path,
          reason,
        });
        this.recordActivity("skip", `Retry failed: ${target.path} (${reason})`);
      }
    }
    return { retried: targets.length, failed };
  }

  private async reapplyRemoteEntry(store: SyncStore, entryId: string): Promise<void> {
    const remote = await store.getRemoteStateById(entryId);
    if (!remote || remote.deleted || !remote.path) {
      return; // Deleted or moved away since; nothing left to write here.
    }
    const path = remote.path;
    if (!this.vaultAdapter.isSyncablePath(path)) {
      // Excluded by the user's rules now, or a path this device can never hold.
      const reason = this.deviceSyncIssues.describeUnwritable(path);
      if (reason) {
        this.deviceSyncIssues.applyPullEvent({ kind: "skipped", entryId, path, reason });
      }
      return;
    }

    if (remote.entryType === "folder") {
      await this.syncEventGate.suppressPaths([path], async () => {
        if (!(await this.vaultAdapter.exists(path))) {
          await this.vaultAdapter.mkdir(path);
        }
      });
      await store.applyLocalState({
        entryId,
        path,
        blobId: null,
        hash: null,
        entryType: "folder",
        deleted: false,
        updatedAt: Date.now(),
        localMtime: null,
        localSize: null,
      });
      return;
    }

    if (!remote.blobId) {
      return;
    }
    // While the path was device-excluded, local edits to an existing file there were
    // not recorded. Never overwrite such an edit: leave it for the next scan, which
    // now sees the path again and uploads it against the remote base.
    const local = await store.getLocalStateById(entryId);
    if (await this.vaultAdapter.exists(path)) {
      const diskHash = await hashBytes(await this.vaultAdapter.readBytes(path));
      if (diskHash !== remote.hash && diskHash !== local?.hash) {
        return;
      }
    }

    const bytes = await this.downloadAndDecryptVersionBlob(remote.blobId);
    if (remote.hash && (await hashBytes(bytes)) !== remote.hash) {
      throw new Error("Downloaded content did not match its recorded hash");
    }
    await this.syncEventGate.suppressPaths([path], async () => {
      await writeVaultBytes(this.vaultAdapter, path, bytes);
    });
    await store.applyLocalState({
      entryId,
      path,
      blobId: remote.blobId,
      hash: remote.hash,
      entryType: remote.entryType,
      deleted: false,
      updatedAt: Date.now(),
      localMtime: null,
      localSize: null,
    });
  }

  private recordPullResult(result: PullOnceResult): void {
    const changes =
      result.entriesApplied === 0 && result.filesWritten === 0 && result.filesDeleted === 0
        ? "no changes"
        : `${result.entriesApplied} applied, ${result.filesWritten} written, ${result.filesDeleted} deleted`;
    const conflicts =
      result.conflictsCreated > 0 ? `, ${result.conflictsCreated} conflicts` : "";
    this.recordActivity("pull", `Pulled to cursor ${result.cursor}: ${changes}${conflicts}`);
  }

  private recordPushResult(result: PushPendingMutationsResult): void {
    if (
      result.mutationsPushed === 0 &&
      result.mutationsRequeued === 0 &&
      result.mutationsDropped === 0 &&
      result.conflictsCreated === 0
    ) {
      return;
    }
    const requeued =
      result.mutationsRequeued > 0 ? `, ${result.mutationsRequeued} requeued` : "";
    const dropped =
      result.mutationsDropped > 0
        ? `, ${result.mutationsDropped} dropped (old key)`
        : "";
    const conflicts =
      result.conflictsCreated > 0 ? `, ${result.conflictsCreated} conflicts` : "";
    const more = result.hasMore ? ", more pending" : "";
    this.recordActivity(
      "push",
      `Pushed ${result.mutationsPushed} changes${requeued}${dropped}${conflicts} (cursor ${result.cursor})${more}`,
    );
  }

  private handleSyncConflict(event: SyncConflictEvent): void {
    const detail = event.reason ?? event.op;
    const target = event.conflictPath ? ` → ${event.conflictPath}` : "";
    this.recordActivity("conflict", `Conflict (${detail}): ${event.originalPath}${target}`);
    this.deps.notifySyncConflict(event);
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
    // Settled work can queue more (a pull's conflict re-scan, a push's follow-up), so
    // wait until a pass finds nothing running.
    for (;;) {
      const queue = this.localMutationQueue;
      await queue;
      const pending = this.activeSyncActivities.map((activity) => activity.done);
      if (pending.length === 0 && queue === this.localMutationQueue) {
        return;
      }
      await Promise.allSettled(pending);
    }
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

export interface BlockedUpload {
  entryId: string;
  path: string;
  reason: string;
}

function describeBlockedReason(reason: PendingMutationBlockedReason | null): string {
  switch (reason) {
    case "file_too_large":
      return "Too large for the server";
    case "storage_quota_exceeded":
      return "Storage limit reached";
    case "repeated_rejection":
      return "Rejected by the server repeatedly";
    case "unresolved_rejection":
      return "Rejected by the server";
    default:
      return "Not uploaded";
  }
}

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
