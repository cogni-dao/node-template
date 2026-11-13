// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { CredentialPolicy, CredentialStore, GrantState, OwnedAgent, RedeemResult, SpawnStore } from "../src/credentials";

interface Grant {
  issuer: string;
  tokenHash: string;
  expiresAt: number;
  redeemedUserId: string | null;
}
interface Key {
  id: string;
  userId: string;
  tokenHash: string;
  confirmed: boolean;
  revoked: boolean;
  reason: string | null;
}

/**
 * In-memory spawn store with the same semantics as the Postgres adapter's SQL: one clock (the "database" clock), the pending cap at issue, the
 * one-use redeem with its idempotent retry, owner-scoped reads. The component test (`app/tests/component/db/agent-spawn.int.test.ts`) runs the real SQL.
 */
export function memorySpawnStore(init: { users: Record<string, { agent?: boolean }>; failing?: boolean }) {
  const clock = { now: Date.parse("2026-11-12T12:00:00Z") };
  const grants: Grant[] = [];
  const keys: Key[] = [];
  const names = new Map<string, string>();
  const owners = new Map<string, string | null>(); // agent user id -> owner
  const createdAt = new Map<string, number>();
  const outage = { failing: init.failing ?? false };
  let seq = 0;
  const guard = () => {
    if (outage.failing) throw new Error("db down");
  };
  const live = (g: Grant) => g.expiresAt > clock.now;
  // Spent: a key was confirmed, or ended by a revoke other than a retry's `superseded` (REVOKE_IS_FINAL).
  const confirmed = (userId: string) => keys.some((k) => k.userId === userId && (k.confirmed || (k.revoked && k.reason !== "superseded")));
  const newKey = (userId: string, tokenHash: string): Key => {
    const key = { id: `k-${++seq}`, userId, tokenHash, confirmed: false, revoked: false, reason: null };
    keys.push(key);
    return key;
  };

  const spawn: SpawnStore = {
    async issue({ issuerUserId, tokenHash, ttlSec, maxPending }) {
      guard();
      if (!(issuerUserId in init.users)) return { ok: false, reason: "unknown_user" };
      if (init.users[issuerUserId]?.agent || owners.has(issuerUserId)) return { ok: false, reason: "agent_issuer" };
      const pending = grants.filter((g) => g.issuer === issuerUserId && g.redeemedUserId === null && live(g)).length;
      if (pending >= maxPending) return { ok: false, reason: "too_many_pending" };
      const g = { issuer: issuerUserId, tokenHash, expiresAt: clock.now + ttlSec * 1000, redeemedUserId: null };
      grants.push(g);
      return { ok: true, expiresAt: new Date(g.expiresAt).toISOString(), pending: pending + 1 };
    },
    async grantState(tokenHash): Promise<GrantState> {
      guard();
      const g = grants.find((x) => x.tokenHash === tokenHash);
      if (!g) return { state: "unknown" };
      if (!live(g)) return { state: "expired" };
      if (g.redeemedUserId === null) return { state: "open" };
      return { state: "redeemed", userId: g.redeemedUserId, name: names.get(g.redeemedUserId) ?? null, unconfirmed: !confirmed(g.redeemedUserId) };
    },
    async redeem({ tokenHash, name, newUserId, keyHash }: { tokenHash: string; name: string; newUserId: string; keyHash: string; policy: CredentialPolicy }): Promise<RedeemResult> {
      guard();
      const g = grants.find((x) => x.tokenHash === tokenHash);
      if (!g) return { ok: false, reason: "unknown" };
      if (!live(g)) return { ok: false, reason: "expired" };
      if (g.redeemedUserId !== null) {
        const agent = g.redeemedUserId;
        if (confirmed(agent) || names.get(agent) !== name) return { ok: false, reason: "already_redeemed" };
        for (const k of keys) if (k.userId === agent && !k.confirmed && !k.revoked) Object.assign(k, { revoked: true, reason: "superseded" });
        const key = newKey(agent, keyHash);
        return { ok: true, userId: agent, ownerUserId: g.issuer, credentialId: key.id, pendingExpiresAt: new Date(clock.now + 900_000).toISOString(), retry: true };
      }
      names.set(newUserId, name);
      owners.set(newUserId, g.issuer);
      createdAt.set(newUserId, clock.now);
      const key = newKey(newUserId, keyHash);
      g.redeemedUserId = newUserId;
      return { ok: true, userId: newUserId, ownerUserId: g.issuer, credentialId: key.id, pendingExpiresAt: new Date(clock.now + 900_000).toISOString(), retry: false };
    },
    async listOwned(ownerUserId): Promise<OwnedAgent[]> {
      guard();
      return [...owners.entries()]
        .filter(([, owner]) => owner === ownerUserId)
        .map(([agentUserId]) => {
          const mine = keys.filter((k) => k.userId === agentUserId);
          const keyState: OwnedAgent["keyState"] = mine.some((k) => k.confirmed && !k.revoked)
            ? "active"
            : mine.some((k) => !k.confirmed && !k.revoked)
              ? "pending"
              : mine.length > 0
                ? "revoked"
                : "none";
          return { agentUserId, name: names.get(agentUserId) ?? "", createdAt: new Date(createdAt.get(agentUserId) ?? 0).toISOString(), keyState };
        });
    },
    async countPending(issuerUserId) {
      guard();
      return grants.filter((g) => g.issuer === issuerUserId && g.redeemedUserId === null && live(g)).length;
    },
    async liveKeyIds({ ownerUserId, agentUserId }) {
      guard();
      if (owners.get(agentUserId) !== ownerUserId) return null;
      return keys.filter((k) => k.userId === agentUserId && !k.revoked).map((k) => k.id);
    },
  };

  /** The credential store's `revoke`, over the same key rows. Everything else is not under test here. */
  const credentials = {
    async revoke({ credentialId, userId, reason }: { credentialId: string; userId: string; reason: string; revokedBy: string }) {
      const k = keys.find((x) => x.id === credentialId && x.userId === userId && !x.revoked);
      if (!k) return false;
      Object.assign(k, { revoked: true, reason });
      return true;
    },
  } as unknown as CredentialStore;

  return {
    spawn,
    credentials,
    clock,
    outage,
    keys,
    /** The agent proves it stored its key: confirm every unconfirmed key of the agent. */
    confirm(userId: string) {
      for (const k of keys) if (k.userId === userId && !k.revoked) k.confirmed = true;
    },
    /** Make the pending cap and expiry testable: move the database clock. */
    advance(sec: number) {
      clock.now += sec * 1000;
    },
    /** Mark a user as an agent (an issuer that is an agent is refused). */
    ownedBy: owners,
  };
}
