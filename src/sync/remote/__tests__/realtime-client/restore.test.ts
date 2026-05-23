import { describe, expect, it } from "vitest";

import { SyncRealtimeError } from "../../realtime-client";
import {
  openRealtimeSession,
  waitForSentMessage,
} from "./helpers";

describe("SyncRealtimeClient restore", () => {
  it("routes restore failures to the pending request", async () => {
    const errors: Error[] = [];
    const { socket, session } = await openRealtimeSession({
      callbacks: {
        onError(error) {
          errors.push(error);
        },
      },
    });

    const restorePromise = session.restoreEntryVersion({
      entryId: "entry-1",
      versionId: "version-1",
      baseRevision: 2,
      op: "upsert",
      blobId: "blob-1",
      encryptedMetadata: "ciphertext",
    });
    await waitForSentMessage(socket, 1);
    const restore = socket.sentMessageAt(1);
    expect(restore).toMatchObject({
      type: "restore_entry_version",
      entryId: "entry-1",
      versionId: "version-1",
      baseRevision: 2,
      op: "upsert",
      blobId: "blob-1",
      encryptedMetadata: "ciphertext",
    });
    socket.emitMessage({
      type: "entry_restore_failed",
      requestId: restore.requestId,
      code: "not_found",
      message: "requested revision was not found",
    });

    await expect(restorePromise).rejects.toBeInstanceOf(SyncRealtimeError);
    await expect(restorePromise).rejects.toMatchObject({ code: "not_found" });
    expect(errors).toEqual([]);
  });
});
