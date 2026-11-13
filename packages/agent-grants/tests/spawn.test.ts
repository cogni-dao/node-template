// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Spawn grants over a memory store with the Postgres adapter's semantics: a person issues a one-time grant, the agent redeems it, the agent's owner
 * is the issuer. Rows: redeem happy path, reuse refused, expired refused, idempotent retry, cap, owner sees only own agents, another person cannot
 * revoke your agent, an outage is 503 and never a refusal, the grant is never stored in clear.
 */

import { describe, expect, it } from "vitest";
import {
  CredentialStoreUnavailableError,
  hashAgentKey,
  isWellFormedRevocableKey,
  isWellFormedSpawnGrant,
  issueSpawnGrant,
  listOwnedAgents,
  MAX_PENDING_SPAWN_GRANTS,
  redeemSpawnGrant,
  revokeOwnedAgentKeys,
  SPAWN_GRANT_PREFIX,
  SPAWN_GRANT_TTL_SEC,
} from "../src/credentials";
import { memorySpawnStore } from "./spawn-memory-store";

const world = () => memorySpawnStore({ users: { alice: {}, bob: {}, "agent-x": { agent: true } } });
const free = async () => false;
const issue = async (w: ReturnType<typeof world>, who = "alice") => {
  const r = await issueSpawnGrant(w.spawn, { issuerUserId: who });
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r;
};
const redeem = (w: ReturnType<typeof world>, grant: string, name = "Helper bot", newUserId = "agent-1", nameTaken = free) =>
  redeemSpawnGrant(w.spawn, { grant, name, newUserId, nameTaken });

describe("spawn grant: format and storage", () => {
  it("is 24 hours, well formed, and the store never sees it in clear", async () => {
    const w = world();
    const g = await issue(w);
    expect(isWellFormedSpawnGrant(g.grant)).toBe(true);
    expect(g.grant.startsWith(SPAWN_GRANT_PREFIX)).toBe(true);
    expect(Date.parse(g.expiresAt) - w.clock.now).toBe(SPAWN_GRANT_TTL_SEC * 1000);
    expect(isWellFormedSpawnGrant("cogni_sg_v1_short")).toBe(false);
    expect(isWellFormedSpawnGrant(g.grant.replace(SPAWN_GRANT_PREFIX, "x"))).toBe(false);
    // The hash, not the grant, is what the store holds: a grant looked up by its hash resolves.
    expect(await w.spawn.grantState(await hashAgentKey(g.grant))).toEqual({ state: "open" });
  });
});

describe("redeem", () => {
  it("happy path: the agent is created, owned by the issuer, and holds a pending revocable key", async () => {
    const w = world();
    const g = await issue(w);
    const r = await redeem(w, g.grant);
    expect(r).toMatchObject({ ok: true, userId: "agent-1", ownerUserId: "alice", retry: false });
    if (!r.ok) throw new Error("unreachable");
    expect(isWellFormedRevocableKey(r.apiKey)).toBe(true);
    expect(await listOwnedAgents(w.spawn, { ownerUserId: "alice" })).toEqual([
      expect.objectContaining({ agentUserId: "agent-1", name: "Helper bot", keyState: "pending" }),
    ]);
  });

  it("a malformed or unknown grant is refused as unknown, with no store write", async () => {
    const w = world();
    expect(await redeem(w, "nope")).toEqual({ ok: false, reason: "unknown" });
    expect(await redeem(w, `${SPAWN_GRANT_PREFIX}${"a".repeat(43)}`)).toEqual({ ok: false, reason: "unknown" });
    expect(w.keys).toHaveLength(0);
  });

  it("reuse is refused once the agent confirmed its key, and a different agent can never use the spent grant", async () => {
    const w = world();
    const g = await issue(w);
    const first = await redeem(w, g.grant);
    if (!first.ok) throw new Error("unreachable");
    w.confirm(first.userId);
    expect(await redeem(w, g.grant)).toEqual({ ok: false, reason: "already_redeemed" });
    expect(await redeem(w, g.grant, "Other bot", "agent-2")).toEqual({ ok: false, reason: "already_redeemed" });
    expect((await listOwnedAgents(w.spawn, { ownerUserId: "alice" })).map((a) => a.name)).toEqual(["Helper bot"]);
  });

  it("a retry before confirm is idempotent: same agent, fresh pending key, the earlier key superseded, no second agent", async () => {
    const w = world();
    const g = await issue(w);
    const first = await redeem(w, g.grant);
    const second = await redeem(w, g.grant, "Helper bot", "agent-2"); // the node's new id is ignored on a retry
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(second).toMatchObject({ userId: first.userId, retry: true });
    expect(second.apiKey).not.toBe(first.apiKey);
    expect(w.keys.filter((k) => k.reason === "superseded")).toHaveLength(1);
    expect(w.keys.filter((k) => !k.revoked)).toHaveLength(1);
    expect(await listOwnedAgents(w.spawn, { ownerUserId: "alice" })).toHaveLength(1);
  });

  it("REVOKE_IS_FINAL: the owner revokes a pending key (never confirmed); a retry with the same grant and name is refused and the agent stays unusable", async () => {
    const w = world();
    const g = await issue(w);
    const first = await redeem(w, g.grant, "Helper bot", "agent-1");
    if (!first.ok) throw new Error("unreachable");
    expect(await revokeOwnedAgentKeys(w.spawn, w.credentials, { ownerUserId: "alice", agentUserId: first.userId })).toEqual({ ok: true, revoked: 1 });
    expect(await redeem(w, g.grant, "Helper bot", "agent-2")).toEqual({ ok: false, reason: "already_redeemed" });
    expect(w.keys.filter((k) => !k.revoked)).toHaveLength(0);
    expect((await listOwnedAgents(w.spawn, { ownerUserId: "alice" })).map((a) => [a.agentUserId, a.keyState])).toEqual([["agent-1", "revoked"]]);
  });

  it("a retry with a different name is a spent grant, not a second agent", async () => {
    const w = world();
    const g = await issue(w);
    await redeem(w, g.grant);
    expect(await redeem(w, g.grant, "Renamed")).toEqual({ ok: false, reason: "already_redeemed" });
  });

  it("an expired grant is refused, after 24 hours, retry included", async () => {
    const w = world();
    const g = await issue(w);
    const first = await redeem(w, g.grant);
    expect(first.ok).toBe(true);
    const other = await issue(w, "bob");
    w.advance(SPAWN_GRANT_TTL_SEC + 1);
    expect(await redeem(w, g.grant)).toEqual({ ok: false, reason: "expired" });
    expect(await redeem(w, other.grant, "Late bot", "agent-9")).toEqual({ ok: false, reason: "expired" });
    expect(await listOwnedAgents(w.spawn, { ownerUserId: "bob" })).toEqual([]);
  });

  it("a taken name is refused before anything is written, and the grant stays usable with another name", async () => {
    const w = world();
    const g = await issue(w);
    const taken = async (name: string) => name === "node-ai";
    expect(await redeem(w, g.grant, "node-ai", "agent-1", taken)).toEqual({ ok: false, reason: "name_taken" });
    expect(w.keys).toHaveLength(0);
    expect((await redeem(w, g.grant, "Helper bot", "agent-1", taken)).ok).toBe(true);
  });
});

