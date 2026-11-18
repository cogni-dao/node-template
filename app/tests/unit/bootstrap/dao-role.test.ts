// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/dao-role`
 * Purpose: A passed DAO grant:role / revoke:role vote writes and closes exactly one role row, with the DAO as approver.
 * Scope: The node's role application over the package's memory store (same semantics as the Postgres adapter). No network.
 * Side-effects: none
 * Links: src/bootstrap/dao-role.ts
 * @public
 */

import { COGNI_SYSTEM_PRINCIPAL_USER_ID } from "@cogni/node-shared";
import { describe, expect, it } from "vitest";

import { AgentRolesError } from "@cogni/agent-grants";
import { applyDaoRole } from "@/bootstrap/dao-role";
import { memoryStore } from "../../../../packages/agent-grants/tests/memory-store";

const AI = "ai-user-1";
const base = {
  principalSlug: "node-ai",
  scope: "work_item:transition",
  declaredScopes: ["work_item:transition"],
  scopeKinds: { "work_item:transition": "node" as const, "profile:read": "account" as const },
  signalAtMs: Date.now() + 60_000,
};
const store = () => memoryStore({ principals: { "node-ai": AI } });

describe("bootstrap/dao-role", () => {
  it("grant writes exactly one live row whose approver is the DAO principal", async () => {
    const s = store();
    const r = await applyDaoRole(s, { ...base, action: "grant" });
    expect(r.changed).toBe(true);
    expect(s.roles).toHaveLength(1);
    expect(s.roles[0]).toMatchObject({ principal: AI, scope: base.scope, approvedBy: COGNI_SYSTEM_PRINCIPAL_USER_ID, revoked: false });
    expect(await s.hasLiveRole(AI, base.scope)).toBe(true);
  });

  it("replaying the same grant is a no-op and writes no second row", async () => {
    const s = store();
    await applyDaoRole(s, { ...base, action: "grant" });
    const again = await applyDaoRole(s, { ...base, action: "grant" });
    expect(again.changed).toBe(false);
    expect(s.roles).toHaveLength(1);
  });

  it("revoke closes the live row, and replaying it changes nothing", async () => {
    const s = store();
    await applyDaoRole(s, { ...base, action: "grant" });
    expect((await applyDaoRole(s, { ...base, action: "revoke" })).changed).toBe(true);
    expect(await s.hasLiveRole(AI, base.scope)).toBe(false);
    expect((await applyDaoRole(s, { ...base, action: "revoke" })).changed).toBe(false);
  });

  it("an undeclared scope is refused and writes no row", async () => {
    const s = store();
    await expect(
      applyDaoRole(s, { ...base, scope: "vcs:merge_pr", action: "grant" })
    ).rejects.toMatchObject({ code: "invalid_scope" });
    expect(s.roles).toHaveLength(0);
  });

  it("an unknown principal is refused, not created", async () => {
    const s = store();
    const err = await applyDaoRole(s, { ...base, principalSlug: "nobody", action: "grant" }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentRolesError);
    expect(s.roles).toHaveLength(0);
  });

  it("a DAO-signalled account-kind scope is refused as wrong_kind and writes no row", async () => {
    const s = store();
    await expect(
      applyDaoRole(s, { ...base, scope: "profile:read", declaredScopes: ["profile:read"], action: "grant" })
    ).rejects.toMatchObject({ code: "wrong_kind" });
    expect(s.roles).toHaveLength(0);
  });

  describe("ordering by chain time", () => {
    // Each signal is processed shortly after its block: chain time t, store clock t + 100.
    const at = (s: ReturnType<typeof store>, chainMs: number, action: "grant" | "revoke") => {
      s.clock.now = chainMs + 100;
      return applyDaoRole(s, { ...base, action, signalAtMs: chainMs });
    };

    it("grant A, revoke B, then a redelivered A leaves the role Off", async () => {
      const s = store();
      await at(s, 1000, "grant");
      await at(s, 2000, "revoke");
      const replay = await at(s, 1000, "grant");
      expect(replay).toMatchObject({ changed: false, stale: true });
      expect(await s.hasLiveRole(AI, base.scope)).toBe(false);
      expect(s.roles).toHaveLength(1);
    });

    it("a redelivered older revoke does not turn off a later grant", async () => {
      const s = store();
      await at(s, 1000, "grant");
      await at(s, 2000, "revoke");
      await at(s, 3000, "grant");
      const replay = await at(s, 2000, "revoke");
      expect(replay).toMatchObject({ changed: false, stale: true });
      expect(await s.hasLiveRole(AI, base.scope)).toBe(true);
    });

    it("a newer grant after a revoke is applied", async () => {
      const s = store();
      await at(s, 1000, "grant");
      await at(s, 2000, "revoke");
      expect((await at(s, 3000, "grant")).changed).toBe(true);
      expect(await s.hasLiveRole(AI, base.scope)).toBe(true);
    });
  });
});
