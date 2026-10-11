import type { SyncStore } from "./store";

// Thrown by every call on a store handle after a reset, disconnect or unload detached
// it. Work that was already running holds its own reference to the store; once the
// store is detached that work must fail fast here instead of reading or writing the
// database being closed and deleted underneath it (on iOS such stray IndexedDB calls
// surface as "Transaction aborted" / "without an in-progress transaction").
export class SyncStoreDetachedError extends Error {
  constructor() {
    super("Local sync store was detached (reset, disconnect or unload).");
    this.name = "SyncStoreDetachedError";
  }
}

export function isSyncStoreDetachedError(error: unknown): boolean {
  return error instanceof SyncStoreDetachedError;
}

export interface DetachableSyncStore {
  // The handle to give to sync services.
  readonly store: SyncStore;
  // Makes every later call on `store` reject with SyncStoreDetachedError and returns
  // the underlying store, which the caller then closes.
  detach(): SyncStore;
}

export function createDetachableSyncStore(target: SyncStore): DetachableSyncStore {
  let detached = false;
  const store = new Proxy(target, {
    get(object, property, receiver) {
      const value: unknown = Reflect.get(object, property, receiver);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]): unknown => {
        if (detached) {
          if (property === "setCorruptionListener") {
            return undefined;
          }
          return Promise.reject(new SyncStoreDetachedError());
        }
        return (value as (...callArgs: unknown[]) => unknown).apply(object, args);
      };
    },
  });
  return {
    store,
    detach(): SyncStore {
      detached = true;
      return target;
    },
  };
}
