import type { EntryStatePageCursor } from "./changes";
import type {
  CommitMutationPayload,
  EntryVersionPageCursor,
  ServerMessage,
  SyncRealtimeCallbacks,
  SyncRealtimeClientOptions,
} from "./realtime-types";
import { SyncRealtimeError } from "./realtime-types";

type ClientMessage =
  | {
      type: "hello";
      requestId: string;
      lastKnownCursor: number;
    }
  | {
      type: "commit_mutations";
      requestId: string;
      mutations: CommitMutationPayload[];
    }
  | {
      type: "list_entry_states";
      requestId: string;
      sinceCursor: number;
      targetCursor: number | null;
      after: EntryStatePageCursor | null;
      limit: number;
    }
  | {
      type: "list_entry_versions";
      requestId: string;
      entryId: string;
      before: EntryVersionPageCursor | null;
      limit: number;
    }
  | {
      type: "restore_entry_version";
      requestId: string;
      entryId: string;
      versionId: string;
      baseRevision: number;
      op: "upsert" | "delete";
      blobId: string | null;
      encryptedMetadata: string;
    }
  | {
      type: "ack_cursor";
      requestId: string;
      cursor: number;
    }
  | {
      type: "heartbeat";
      requestId: string;
    }
  | {
      type: "watch_storage_status";
    }
  | {
      type: "unwatch_storage_status";
    };

type RequestClientMessage = Extract<ClientMessage, { requestId: string }>;
type RequestClientMessageInput = RequestClientMessage extends infer Message
  ? Message extends { requestId: string }
    ? Omit<Message, "requestId">
    : never
  : never;

type PendingRequest = {
  resolve(message: ServerMessage): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout> | null;
  // Requests whose response advances the server cursor on our behalf.
  mutating: boolean;
};

function isMutatingRequest(message: RequestClientMessage): boolean {
  return message.type === "commit_mutations" || message.type === "restore_entry_version";
}

export class SyncRealtimeSocketSession {
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private nextRequestId = 0;
  // Highest server cursor this session knows it has been told about: hello,
  // cursor_advanced, cursor acks, and our own commits (only when they are
  // contiguous with what we already knew). A heartbeat_ack reporting a higher
  // cursor means a cursor_advanced broadcast was lost — typically while the OS
  // suspended the app with the socket still open — so we replay it locally.
  private knownServerCursor: number | null = null;
  private pendingMutatingRequests = 0;

  constructor(
    private readonly socket: WebSocket,
    private readonly callbacks: SyncRealtimeCallbacks,
    private readonly options: SyncRealtimeClientOptions,
  ) {
    socket.addEventListener("message", this.handleMessage as EventListener);
    socket.addEventListener("error", this.handleError);
    socket.addEventListener("close", this.handleClose);
  }

