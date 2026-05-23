/**
 * @deprecated Use `SyncHttpClient` from `./http-client` instead. This module is
 * preserved as a thin re-export so existing imports continue to compile.
 */
export {
  SyncHttpClient as SyncAuthorizedRequestClient,
  type SyncHttpClientDeps as SyncAuthorizedRequestClientDeps,
  type SyncAuthorizedRequestInput,
  type SyncAuthorizedRequestResult,
} from "./http-client";
