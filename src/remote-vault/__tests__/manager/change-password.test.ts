import { describe, expect, it, vi } from "vitest";

import {
  computeVaultKeyFingerprint,
  createPasswordWrappedRemoteVaultKey,
  rewrapRemoteVaultKey,
  unwrapRemoteVaultKeyWithPassword,
} from "../../crypto";
import type { StoredRemoteVaultKeySecret } from "../../device-storage";
import {
  RemoteVaultPasswordChangeRejectedError,
  RemoteVaultPasswordChangedError,
  RemoteVaultPasswordIncorrectError,
  type ChangeVaultPasswordRequest,
  type RemoteVaultBootstrapResponse,
  type RemoteVaultKeyWrapperRecord,
} from "../../types";
import { createManager, remoteVaultSummary } from "./helpers";

const KDF_OVERRIDES = { memoryKiB: 8, iterations: 1, parallelism: 1 } as const;
const CURRENT_PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "tropical sunset over the lake";

async function bootstrapManagerWithSession(options: {
  savedVaults?: Array<StoredRemoteVaultKeySecret | null>;
  changeCalls?: Array<{
    vaultId: string;
    payload: ChangeVaultPasswordRequest;
  }>;
  changeImpl?: (
    vaultId: string,
    payload: ChangeVaultPasswordRequest,
  ) => Promise<RemoteVaultKeyWrapperRecord>;
  notify?: (message: string) => void;
}) {
  const wrapper = await createPasswordWrappedRemoteVaultKey(CURRENT_PASSWORD, {
    kdfOverrides: KDF_OVERRIDES,
  });
  const summary = remoteVaultSummary({ id: "vault-active", name: "Active" });

  const bootstrapResponse: RemoteVaultBootstrapResponse = {
    vault: summary,
    wrappers: [
      {
        id: "wrapper-1",
        vaultId: summary.id,
        keyVersion: 1,
        kind: "password",
        userId: "user-1",
        envelope: wrapper.envelope,
        createdAt: "2026-04-22T00:00:00.000Z",
        revokedAt: null,
      },
    ],
  };

  const changeCalls = options.changeCalls;
  const changeImpl = options.changeImpl;

  const manager = createManager({
    savedVaults: options.savedVaults,
    notify: options.notify,
    remoteVaultClient: {
      getRemoteVaultBootstrap: async () => bootstrapResponse,
      changeVaultPassword: async (_apiBaseUrl, _sessionToken, vaultId, payload) => {
        changeCalls?.push({ vaultId, payload });
        if (changeImpl) {
          return await changeImpl(vaultId, payload);
        }
        return {
          id: "wrapper-1",
          vaultId,
          keyVersion: payload.envelope.keyVersion,
          kind: "password",
          userId: "user-1",
          envelope: payload.envelope,
          createdAt: "2026-04-22T00:00:00.000Z",
          revokedAt: null,
        };
      },
    },
  });

  // Connect the manager via bootstrap so it has an active session.
  await manager.bootstrapRemoteVault({
    vaultId: summary.id,
    password: CURRENT_PASSWORD,
    initialSyncMode: "merge",
  });

  return { manager, remoteVaultKey: wrapper.remoteVaultKey };
}

