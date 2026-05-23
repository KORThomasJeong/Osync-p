import type { OsyncAuthFacade } from "./auth-facade";
import type { OsyncSyncFacade } from "./sync-facade";
import type { OsyncVaultFacade } from "./vault-facade";

/**
 * Aggregate settings surface composed of the three domain facades:
 * `OsyncAuthFacade`, `OsyncVaultFacade`, and `OsyncSyncFacade`.
 *
 * Existing call sites that depend on the wide controller continue to
 * compile unchanged; new settings panels should depend on the narrowest
 * facade(s) they actually need instead of this aggregate.
 */
export interface OsyncSettingsController
  extends OsyncAuthFacade,
    OsyncVaultFacade,
    OsyncSyncFacade {}
