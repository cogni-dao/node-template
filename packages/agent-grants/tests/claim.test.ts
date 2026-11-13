// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/credentials` agent-initiated claim (task.5465, revision 5)
 * Purpose: An EXISTING ownerless agent starts a claim with its own key and gets a claim id (15 minutes, single use, bound to that agent). The signed-in person's click sets the owner,
 *   once, on the same principal. No secret travels through a human. An agent never owns, never owns itself, and a person owns at most 25.
 * Scope: Pure logic over the in-memory spawn store (same semantics as the SQL; the component test runs the SQL).
 * Side-effects: none
 */

import { describe, expect, it } from "vitest";
import { CLAIM_TTL_SEC, completeAgentClaim, MAX_OWNED_AGENTS, readAgentClaim, startAgentClaim } from "../src/credentials";
import { memorySpawnStore } from "./spawn-memory-store";

const world = () => memorySpawnStore({ users: { alice: {}, bob: {}, agentA: { agent: true }, agentB: { agent: true }, walleted: { wallet: true } }, internal: ["node-ai"] });
const start = (w: ReturnType<typeof world>, agentUserId = "agentA") => startAgentClaim(w.spawn, { agentUserId });

describe("start: the agent asks with its own key", () => {
  it("returns a claim id; a second start ends the first, so one is live", async () => {
    const w = world();
    const a = await start(w);
    const b = await start(w);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    if (a.ok && b.ok) {
      expect(a.claimId).not.toBe(b.claimId);
      expect(await readAgentClaim(w.spawn, { claimId: a.claimId })).toMatchObject({ state: "expired" });
      expect(await readAgentClaim(w.spawn, { claimId: b.claimId })).toMatchObject({ state: "open" });
    }
  });
  it("refuses an owned agent, an internal AI and a user with a wallet", async () => {
    const w = world();
    const c = await start(w);
    if (c.ok) await completeAgentClaim(w.spawn, { claimId: c.claimId, ownerUserId: "alice" });
    expect(await start(w)).toEqual({ ok: false, reason: "already_owned" });
    expect(await start(w, "node-ai")).toEqual({ ok: false, reason: "not_an_agent" });
    expect(await start(w, "walleted")).toEqual({ ok: false, reason: "not_an_agent" });
    expect(await start(w, "nobody")).toEqual({ ok: false, reason: "not_an_agent" });
  });
});

describe("complete: the person's click", () => {
  it("makes the agent the clicker's, once, and the same claim cannot be used again", async () => {
    const w = world();
    const c = await start(w);
    if (!c.ok) throw new Error("start");
    expect(await completeAgentClaim(w.spawn, { claimId: c.claimId, ownerUserId: "alice" })).toEqual({ ok: true, agentUserId: "agentA" });
    expect(w.ownedBy.get("agentA")).toBe("alice");
    expect(await completeAgentClaim(w.spawn, { claimId: c.claimId, ownerUserId: "bob" })).toEqual({ ok: false, reason: "used" });
    expect(w.ownedBy.get("agentA")).toBe("alice"); // owner set only where it was NULL
    expect(await readAgentClaim(w.spawn, { claimId: c.claimId })).toMatchObject({ state: "claimed" });
  });
  it("expires after 15 minutes", async () => {
    const w = world();
    const c = await start(w);
    if (!c.ok) throw new Error("start");
    w.advance(CLAIM_TTL_SEC + 1);
    expect(await completeAgentClaim(w.spawn, { claimId: c.claimId, ownerUserId: "alice" })).toEqual({ ok: false, reason: "expired" });
    expect(w.ownedBy.has("agentA")).toBe(false);
  });
  it("an agent cannot claim itself or another agent, and an unknown id changes nothing", async () => {
    const w = world();
    const c = await start(w);
    if (!c.ok) throw new Error("start");
    expect(await completeAgentClaim(w.spawn, { claimId: c.claimId, ownerUserId: "agentA" })).toEqual({ ok: false, reason: "owner_is_agent" });
    expect(await completeAgentClaim(w.spawn, { claimId: c.claimId, ownerUserId: "agentB" })).toEqual({ ok: false, reason: "owner_is_agent" });
    expect(await completeAgentClaim(w.spawn, { claimId: "00000000-0000-4000-8000-0000000000ff", ownerUserId: "alice" })).toEqual({ ok: false, reason: "unknown" });
    expect(await readAgentClaim(w.spawn, { claimId: "not-a-claim" })).toBeNull();
    expect(w.ownedBy.size).toBe(0);
  });
  it("a person owns at most 25 agents", async () => {
    const users: Record<string, { agent: boolean }> = { alice: { agent: false } as never };
    for (let i = 0; i < MAX_OWNED_AGENTS + 1; i += 1) users[`a${i}`] = { agent: true };
    const w = memorySpawnStore({ users });
    for (let i = 0; i < MAX_OWNED_AGENTS; i += 1) {
      const c = await startAgentClaim(w.spawn, { agentUserId: `a${i}` });
      if (!c.ok) throw new Error("start");
      expect((await completeAgentClaim(w.spawn, { claimId: c.claimId, ownerUserId: "alice" })).ok).toBe(true);
    }
    const last = await startAgentClaim(w.spawn, { agentUserId: `a${MAX_OWNED_AGENTS}` });
    if (!last.ok) throw new Error("start");
    expect(await completeAgentClaim(w.spawn, { claimId: last.claimId, ownerUserId: "alice" })).toEqual({ ok: false, reason: "too_many_agents" });
  });
  it("a store outage is a thrown unavailable error, never a refusal", async () => {
    const w = world();
    w.outage.failing = true;
    await expect(start(w)).rejects.toThrow();
  });
});