describe("RemoteVaultManager changeVaultPassword", () => {
  it("re-wraps with the new password without rotating the vault key", async () => {
    const savedVaults: Array<StoredRemoteVaultKeySecret | null> = [];
    const changeCalls: Array<{
      vaultId: string;
      payload: ChangeVaultPasswordRequest;
    }> = [];
    const notify = vi.fn();

    const { manager, remoteVaultKey } = await bootstrapManagerWithSession({
      savedVaults,
      changeCalls,
      notify,
    });

    const sessionKeyBefore = manager.getActiveSession()?.remoteVaultKey;
    const savedKeyBefore = savedVaults[savedVaults.length - 1]?.remoteVaultKey;
    expect(sessionKeyBefore).toEqual(remoteVaultKey);

    await manager.changeVaultPassword(CURRENT_PASSWORD, NEW_PASSWORD);

    expect(changeCalls).toHaveLength(1);
    const call = changeCalls[0];
    expect(call?.vaultId).toBe("vault-active");
    expect(call?.payload.keyFingerprint).toBe(
      await computeVaultKeyFingerprint(remoteVaultKey),
    );

    // Envelope sent to server unwraps with new password back to the same vault key.
    const unwrapped = await unwrapRemoteVaultKeyWithPassword(
      NEW_PASSWORD,
      call!.payload.envelope,
    );
    expect(Array.from(unwrapped)).toEqual(Array.from(remoteVaultKey));

    // secretStorage must not have been touched after the password change.
    const savedKeyAfter = savedVaults[savedVaults.length - 1]?.remoteVaultKey;
    expect(savedKeyAfter).toEqual(savedKeyBefore);
    expect(manager.getActiveSession()?.remoteVaultKey).toEqual(remoteVaultKey);
    expect(notify).toHaveBeenCalledWith("Vault password changed on this device.");
  });

  it("throws RemoteVaultPasswordIncorrectError on wrong current password", async () => {
    const changeCalls: Array<{
      vaultId: string;
      payload: ChangeVaultPasswordRequest;
    }> = [];

    const { manager } = await bootstrapManagerWithSession({ changeCalls });

    await expect(
      manager.changeVaultPassword("definitely the wrong password", NEW_PASSWORD),
    ).rejects.toBeInstanceOf(RemoteVaultPasswordIncorrectError);

    expect(changeCalls).toHaveLength(0);
  });

  it("propagates fingerprint_mismatch from the server as RemoteVaultPasswordChangeRejectedError", async () => {
    const savedVaults: Array<StoredRemoteVaultKeySecret | null> = [];
    const savedBefore = savedVaults.slice();

    const { manager } = await bootstrapManagerWithSession({
      savedVaults,
      changeImpl: async () => {
        throw new RemoteVaultPasswordChangeRejectedError(
          "fingerprint_mismatch",
          "envelope wraps a different vault key; refusing to overwrite",
        );
      },
    });

    const sessionKeyBefore = manager.getActiveSession()?.remoteVaultKey;
    const savedAfterBootstrap = savedVaults[savedVaults.length - 1]?.remoteVaultKey;

    let thrown: unknown;
    try {
      await manager.changeVaultPassword(CURRENT_PASSWORD, NEW_PASSWORD);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RemoteVaultPasswordChangeRejectedError);
    expect((thrown as RemoteVaultPasswordChangeRejectedError).code).toBe(
      "fingerprint_mismatch",
    );

    // Session key and stored key must be untouched.
    expect(manager.getActiveSession()?.remoteVaultKey).toEqual(sessionKeyBefore);
    expect(savedVaults[savedVaults.length - 1]?.remoteVaultKey).toEqual(
      savedAfterBootstrap,
    );
    // No additional saves happened beyond the bootstrap save.
    expect(savedVaults.length).toBe(savedBefore.length + 1);
  });

  it("throws RemoteVaultPasswordChangedError when bootstrap unwrap fails (stale password)", async () => {
    // Simulate "another device changed the password": the live wrapper is
    // sealed with NEW_PASSWORD, but this device is bootstrapping with the old.
    const newKey = new Uint8Array(32);
    newKey.set([1, 2, 3, 4, 5]);
    const liveEnvelope = await rewrapRemoteVaultKey(newKey, NEW_PASSWORD, {
      kdfOverrides: KDF_OVERRIDES,
    });
    const summary = remoteVaultSummary({ id: "vault-stale", name: "Stale" });

    const manager = createManager({
      remoteVaultClient: {
        getRemoteVaultBootstrap: async (): Promise<RemoteVaultBootstrapResponse> => ({
          vault: summary,
          wrappers: [
            {
              id: "wrapper-1",
              vaultId: summary.id,
              keyVersion: 1,
              kind: "password",
              userId: "user-1",
              envelope: liveEnvelope,
              createdAt: "2026-04-22T00:00:00.000Z",
              revokedAt: null,
            },
          ],
        }),
      },
    });

    await expect(
      manager.bootstrapRemoteVault({
        vaultId: summary.id,
        password: CURRENT_PASSWORD,
        initialSyncMode: "merge",
      }),
    ).rejects.toBeInstanceOf(RemoteVaultPasswordChangedError);
  });
});
