// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/layout/logout`
 * Purpose: Regression coverage for server-first logout and account switching.
 * Scope: Pure orchestration with an in-memory auth server. No browser or network IO.
 * Invariants: Session deletion is verified before wallet disconnect or navigation.
 * Side-effects: none
 * Links: src/features/layout/logout.ts, bug.5045
 */

import { describe, expect, it, vi } from "vitest";

import {
  LogoutError,
  terminateAuthenticatedBrowserSession,
  type LogoutDependencies,
} from "@/features/layout/logout";

interface TestSession {
  readonly user: {
    readonly id: string;
    readonly walletAddress: string;
    readonly name?: string;
    readonly email?: string;
  };
}

function authHarness(initialSession: TestSession | null, rejectSignOut = false) {
  let session = initialSession;
  const calls: string[] = [];
  const disconnect = vi.fn(async () => {
    calls.push("disconnect");
  });
  const navigate = vi.fn(() => calls.push("navigate"));

  const dependencies: LogoutDependencies = {
    origin: "https://node.example",
    getCsrfToken: vi.fn(async () => "valid-csrf"),
    fetch: vi.fn(async (input) => {
      const path = String(input);
      calls.push(path);
      if (path === "/api/auth/signout") {
        if (rejectSignOut) {
          return Response.json({
            url: "https://node.example/api/auth/signout?csrf=true",
          });
        }
        session = null;
        return Response.json({ url: "https://node.example/?signedOut=1" });
      }
      if (path === "/api/auth/session") {
        return Response.json(session ?? {});
      }
      throw new Error(`Unexpected request: ${path}`);
    }),
    disconnect,
    navigate,
  };

  return {
    calls,
    dependencies,
    disconnect,
    navigate,
    session: () => session,
    signIn: (nextSession: TestSession) => {
      session = nextSession;
    },
  };
}

const siweSession: TestSession = {
  user: {
    id: "user-wallet-a",
    walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
};

describe("terminateAuthenticatedBrowserSession", () => {
  it("terminates a direct SIWE session before disconnecting the wallet", async () => {
    const harness = authHarness(siweSession);

    await terminateAuthenticatedBrowserSession(harness.dependencies);

    expect(harness.session()).toBeNull();
    expect(harness.calls).toEqual([
      "/api/auth/signout",
      "/api/auth/session",
      "disconnect",
      "navigate",
    ]);
  });

  it("terminates the same canonical session after an OAuth account is linked", async () => {
    const linkedSession: TestSession = {
      user: {
        ...siweSession.user,
        name: "linked-github-user",
        email: "linked@example.test",
      },
    };
    const harness = authHarness(linkedSession);

    await terminateAuthenticatedBrowserSession(harness.dependencies);

    expect(harness.session()).toBeNull();
    expect(harness.disconnect).toHaveBeenCalledOnce();
    expect(harness.navigate).toHaveBeenCalledWith("https://node.example/");
  });

  it("supports account switching only after the old server session is gone", async () => {
    const harness = authHarness(siweSession);

    await terminateAuthenticatedBrowserSession(harness.dependencies);
    harness.signIn({
      user: {
        id: "user-wallet-b",
        walletAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    });

    expect(harness.disconnect).toHaveBeenCalledOnce();
    expect(harness.session()?.user.id).toBe("user-wallet-b");
    expect(harness.session()?.user.id).not.toBe(siweSession.user.id);
  });

  it("keeps the wallet connected when NextAuth rejects sign out", async () => {
    const harness = authHarness(siweSession, true);

    await expect(
      terminateAuthenticatedBrowserSession(harness.dependencies)
    ).rejects.toEqual(
      new LogoutError("Sign out was rejected. Please try again.")
    );

    expect(harness.session()).toEqual(siweSession);
    expect(harness.disconnect).not.toHaveBeenCalled();
    expect(harness.navigate).not.toHaveBeenCalled();
  });

  it("does not disconnect if session verification still returns a user", async () => {
    const harness = authHarness(siweSession);
    vi.mocked(harness.dependencies.fetch).mockImplementation(
      async (input) => {
        if (String(input) === "/api/auth/signout") {
          return Response.json({ url: "https://node.example/?signedOut=1" });
        }
        return Response.json(siweSession);
      }
    );

    await expect(
      terminateAuthenticatedBrowserSession(harness.dependencies)
    ).rejects.toEqual(
      new LogoutError("Your session is still active. Please retry sign out.")
    );
    expect(harness.disconnect).not.toHaveBeenCalled();
    expect(harness.navigate).not.toHaveBeenCalled();
  });
});
