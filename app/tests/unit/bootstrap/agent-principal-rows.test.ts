// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/agent-principal-rows`
 * Purpose: Three defects of one identity gap (task.0144), driven through the REAL agent authority and the REAL contribution service; only the
 *   SQL tag and the port are fakes.
 *   1. Registration wrote a user and a key but no `agent_principals` row, so a fresh AI read as a human. `registerAgent` writes both in one
 *      transaction: a failed principal write rolls the user back.
 *   2. Kind must come from that row alone: `principalKind` answers `agent` for a user with a row and `human` for one without.
 *   3. The knowledge merge and close gate used the repo-spec wallet list on the session's own wallet, a second admin check. It now runs
 *      `agentAuthority.adminCheck` on the user id, so a non-admin wallet is denied and a listed wallet is allowed, for any credential.
 * Scope: No database, no network.
 * Invariants: ONE_PRINCIPAL_WRITER, KIND_IS_THE_ROW, ONE_ADMIN_CHECK.
 * Side-effects: none
 */

import { CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
import {
  type ContributionService,
  createContributionService,
  NodeAdminRequiredError,
} from "@cogni/knowledge-store";
import { describe, expect, it, vi } from "vitest";

import { type AgentAuthoritySql, createAgentToolAuthority } from "@/bootstrap/agent-authority";
import { createAdminCheckNodeAdminAuthority } from "@/bootstrap/node-admin-gate";

const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/** `begin` buffers a transaction's statements and keeps them only when the callback resolves (a throw is a rollback). */
function fakeSql(opts: { failOn?: string; marked?: Set<string>; wallets?: Record<string, string[]> } = {}) {
  const committed: string[] = [];
  const run = (log: string[]) =>
    (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (opts.failOn && text.includes(opts.failOn)) throw new Error("write refused");
      if (text.includes("FROM agent_principals WHERE user_id"))
        return opts.marked?.has(String(values[0])) ? [{ marked: 1 }] : [];
      if (text.includes("FROM user_bindings"))
        return (opts.wallets?.[String(values[0])] ?? []).map((external_id) => ({ external_id }));
      log.push(text.replace(/\s+/g, " ").trim());
      return [];
    }) as never;
  const sql = run(committed) as AgentAuthoritySql;
  (sql as unknown as { begin: unknown }).begin = async (fn: (tx: unknown) => Promise<unknown>) => {
    const pending: string[] = [];
    const result = await fn(run(pending));
    committed.push(...pending);
    return result;
  };
  return { sql, committed };
}

const nodeAdmin = (listed: string[]) => ({
  check: async (actor: { walletAddress?: string | null }) =>
    actor.walletAddress && listed.includes(actor.walletAddress)
      ? ({ ok: true } as const)
      : ({ ok: false, errorCode: "authz_denied" } as const),
});

const authorityOver = (sql: AgentAuthoritySql, listed: string[] = []) =>
  createAgentToolAuthority({ sql, nodeAdmin: nodeAdmin(listed), log: quiet as never, toolBundle: CORE_TOOL_BUNDLE as never });

describe("registration writes the principal row (task.0144)", () => {
  it("writes the user and an external agent_principals row together", async () => {
    const { sql, committed } = fakeSql();
    await authorityOver(sql).registerAgent({ userId: "agent-1", name: "Helper" });
    expect(committed).toHaveLength(2);
    expect(committed[0]).toContain("INSERT INTO users");
    expect(committed[1]).toContain("INSERT INTO agent_principals");
    expect(committed[1]).toContain("'external'");
  });

  it("a failed principal write leaves no user behind: an AI is never a user without a kind", async () => {
    const { sql, committed } = fakeSql({ failOn: "INSERT INTO agent_principals" });
    await expect(authorityOver(sql).registerAgent({ userId: "agent-1", name: "Helper" })).rejects.toThrow();
    expect(committed).toEqual([]);
  });
});

describe("kind is read from the principal row alone", () => {
  it("a user with a row is an agent and a user without one is a human", async () => {
    const authority = authorityOver(fakeSql({ marked: new Set(["agent-1"]) }).sql);
    expect(await authority.principalKind("agent-1")).toBe("agent");
    expect(await authority.principalKind("human-1")).toBe("human");
  });
});

describe("the knowledge merge and close gate is the one admin check", () => {
  const ADMIN_WALLET = "0xAdmin";
  const port = () => ({
    getById: vi.fn(async () => ({ state: "open", principalId: "someone-else", principalKind: "agent" })),
    touchedIds: vi.fn(async () => ({ headCommit: "h1", knowledgeIds: ["k1"], citations: [] })),
    merge: vi.fn(async () => ({ commitHash: "m1" })),
    close: vi.fn(async () => undefined),
  });
  const wiring = () => {
    const { sql } = fakeSql({ wallets: { "admin-user": [ADMIN_WALLET], "other-user": ["0xNotListed"], "no-wallet": [] } });
    const authority = authorityOver(sql, [ADMIN_WALLET]);
    const p = port();
    const service: ContributionService = createContributionService({
      port: p as never,
      canMergeKnowledge: () => true,
      rateLimit: { maxOpenPerPrincipal: 10 },
      gates: [],
      nodeAdmin: createAdminCheckNodeAdminAuthority(() => authority.adminCheck),
    });
    return { service, p };
  };
  // A bearer principal (kind agent) and a session user pass the same gate: the credential is not the question.
  const asUser = (id: string, kind: "agent" | "user") => ({ principal: { id, kind }, actor: { userId: id, walletAddress: null } });

  it("denies a user whose bound wallet is not listed, and merges nothing", async () => {
    const { service, p } = wiring();
    const err = await service.merge({ contributionId: "c1", ...asUser("other-user", "user") }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeAdminRequiredError);
    expect((err as NodeAdminRequiredError).status).toBe(403);
    expect(p.merge).not.toHaveBeenCalled();
  });

  it("denies a user with no bound wallet", async () => {
    const { service, p } = wiring();
    await expect(service.merge({ contributionId: "c1", ...asUser("no-wallet", "agent") })).rejects.toBeInstanceOf(NodeAdminRequiredError);
    expect(p.merge).not.toHaveBeenCalled();
  });

  it("allows a user whose bound wallet is listed, session or bearer", async () => {
    const { service, p } = wiring();
    await expect(service.merge({ contributionId: "c1", ...asUser("admin-user", "agent") })).resolves.toEqual({ commitHash: "m1" });
    await expect(service.merge({ contributionId: "c1", ...asUser("admin-user", "user") })).resolves.toEqual({ commitHash: "m1" });
    expect(p.merge).toHaveBeenCalledTimes(2);
  });

  it("closing another principal's inbox runs the same check", async () => {
    const { service, p } = wiring();
    await expect(service.close({ contributionId: "c1", reason: "no", ...asUser("other-user", "user") })).rejects.toBeInstanceOf(NodeAdminRequiredError);
    expect(p.close).not.toHaveBeenCalled();
    await service.close({ contributionId: "c1", reason: "no", ...asUser("admin-user", "user") });
    expect(p.close).toHaveBeenCalledTimes(1);
  });
});
