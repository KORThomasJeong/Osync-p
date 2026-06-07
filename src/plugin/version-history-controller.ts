import { TFile, type Plugin } from "obsidian";

import type {
  OsyncDeletedFile,
  OsyncEntryVersion,
  OsyncEntryVersionCursor,
  OsyncEntryVersionsPage,
} from "./view-models";
import {
  OSYNC_VERSION_HISTORY_VIEW_TYPE,
  OsyncVersionHistoryView,
  type VersionHistoryViewController,
  type VersionHistoryViewState,
} from "./version-history-view";
import { shouldSyncPath, type SyncFileRules } from "../sync/core/file-rules";
import type { EntryVersion } from "../sync/remote/realtime-client";
import type { SyncController } from "../sync/runtime/controller";
import type { DeletedSyncEntryRow } from "../sync/store/store";

const RESTORE_BATCH_SIZE = 100;

export interface OsyncVersionHistoryControllerDeps {
  plugin: Plugin;
  syncController: SyncController;
  getSyncFileRules: () => SyncFileRules;
  hasAuthenticatedSession: () => boolean;
  hasConnectedRemoteVault: () => boolean;
  refreshUi: () => void;
}

export class OsyncVersionHistoryController
  implements VersionHistoryViewController
{
  private readonly activeFileVersionsById = new Map<string, EntryVersion>();
  private activeFileEntryId: string | null = null;

  constructor(private readonly deps: OsyncVersionHistoryControllerDeps) {}

  async openPane(): Promise<void> {
    const existing = this.deps.plugin.app.workspace.getLeavesOfType(
      OSYNC_VERSION_HISTORY_VIEW_TYPE,
    )[0];
    if (existing) {
      await this.deps.plugin.app.workspace.revealLeaf(existing);
      return;
    }

    const leaf = this.deps.plugin.app.workspace.getRightLeaf(false);
    if (!leaf) {
      throw new Error("Unable to open the right sidebar.");
    }

    await leaf.setViewState({
      type: OSYNC_VERSION_HISTORY_VIEW_TYPE,
      active: true,
    });
    await this.deps.plugin.app.workspace.revealLeaf(leaf);
  }

  async listActiveFileVersions(
    before: OsyncEntryVersionCursor | null,
    limit: number,
  ): Promise<VersionHistoryViewState> {
    if (!this.deps.hasAuthenticatedSession() || !this.deps.hasConnectedRemoteVault()) {
      return {
        status: "not_connected",
        message: "Connect and sign in before viewing version history.",
      };
    }

    const file = this.deps.plugin.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) {
      return {
        status: "no_active_file",
        message: "Open a synced file to view its history.",
      };
    }

    if (!shouldSyncPath(file.path, this.deps.getSyncFileRules())) {
      return {
        status: "not_syncable",
        path: file.path,
        message: "This file is excluded from Osync.",
      };
    }

    const page = await this.deps.syncController.listEntryVersionsForPath(
      file.path,
      before,
      limit,
    );
    if (!page) {
      return {
        status: "not_synced",
        path: file.path,
        message: "This file has not synced yet.",
      };
    }

    if (!before) {
      this.activeFileVersionsById.clear();
      this.activeFileEntryId = page.entryId;
    }
    for (const version of page.versions) {
      this.activeFileVersionsById.set(version.versionId, version);
    }

    return {
      status: "ready",
      ...toOsyncEntryVersionsPage(page),
    };
  }

  async restoreActiveFileVersion(versionId: string): Promise<void> {
    const file = this.deps.plugin.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) {
      throw new Error("Open a synced file before restoring version history.");
    }
    const version = this.activeFileVersionsById.get(versionId);
    if (!version) {
      throw new Error("Refresh version history before restoring this version.");
    }
    await this.deps.syncController.restoreEntryVersionForPath(file.path, version);
    this.deps.refreshUi();
  }

  async previewActiveFileVersion(versionId: string): Promise<string | null> {
    const version = this.activeFileVersionsById.get(versionId);
    if (!version || version.op === "delete" || !version.blobId) {
      return null;
    }
    const bytes = await this.deps.syncController.downloadAndDecryptVersionBlob(version.blobId);
    const sampleLength = Math.min(bytes.length, 8192);
    for (let i = 0; i < sampleLength; i++) {
      if (bytes[i] === 0) {
        return null;
      }
    }
    return new TextDecoder().decode(bytes);
  }

  async listDeletedFiles(): Promise<OsyncDeletedFile[]> {
    if (!this.deps.hasAuthenticatedSession() || !this.deps.hasConnectedRemoteVault()) {
      throw new Error("Connect and sign in before viewing deleted files.");
    }

    return (await this.deps.syncController.listDeletedEntries()).map(
      toOsyncDeletedFile,
    );
  }

  async restoreDeletedFiles(entryIds: string[]): Promise<{ restored: number; failed: number }> {
    if (!this.deps.hasAuthenticatedSession() || !this.deps.hasConnectedRemoteVault()) {
      throw new Error("Connect and sign in before restoring deleted files.");
    }

    let restored = 0;
    let failed = 0;
    for (let i = 0; i < entryIds.length; i += RESTORE_BATCH_SIZE) {
      const batch = entryIds.slice(i, i + RESTORE_BATCH_SIZE);
      for (const entryId of batch) {
        try {
          await this.deps.syncController.restoreDeletedEntry(entryId);
          restored += 1;
        } catch {
          failed += 1;
        }
      }
    }
    this.deps.refreshUi();
    return { restored, failed };
  }

  refreshViews(): void {
    for (const leaf of this.deps.plugin.app.workspace.getLeavesOfType(
      OSYNC_VERSION_HISTORY_VIEW_TYPE,
    )) {
      const view = leaf.view;
      if (view instanceof OsyncVersionHistoryView) {
        void view.refresh();
      }
    }
  }
}

function toOsyncEntryVersionsPage(page: {
  path: string;
  dirty: boolean;
  versions: EntryVersion[];
  hasMore: boolean;
  nextBefore: OsyncEntryVersionCursor | null;
}): OsyncEntryVersionsPage {
  return {
    path: page.path,
    dirty: page.dirty,
    versions: page.versions.map(toOsyncEntryVersion),
    hasMore: page.hasMore,
    nextBefore: page.nextBefore,
  };
}

function toOsyncEntryVersion(version: EntryVersion): OsyncEntryVersion {
  return {
    versionId: version.versionId,
    sourceRevision: version.sourceRevision,
    op: version.op,
    hasBlob: version.blobId !== null,
    reason: version.reason,
    capturedAt: version.capturedAt,
  };
}

function toOsyncDeletedFile(file: DeletedSyncEntryRow): OsyncDeletedFile {
  return {
    entryId: file.entryId,
    path: file.path,
    revision: file.revision,
    deletedAt: file.deletedAt,
    dirty: file.dirty,
  };
}
