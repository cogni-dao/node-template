// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/sandbox/tests/push-token`
 * Purpose: Guards the defects of the sandbox push-token provider: an operator outage that adds the mint timeout to
 *   every call or drops a still-valid token, and a token re-minted on every call.
 * Scope: Fake fetch and clock; no network.
 * Side-effects: none
 * Links: src/push-token.ts, https://node-template.cognidao.org/knowledge/node-ai-push-token
 */

import { describe, expect, it, vi } from "vitest";

import { createSandboxPushTokenEnv, SANDBOX_PUSH_TOKEN_EVENT } from "../src/index";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const onWarn = vi.fn();
const fleet = { operatorKey: "op-key", operatorUrl: "https://operator.test", nodeSlug: "node-x", onWarn };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("createSandboxPushTokenEnv", () => {
  it("reuses one fleet token until 20 minutes before expiry, then mints again", async () => {
    let now = T0;
    const fetchImpl = vi.fn(async () => json(200, { token: "ghs_fleet", expiresAt: "2026-01-01T01:00:00Z" }));
    const provider = createSandboxPushTokenEnv({ ...fleet, fetch: fetchImpl as typeof fetch, now: () => now });

    await provider();
    now = T0 + 39 * 60_000;
    await provider();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now = T0 + 41 * 60_000;
    await provider();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("after a failed mint, calls run with no token and skip the operator for 60 seconds", async () => {
    let now = T0;
    const fetchImpl = vi.fn(async () => json(503, { errorCode: "authz_unavailable" }));
    const provider = createSandboxPushTokenEnv({ ...fleet, fetch: fetchImpl as typeof fetch, now: () => now });

    expect(await provider()).toEqual({});
    now = T0 + 30_000;
    expect(await provider()).toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now = T0 + 61_000;
    await provider();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps handing out the cached token while it is unexpired when a refresh fails", async () => {
    let now = T0;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(200, { token: "ghs_fleet", expiresAt: "2026-01-01T01:00:00Z" }))
      .mockResolvedValue(json(503, { errorCode: "authz_unavailable" }));
    const provider = createSandboxPushTokenEnv({ ...fleet, fetch: fetchImpl as typeof fetch, now: () => now });

    await provider();
    now = T0 + 45 * 60_000;
    expect(await provider()).toEqual({ GH_TOKEN: "ghs_fleet" });
    now = T0 + 61 * 60_000;
    expect(await provider()).toEqual({});
  });

  it("reports a missing key once by error code, with no token, and runs the call without one", async () => {
    onWarn.mockClear();
    const provider = createSandboxPushTokenEnv({ ...fleet, operatorKey: undefined });
    expect(await provider()).toEqual({});
    expect(await provider()).toEqual({});
    expect(onWarn).toHaveBeenCalledOnce();
    expect(onWarn).toHaveBeenCalledWith({ adapter: "none", errorCode: "no_push_credential" });
    expect(SANDBOX_PUSH_TOKEN_EVENT).toBe("adapter.sandbox.push_token");
  });
});
