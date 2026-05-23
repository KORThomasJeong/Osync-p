import type { SyncTokenResponse } from "./client";
import { SyncRealtimeApiSession, applySessionStorageLimit } from "./realtime-api-session";
import { SyncRealtimeSocketSession, waitForOpen } from "./realtime-socket-session";
import type {
  RealtimeSessionState,
  ServerMessage,
  SyncRealtimeCallbacks,
  SyncRealtimeClientOptions,
  SyncRealtimeSession,
  WebSocketFactory,
} from "./realtime-types";
import { toWebSocketUrl } from "./realtime-url";
import {
  SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX,
  SYNC_WEBSOCKET_PROTOCOL,
} from "./socket-protocol";

export type {
  CommitAcceptedResult,
  CommitMutationBatchResult,
  CommitMutationPayload,
  CommitMutationsResult,
  EntryVersion,
  EntryVersionPageCursor,
  EntryVersionRestoredResponse,
  EntryVersionsResponse,
  SyncRealtimeCallbacks,
  SyncRealtimeClientOptions,
  SyncRealtimeSession,
  SyncStorageStatus,
  WebSocketFactory,
} from "./realtime-types";
export { SyncRealtimeError } from "./realtime-types";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;

export class SyncRealtimeClient {
  private readonly options: SyncRealtimeClientOptions;

  constructor(
    private readonly webSocketFactory: WebSocketFactory = {
      create: (url, protocols) => new WebSocket(url, protocols),
    },
    options: Partial<SyncRealtimeClientOptions> = {},
  ) {
    this.options = {
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
    };
  }

  async openSession(
    apiBaseUrl: string,
    token: SyncTokenResponse,
    lastKnownCursor: number,
    callbacks: SyncRealtimeCallbacks,
  ): Promise<SyncRealtimeSession> {
    const socket = this.webSocketFactory.create(
      toWebSocketUrl(apiBaseUrl, token.vaultId),
      [SYNC_WEBSOCKET_PROTOCOL, `${SYNC_WEBSOCKET_AUTH_PROTOCOL_PREFIX}${token.token}`],
    );

    await waitForOpen(socket);
    const state: RealtimeSessionState = {
      storageStatus: {
        storageUsedBytes: 0,
        storageLimitBytes: 0,
      },
      storageLimitBytes: 0,
    };
    const transport = new SyncRealtimeSocketSession(
      socket,
      {
        ...callbacks,
        onStorageStatusUpdated(status) {
          const nextStatus = applySessionStorageLimit(status, state.storageLimitBytes);
          state.storageStatus = nextStatus;
          callbacks.onStorageStatusUpdated(nextStatus);
        },
      },
      this.options,
    );
    let hello: ServerMessage;
    try {
      hello = await transport.request({
        type: "hello",
        lastKnownCursor,
      });
      if (hello.type !== "hello_ack") {
        throw new Error("hello did not produce a hello_ack response");
      }
      state.storageStatus = {
        storageUsedBytes: hello.storageStatus.storageUsedBytes,
        storageLimitBytes: hello.policy.storageLimitBytes,
      };
      state.storageLimitBytes = hello.policy.storageLimitBytes;
      transport.startHeartbeat();
    } catch (error) {
      transport.close();
      throw error;
    }

    return new SyncRealtimeApiSession(transport, hello, state);
  }
}
