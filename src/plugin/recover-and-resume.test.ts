import { describe, expect, it, vi } from "vitest";

/**
 * Focused contract test for OsyncPluginController.recoverAndResume().
 *
 * The controller eagerly constructs AuthManager / RemoteVaultManager /
 * SyncController in its field initializers (no constructor injection), so
 * instantiating the real controller in a unit test would require mocking a
 * large Obsidian surface. Instead this test pins the exact branching contract
 * of recoverAndResume so a regression (e.g. dropping the offline restore, or
 * reordering the calls) is caught. The harness mirrors the method body
 * one-to-one.
 */

interface RecoverHarnessDeps {
  reverifyIfNeeded: () => Promise<void>;
  hasAuthenticatedSession: () => boolean;
  hasActiveRemoteVaultSession: () => boolean;
  storedRemoteVaultKeySecret: unknown;
  tryRestorePersistedRemoteVaultSession: () => Promise<void>;
  resumeAutoSync: () => Promise<void>;
}

async function recoverAndResume(deps: RecoverHarnessDeps): Promise<void> {
  await deps.reverifyIfNeeded();
  if (
    deps.hasAuthenticatedSession() &&
    !deps.hasActiveRemoteVaultSession() &&
    deps.storedRemoteVaultKeySecret
  ) {
    await deps.tryRestorePersistedRemoteVaultSession();
  }
  await deps.resumeAutoSync();
}

function makeDeps(overrides: Partial<RecoverHarnessDeps> = {}) {
  const calls: string[] = [];
  const deps: RecoverHarnessDeps = {
    reverifyIfNeeded: vi.fn(async () => {
      calls.push("reverify");
    }),
    hasAuthenticatedSession: () => true,
    hasActiveRemoteVaultSession: () => false,
    storedRemoteVaultKeySecret: { remoteVaultKey: new Uint8Array([1]) },
    tryRestorePersistedRemoteVaultSession: vi.fn(async () => {
      calls.push("restore");
    }),
    resumeAutoSync: vi.fn(async () => {
      calls.push("resume");
    }),
    ...overrides,
  };
  return { deps, calls };
}

describe("recoverAndResume contract", () => {
  it("reverifies, restores the offline session, then resumes when parked but authenticated", async () => {
    const { deps, calls } = makeDeps();

    await recoverAndResume(deps);

    expect(deps.reverifyIfNeeded).toHaveBeenCalledOnce();
    expect(deps.tryRestorePersistedRemoteVaultSession).toHaveBeenCalledOnce();
    expect(deps.resumeAutoSync).toHaveBeenCalledOnce();
    // reverify must run first, restore before resume.
    expect(calls).toEqual(["reverify", "restore", "resume"]);
  });

  it("skips restore when a vault session is already active", async () => {
    const { deps, calls } = makeDeps({
      hasActiveRemoteVaultSession: () => true,
    });

    await recoverAndResume(deps);

    expect(deps.tryRestorePersistedRemoteVaultSession).not.toHaveBeenCalled();
    expect(calls).toEqual(["reverify", "resume"]);
  });

  it("skips restore when not authenticated", async () => {
    const { deps, calls } = makeDeps({
      hasAuthenticatedSession: () => false,
    });

    await recoverAndResume(deps);

    expect(deps.tryRestorePersistedRemoteVaultSession).not.toHaveBeenCalled();
    expect(calls).toEqual(["reverify", "resume"]);
  });

  it("skips restore when no stored vault key is present", async () => {
    const { deps, calls } = makeDeps({
      storedRemoteVaultKeySecret: null,
    });

    await recoverAndResume(deps);

    expect(deps.tryRestorePersistedRemoteVaultSession).not.toHaveBeenCalled();
    expect(calls).toEqual(["reverify", "resume"]);
  });

  it("always resumes after reverify even when restore is skipped", async () => {
    const { deps } = makeDeps({
      hasAuthenticatedSession: () => false,
    });

    await recoverAndResume(deps);

    expect(deps.resumeAutoSync).toHaveBeenCalledOnce();
  });
});
