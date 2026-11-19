// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/agent-authority-connection-loss`
 * Purpose: bug.0062: a pooled Postgres connection that died on the network path made the tool guard deny a granted call
 *   (`authz_unavailable`). The guard's read now runs once more on a fresh connection; any other failure still fails closed at once.
 * Scope: No database, no network; only the SQL tag is fake.
 * Side-effects: none
 */

import { CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
import { describe, expect, it, vi } from "vitest";

import { type AgentAuthoritySql, createAgentToolAuthority } from "@/bootstrap/agent-authority";

const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function authorityWith(failures: unknown[]) {
  const begin = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const failure = failures.shift();
    if (failure) throw failure;
    return fn((async () => []) as never);
  });
  const sql = Object.assign((async () => []) as never, { begin }) as AgentAuthoritySql;
  const authority = createAgentToolAuthority({
    sql,
    nodeAdmin: { check: async () => ({ ok: false, errorCode: "authz_denied" }) as const },
    log: quiet as never,
    toolBundle: CORE_TOOL_BUNDLE,
  });
  return { begin, withStore: authority.guardDeps.withStore };
}

describe("tool guard store read (bug.0062)", () => {
  it("runs once more when its connection closes, and answers from the fresh connection", async () => {
    const { begin, withStore } = authorityWith([Object.assign(new Error("closed"), { code: "CONNECTION_CLOSED" })]);
    await expect(withStore(async () => "held")).resolves.toBe("held");
    expect(begin).toHaveBeenCalledTimes(2);
  });

  it("fails at once on any other error", async () => {
    const { begin, withStore } = authorityWith([Object.assign(new Error("denied"), { code: "42501" })]);
    await expect(withStore(async () => "held")).rejects.toThrow("denied");
    expect(begin).toHaveBeenCalledTimes(1);
  });
});