describe("issue", () => {
  it("caps pending grants at 5 per person; redeeming one or letting one expire frees a slot; another person is not counted", async () => {
    const w = world();
    const grants: string[] = [];
    for (let i = 0; i < MAX_PENDING_SPAWN_GRANTS; i++) grants.push((await issue(w)).grant);
    expect(await issueSpawnGrant(w.spawn, { issuerUserId: "alice" })).toEqual({ ok: false, reason: "too_many_pending" });
    expect((await issueSpawnGrant(w.spawn, { issuerUserId: "bob" })).ok).toBe(true);
    await redeem(w, grants[0] as string);
    expect((await issueSpawnGrant(w.spawn, { issuerUserId: "alice" })).ok).toBe(true);
    expect(await issueSpawnGrant(w.spawn, { issuerUserId: "alice" })).toEqual({ ok: false, reason: "too_many_pending" });
    w.advance(SPAWN_GRANT_TTL_SEC + 1);
    expect((await issueSpawnGrant(w.spawn, { issuerUserId: "alice" })).ok).toBe(true);
  });

  it("an agent cannot issue grants, and an unknown user cannot either", async () => {
    const w = world();
    expect(await issueSpawnGrant(w.spawn, { issuerUserId: "agent-x" })).toEqual({ ok: false, reason: "agent_issuer" });
    expect(await issueSpawnGrant(w.spawn, { issuerUserId: "ghost" })).toEqual({ ok: false, reason: "unknown_user" });
  });
});

describe("ownership", () => {
  it("the owner sees only their own agents", async () => {
    const w = world();
    await redeem(w, (await issue(w, "alice")).grant, "Alice bot", "a-1");
    await redeem(w, (await issue(w, "bob")).grant, "Bob bot", "b-1");
    expect((await listOwnedAgents(w.spawn, { ownerUserId: "alice" })).map((a) => a.name)).toEqual(["Alice bot"]);
    expect((await listOwnedAgents(w.spawn, { ownerUserId: "bob" })).map((a) => a.name)).toEqual(["Bob bot"]);
    expect(await listOwnedAgents(w.spawn, { ownerUserId: "nobody" })).toEqual([]);
  });

  it("the owner revokes their agent's keys; the agent shows revoked", async () => {
    const w = world();
    const r = await redeem(w, (await issue(w)).grant, "Alice bot", "a-1");
    if (!r.ok) throw new Error("unreachable");
    w.confirm(r.userId);
    expect(await revokeOwnedAgentKeys(w.spawn, w.credentials, { ownerUserId: "alice", agentUserId: "a-1" })).toEqual({ ok: true, revoked: 1 });
    expect((await listOwnedAgents(w.spawn, { ownerUserId: "alice" }))[0]?.keyState).toBe("revoked");
  });

  it("another person cannot revoke your agent: not_found, and the keys stay live", async () => {
    const w = world();
    const r = await redeem(w, (await issue(w)).grant, "Alice bot", "a-1");
    if (!r.ok) throw new Error("unreachable");
    w.confirm(r.userId);
    expect(await revokeOwnedAgentKeys(w.spawn, w.credentials, { ownerUserId: "bob", agentUserId: "a-1" })).toEqual({ ok: false, reason: "not_found" });
    expect(await revokeOwnedAgentKeys(w.spawn, w.credentials, { ownerUserId: "bob", agentUserId: "unknown" })).toEqual({ ok: false, reason: "not_found" });
    expect(w.keys.filter((k) => !k.revoked)).toHaveLength(1);
  });
});

describe("outage", () => {
  it("a store failure is CredentialStoreUnavailableError (503), never a refusal", async () => {
    const w = memorySpawnStore({ users: { alice: {} }, failing: true });
    await expect(issueSpawnGrant(w.spawn, { issuerUserId: "alice" })).rejects.toBeInstanceOf(CredentialStoreUnavailableError);
    await expect(listOwnedAgents(w.spawn, { ownerUserId: "alice" })).rejects.toBeInstanceOf(CredentialStoreUnavailableError);
    await expect(redeem(w, `${SPAWN_GRANT_PREFIX}${"a".repeat(43)}`)).rejects.toBeInstanceOf(CredentialStoreUnavailableError);
  });
});
