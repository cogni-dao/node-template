// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/knowledge-merge-one-admin-check`
 * Purpose: The defect (task.0144): merge was a session-only act, and a bearer needed a scope or role row on top of the admin check, so the same approver wallet
 *   merged by session but not by bearer. Merge is now a pure admin door: the one `agentAuthority.adminCheck` on the caller's own user id, no scope, no role row.
 * Scope: The REAL merge route (real wrapper, real handler), the REAL contribution service and the REAL agent authority; only the SQL tag, the session
 *   resolver and the contribution port are fakes. No database.
 * Invariants: ONE_ADMIN_CHECK, SAME_DOOR (a session and a bearer get the same answer), DENY_BY_DEFAULT (the bearer reaches the service).
 * Side-effects: none
 */

import { CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
import { createContributionService } from "@cogni/knowledge-store";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type AgentAuthoritySql, createAgentToolAuthority } from "@/bootstrap/agent-authority";
import { createAdminCheckNodeAdminAuthority } from "@/bootstrap/node-admin-gate";

const fake = vi.hoisted(() => ({ container: undefined as unknown, user: null as unknown }));
vi.mock("@/bootstrap/container", () => ({ getContainer: () => fake.container }));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn(async () => fake.user) }));

import { POST } from "@/app/api/v1/knowledge/contributions/[id]/merge/route";

const APPROVER_WALLET = "0xApprover";
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
log.child.mockReturnValue(log);

/** user id -> bound wallets. No role row exists anywhere: the door must not ask for one. */
const wallets: Record<string, string[]> = {
  "approver-user": [APPROVER_WALLET],
  "other-user": ["0xNotListed"],
};
const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join("?");
  if (text.includes("FROM user_bindings")) return (wallets[String(values[0])] ?? []).map((external_id) => ({ external_id }));
  return [];
}) as unknown as AgentAuthoritySql;
(sql as unknown as { begin: unknown }).begin = async (fn: (t: unknown) => Promise<unknown>) => fn(sql);

const port = {
  getById: vi.fn(async () => ({ state: "open", principalId: "someone", principalKind: "agent" })),
  touchedIds: vi.fn(async () => ({ headCommit: "h1", knowledgeIds: ["throwaway"], citations: [] })),
  merge: vi.fn(async () => ({ commitHash: "m1" })),
};

const merge = (id: string, via: "session" | "bearer") => {
  fake.user = { id, walletAddress: null, displayName: null, avatarColor: null, via };
  return POST(
    new NextRequest("https://node.example/api/v1/knowledge/contributions/c1/merge", {
      method: "POST",
      headers: via === "bearer" ? { authorization: "Bearer cogni_ag_sk_v1_fake" } : {},
      body: "{}",
    }),
    { params: Promise.resolve({ id: "c1" }) } as never
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  log.child.mockReturnValue(log);
  const authority = createAgentToolAuthority({
    sql,
    nodeAdmin: { check: async (actor) => (actor.walletAddress === APPROVER_WALLET ? { ok: true } : { ok: false, errorCode: "authz_denied" }) },
    log: log as never,
    toolBundle: CORE_TOOL_BUNDLE as never,
  });
  fake.container = {
    log,
    config: { unhandledErrorPolicy: "respond_500" },
    clock: { now: () => "2026-11-18T00:00:00.000Z" },
    agentAuthority: authority,
    // The container's wiring: the kind-based gate is open, the one admin check decides.
    knowledgeContributionService: createContributionService({
      port: port as never,
      canMergeKnowledge: () => true,
      rateLimit: { maxOpenPerPrincipal: 10 },
      gates: [],
      nodeAdmin: createAdminCheckNodeAdminAuthority(() => authority.adminCheck),
    }),
  };
});

describe("merge is one admin door for every credential", () => {
  it("the same approver wallet merges a throwaway inbox (200) by session and by bearer, with no role row", async () => {
    const bySession = await merge("approver-user", "session");
    expect(bySession.status).toBe(200);
    const byBearer = await merge("approver-user", "bearer");
    expect(byBearer.status).toBe(200);
    expect(port.merge).toHaveBeenCalledTimes(2);
  });

  it("a bearer whose wallet is not listed gets 403 authz_denied and nothing merges; so does a session", async () => {
    const denied = await merge("other-user", "bearer");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ errorCode: "authz_denied" });
    expect((await merge("other-user", "session")).status).toBe(403);
    expect(port.merge).not.toHaveBeenCalled();
  });
});
