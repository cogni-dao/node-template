// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/layout/logout`
 * Purpose: Terminate the server session before disconnecting the local wallet.
 * Scope: Browser logout orchestration only. NextAuth owns cookie deletion; wagmi owns wallet state.
 * Invariants: SERVER_SESSION_FIRST, VERIFY_BEFORE_DISCONNECT, HARD_RELOAD_AFTER_LOGOUT.
 * Side-effects: IO (NextAuth HTTP, wallet disconnect, browser navigation)
 * Links: src/features/layout/components/UserAvatarMenu.tsx, docs/spec/authentication.md
 * @public
 */

import { getCsrfToken } from "next-auth/react";

export interface LogoutDependencies {
  readonly origin: string;
  readonly getCsrfToken: () => Promise<string | undefined>;
  readonly fetch: (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => Promise<Response>;
  readonly disconnect: () => Promise<void>;
  readonly navigate: (url: string) => void;
}

export class LogoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogoutError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(response: Response, label: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new LogoutError(`${label} returned an invalid response.`);
  }
}

function assertSignOutAccepted(payload: unknown, origin: string): void {
  if (!isRecord(payload) || typeof payload.url !== "string") {
    throw new LogoutError("Sign out was not acknowledged by the server.");
  }

  const resultUrl = new URL(payload.url, origin);
  if (
    resultUrl.pathname === "/api/auth/signout" &&
    resultUrl.searchParams.get("csrf") === "true"
  ) {
    throw new LogoutError("Sign out was rejected. Please try again.");
  }
}

function hasUser(payload: unknown): boolean {
  return isRecord(payload) && payload.user != null;
}

/**
 * End the authoritative NextAuth session, verify it is gone, then disconnect
 * wagmi and force a server-routed public-page reload.
 */
export async function terminateAuthenticatedBrowserSession(
  dependencies: LogoutDependencies
): Promise<void> {
  const csrfToken = await dependencies.getCsrfToken();
  if (!csrfToken) {
    throw new LogoutError("Could not start sign out. Please try again.");
  }

  const callbackUrl = new URL("/?signedOut=1", dependencies.origin).toString();
  const response = await dependencies.fetch("/api/auth/signout", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      csrfToken,
      callbackUrl,
      json: "true",
    }),
  });

  if (!response.ok) {
    throw new LogoutError("Sign out failed. Please try again.");
  }
  assertSignOutAccepted(
    await readJson(response, "Sign out"),
    dependencies.origin
  );

  const sessionResponse = await dependencies.fetch("/api/auth/session", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!sessionResponse.ok) {
    throw new LogoutError("Could not verify sign out. Please try again.");
  }

  const session = await readJson(sessionResponse, "Session verification");
  if (hasUser(session)) {
    throw new LogoutError("Your session is still active. Please retry sign out.");
  }

  await dependencies.disconnect();
  dependencies.navigate(new URL("/", dependencies.origin).toString());
}

export async function logoutBrowserSession(
  disconnect: () => Promise<void>
): Promise<void> {
  return terminateAuthenticatedBrowserSession({
    origin: window.location.origin,
    getCsrfToken,
    fetch: window.fetch.bind(window),
    disconnect,
    navigate: (url) => window.location.assign(url),
  });
}