  startHeartbeat(): void {
    if (this.options.heartbeatIntervalMs <= 0 || this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat();
    }, this.options.heartbeatIntervalMs);
  }

  async request(
    message: RequestClientMessageInput,
    timeoutMs = this.options.requestTimeoutMs,
    reportConnectionError = false,
  ): Promise<ServerMessage> {
    return await this.sendAndAwait(
      {
        ...message,
        requestId: this.createRequestId(),
      } as RequestClientMessage,
      timeoutMs,
      reportConnectionError,
    );
  }

  private createRequestId(): string {
    this.nextRequestId += 1;
    return `sync-request-${this.nextRequestId}`;
  }

  private async sendAndAwait(
    message: RequestClientMessage,
    timeoutMs = this.options.requestTimeoutMs,
    reportConnectionError = false,
  ): Promise<ServerMessage> {
    return await new Promise<ServerMessage>((resolve, reject) => {
      if (this.closed) {
        reject(new Error("sync websocket is not connected"));
        return;
      }

      const timeout =
        timeoutMs > 0
          ? setTimeout(() => {
              if (!this.pendingRequests.has(message.requestId)) {
                return;
              }

              this.failConnection(
                new Error("sync websocket request timed out"),
                reportConnectionError,
              );
            }, timeoutMs)
          : null;
      const mutating = isMutatingRequest(message);
      if (mutating) {
        this.pendingMutatingRequests += 1;
      }
      this.pendingRequests.set(message.requestId, { resolve, reject, timeout, mutating });
      try {
        this.socket.send(JSON.stringify(message));
      } catch (error) {
        this.failConnection(
          error instanceof Error ? error : new Error(String(error)),
          reportConnectionError,
        );
      }
    });
  }

  send(message: ClientMessage): void {
    if (this.closed) {
      throw new Error("sync websocket is not connected");
    }

    try {
      this.socket.send(JSON.stringify(message));
    } catch (error) {
      this.failConnection(error instanceof Error ? error : new Error(String(error)), false);
      throw error;
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.stopHeartbeat();
    this.socket.removeEventListener("message", this.handleMessage as EventListener);
    this.socket.removeEventListener("error", this.handleError);
    this.socket.removeEventListener("close", this.handleClose);
    this.rejectPending(new Error("sync websocket closed before the request completed"));
    try {
      this.socket.close();
    } catch {
      // The session is already being torn down.
    }
  }

  private readonly handleMessage = (event: MessageEvent<string>): void => {
    if (this.closed) {
      return;
    }

    let parsed: ServerMessage;
    try {
      parsed = JSON.parse(event.data) as ServerMessage;
    } catch {
      this.callbacks.onError(new Error("sync websocket returned invalid JSON"));
      return;
    }

    if (parsed.type === "cursor_advanced") {
      this.noteKnownCursor(parsed.cursor);
      this.callbacks.onCursorAdvanced(parsed.cursor);
      return;
    }

    if (parsed.type === "storage_status_updated") {
      this.callbacks.onStorageStatusUpdated(parsed.storageStatus);
      return;
    }

    if (parsed.type === "session_error") {
      const error = new SyncRealtimeError(parsed.code, parsed.message);
      this.rejectPending(error);
      this.callbacks.onError(error);
      return;
    }

    const request = this.pendingRequests.get(parsed.requestId);
    if (!request) {
      this.callbacks.onError(
        new Error(`sync websocket returned a response for unknown request ${parsed.requestId}`),
      );
      return;
    }

    this.pendingRequests.delete(parsed.requestId);
    this.clearPendingTimeout(request);
    this.settleMutating(request);
    this.trackCursorFromResponse(parsed);
    if (
      parsed.type === "commit_rejected" ||
      parsed.type === "commit_mutations_failed" ||
      parsed.type === "entry_states_list_failed" ||
      parsed.type === "entry_versions_list_failed" ||
      parsed.type === "entry_restore_failed"
    ) {
      request.reject(new SyncRealtimeError(parsed.code, parsed.message));
      return;
    }

    request.resolve(parsed);
  };

  private trackCursorFromResponse(message: ServerMessage): void {
    switch (message.type) {
      case "hello_ack":
      case "cursor_acked":
        this.noteKnownCursor(message.cursor);
        return;
      case "commit_mutations_committed":
        // Our own commits are not broadcast back to us. Fold them in only when
        // they extend the known cursor without a gap: a gap means another
        // device committed in between and we never heard about it, which is
        // exactly what the heartbeat check should catch. The batch-level
        // `cursor` is ignored — with no accepted results it is the vault's
        // current cursor, which could mask a missed broadcast.
        this.foldOwnCommitCursors(
          message.results.flatMap((result) =>
            result.status === "accepted" ? [result.cursor] : [],
          ),
        );
        return;
      case "commit_accepted":
      case "entry_version_restored":
        this.foldOwnCommitCursors([message.cursor]);
        return;
      case "heartbeat_ack":
        this.checkHeartbeatCursor(message.cursor);
        return;
      default:
        return;
    }
  }

  private checkHeartbeatCursor(cursor: number | undefined): void {
    if (typeof cursor !== "number" || !Number.isFinite(cursor)) {
      // Older server without heartbeat cursors.
      return;
    }
    if (this.knownServerCursor === null) {
      this.knownServerCursor = cursor;
      return;
    }
    if (this.pendingMutatingRequests > 0) {
      // Our own in-flight commit may already be reflected in the server cursor
      // before its response reaches us. Re-evaluate on the next heartbeat.
      return;
    }
    if (cursor <= this.knownServerCursor) {
      this.callbacks.onServerCursorConfirmed?.(cursor);
      return;
    }
    this.knownServerCursor = cursor;
    this.callbacks.onCursorAdvanced(cursor);
  }

  private foldOwnCommitCursors(cursors: number[]): void {
    if (this.knownServerCursor === null) {
      return;
    }
    const sorted = [...cursors].sort((a, b) => a - b);
    for (const cursor of sorted) {
      if (cursor <= this.knownServerCursor) {
        continue;
      }
      if (cursor !== this.knownServerCursor + 1) {
        return;
      }
      this.knownServerCursor = cursor;
    }
  }

  private noteKnownCursor(cursor: number): void {
    if (typeof cursor !== "number" || !Number.isFinite(cursor)) {
      return;
    }
    if (this.knownServerCursor === null || cursor > this.knownServerCursor) {
      this.knownServerCursor = cursor;
    }
  }

  private settleMutating(request: PendingRequest): void {
    if (request.mutating) {
      request.mutating = false;
      this.pendingMutatingRequests = Math.max(0, this.pendingMutatingRequests - 1);
    }
  }

  private readonly handleError = (): void => {
    this.failConnection(new Error("sync websocket connection failed"));
  };

  private readonly handleClose = (): void => {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.stopHeartbeat();
    this.rejectPending(new Error("sync websocket closed before the request completed"));
    this.callbacks.onClose();
  };

  private async sendHeartbeat(): Promise<void> {
    try {
      const message = await this.request(
        {
          type: "heartbeat",
        },
        this.options.heartbeatTimeoutMs,
        true,
      );
      if (message.type !== "heartbeat_ack") {
        throw new Error("heartbeat did not produce a heartbeat_ack response");
      }
    } catch (error) {
      if (!this.closed) {
        this.failConnection(error instanceof Error ? error : new Error(String(error)), true);
      }
    }
  }

  private failConnection(error: Error, reportError = true): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.stopHeartbeat();
    this.socket.removeEventListener("message", this.handleMessage as EventListener);
    this.socket.removeEventListener("error", this.handleError);
    this.socket.removeEventListener("close", this.handleClose);
    this.rejectPending(error);
    if (reportError) {
      this.callbacks.onError(error);
    }
    this.callbacks.onClose();
    try {
      this.socket.close();
    } catch {
      // The connection may already be closed by the platform.
    }
  }

  private rejectPending(error: Error): void {
    const pending = Array.from(this.pendingRequests.values());
    this.pendingRequests.clear();
    for (const request of pending) {
      this.clearPendingTimeout(request);
      this.settleMutating(request);
      request.reject(error);
    }
  }

  private clearPendingTimeout(request: PendingRequest): void {
    if (request.timeout) {
      clearTimeout(request.timeout);
    }
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return;
    }

    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}

export async function waitForOpen(socket: WebSocket, timeoutMs = 15_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("sync websocket connection failed"));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("sync websocket closed before the session started"));
    };
    const onTimeout = () => {
      cleanup();
      try {
        socket.close();
      } catch {
        // The connection may already be closed by the platform.
      }
      reject(new Error("sync websocket connection timed out before opening"));
    };

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);

    if (timeoutMs > 0) {
      timeout = setTimeout(onTimeout, timeoutMs);
    }
  });
}

