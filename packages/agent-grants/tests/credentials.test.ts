// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Credential conformance suite (task.0070, SUITE_GATES_RELEASE): the rows every node adopting `@cogni-dao/agent-grants/credentials`
 * must see pass. Runs the real service over a memory store with the Postgres adapter's semantics; the node's component test runs the
 * same rows over real SQL.
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_KEY_V2_PREFIX,
  confirmCredential,
  DEFAULT_CREDENTIAL_POLICY,
  hashAgentKey,
  type MintedKey,
  revokeCredential,
  rotateCredential,
  upgradeFromV1,
  verifyBearer,
} from "../src/credentials";
import { memoryCredentialStore } from "./credentials-memory-store";

const DAY = 24 * 3600;
const setup = (users: Record<string, object> = { alice: {}, bob: {} }) => memoryCredentialStore({ users });
const minted = (m: MintedKey) => {
  if (!m.ok) throw new Error(`refused: ${m.reason}`);
  return m;
};
/** upgrade + confirm: an active v2 key. */
async function activeKey(h: ReturnType<typeof setup>, userId = "alice") {
  const key = minted(await upgradeFromV1(h.store, { userId }));
  await confirmCredential(h.store, { credentialId: key.credentialId });
  return key;
}

describe("key format and storage", () => {
  it("a key is cogni_ag_sk_v2_ + 43 base64url chars, and only its sha256 reaches the store", async () => {
    const h = setup();
    const key = minted(await upgradeFromV1(h.store, { userId: "alice" }));
    expect(key.apiKey).toMatch(/^cogni_ag_sk_v2_[A-Za-z0-9_-]{43}$/);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]?.tokenHash).toBe(await hashAgentKey(key.apiKey));
    expect(JSON.stringify(h.rows)).not.toContain(key.apiKey.slice(AGENT_KEY_V2_PREFIX.length));
  });

  it("two keys never repeat", async () => {
    const h = setup();
    const a = minted(await upgradeFromV1(h.store, { userId: "alice" }));
    const b = minted(await upgradeFromV1(h.store, { userId: "bob" }));
    expect(a.apiKey).not.toBe(b.apiKey);
  });
});

describe("verifyBearer", () => {
  it("valid v2: an active key resolves to its user", async () => {
    const h = setup();
    const key = await activeKey(h);
    const v = await verifyBearer(h.store, key.apiKey);
    expect(v).toMatchObject({ ok: true, userId: "alice", state: "active", credentialId: key.credentialId });
  });

  it("wrong hash: a key never issued, a one-char change, a v1 key and junk are all the same invalid", async () => {
    const h = setup();
    const key = await activeKey(h);
    const flipped = key.apiKey.slice(0, -1) + (key.apiKey.endsWith("A") ? "B" : "A");
    for (const token of [flipped, "cogni_ag_sk_v1_abc.def", "cogni_ag_sk_v2_short", "", `${AGENT_KEY_V2_PREFIX}${"x".repeat(43)}`]) {
      expect(await verifyBearer(h.store, token)).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("expired: past expiry the key is denied on ordinary routes, and renew_only inside the window", async () => {
    const h = setup();
    const key = await activeKey(h);
    h.advance(31 * DAY);
    expect(await verifyBearer(h.store, key.apiKey)).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyBearer(h.store, key.apiKey, ["active", "renew_only"])).toMatchObject({ ok: true, state: "renew_only" });
    h.advance(14 * DAY);
    expect(await verifyBearer(h.store, key.apiKey, ["active", "renew_only"])).toEqual({ ok: false, reason: "invalid" });
  });

  it("revoked key: denied on the very next call (never cached), another key of the same user stays valid", async () => {
    const h = setup();
    const a = await activeKey(h);
    const second = minted(await rotateCredential(h.store, { credentialId: a.credentialId }));
    // Two live keys: the old one and the pending one. Confirm only the old stays until then.
    expect(await verifyBearer(h.store, a.apiKey)).toMatchObject({ ok: true });
    await revokeCredential(h.store, { credentialId: second.credentialId, userId: "alice", revokedBy: "alice" });
    expect(await verifyBearer(h.store, second.apiKey, ["pending", "active"])).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyBearer(h.store, a.apiKey)).toMatchObject({ ok: true });
    expect(await revokeCredential(h.store, { credentialId: a.credentialId, userId: "alice", revokedBy: "alice" })).toBe(true);
    expect(await verifyBearer(h.store, a.apiKey)).toEqual({ ok: false, reason: "invalid" });
  });

  it("A7: revoking one user's key leaves another user's key at 200, and one user cannot revoke another's id", async () => {
    const h = setup();
    const alice = await activeKey(h, "alice");
    const bob = await activeKey(h, "bob");
    expect(await revokeCredential(h.store, { credentialId: bob.credentialId, userId: "alice", revokedBy: "alice" })).toBe(false);
    expect(await verifyBearer(h.store, bob.apiKey)).toMatchObject({ ok: true });
    await revokeCredential(h.store, { credentialId: alice.credentialId, userId: "alice", revokedBy: "alice" });
    expect(await verifyBearer(h.store, alice.apiKey)).toMatchObject({ ok: false });
    expect(await verifyBearer(h.store, bob.apiKey)).toMatchObject({ ok: true });
  });

  it("pending key: refused on ordinary routes, accepted where the route opts in", async () => {
    const h = setup();
    const key = minted(await upgradeFromV1(h.store, { userId: "alice" }));
    expect(await verifyBearer(h.store, key.apiKey)).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyBearer(h.store, key.apiKey, ["pending"])).toMatchObject({ ok: true, state: "pending" });
    h.advance(DEFAULT_CREDENTIAL_POLICY.pendingSec + 1);
    expect(await verifyBearer(h.store, key.apiKey, ["pending", "active"])).toEqual({ ok: false, reason: "invalid" });
  });

  it("store outage is `unavailable` (503), never `invalid` (401)", async () => {
    const h = setup();
    const key = await activeKey(h);
    h.outage.failing = true;
    expect(await verifyBearer(h.store, key.apiKey)).toEqual({ ok: false, reason: "unavailable" });
    expect(await verifyBearer(h.store, "cogni_ag_sk_v2_short")).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("upgrade (v1 key -> v2 key, same users.id)", () => {
  it("mints a pending key for the same user id; confirm activates it", async () => {
    const h = setup();
    const key = minted(await upgradeFromV1(h.store, { userId: "alice" }));
    expect(key.userId).toBe("alice");
    const confirmed = await confirmCredential(h.store, { credentialId: key.credentialId });
    expect(confirmed).toMatchObject({ ok: true, status: "confirmed", userId: "alice" });
    expect(await verifyBearer(h.store, key.apiKey)).toMatchObject({ ok: true, userId: "alice" });
  });

  it("v1 coexistence window: a second upgrade supersedes the unconfirmed first; a user with a live v2 key is refused", async () => {
    const h = setup();
    const first = minted(await upgradeFromV1(h.store, { userId: "alice" }));
    const second = minted(await upgradeFromV1(h.store, { userId: "alice" }));
    expect(await verifyBearer(h.store, first.apiKey, ["pending"])).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyBearer(h.store, second.apiKey, ["pending"])).toMatchObject({ ok: true });
    await confirmCredential(h.store, { credentialId: second.credentialId });
    expect(await upgradeFromV1(h.store, { userId: "alice" })).toEqual({ ok: false, reason: "already_upgraded" });
  });

  it("refuses a wallet user, an internal principal and an unknown user", async () => {
    const h = setup({ w: { wallet: true }, i: { internal: true } });
    expect(await upgradeFromV1(h.store, { userId: "w" })).toEqual({ ok: false, reason: "wallet_user" });
    expect(await upgradeFromV1(h.store, { userId: "i" })).toEqual({ ok: false, reason: "internal_principal" });
    expect(await upgradeFromV1(h.store, { userId: "nobody" })).toEqual({ ok: false, reason: "unknown_user" });
  });

  it("C5 BINDING_BEFORE_UPGRADE: a principal with roles and no GitHub binding is refused; with a binding it passes", async () => {
    const h = setup({ roled: { roles: true }, bound: { roles: true, github: true } });
    expect(await upgradeFromV1(h.store, { userId: "roled" })).toEqual({ ok: false, reason: "binding_required" });
    expect(await upgradeFromV1(h.store, { userId: "bound" })).toMatchObject({ ok: true });
  });
});

describe("rotate and confirm", () => {
  it("rotate mints a pending successor for the same user; the old key works until confirm, then is dead; the successor is the live one", async () => {
    const h = setup();
    const old = await activeKey(h);
    const next = minted(await rotateCredential(h.store, { credentialId: old.credentialId }));
    expect(next.userId).toBe("alice");
    expect(await verifyBearer(h.store, next.apiKey)).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyBearer(h.store, old.apiKey)).toMatchObject({ ok: true });
    expect(await confirmCredential(h.store, { credentialId: next.credentialId })).toMatchObject({ ok: true, status: "confirmed" });
    expect(await verifyBearer(h.store, old.apiKey)).toEqual({ ok: false, reason: "invalid" });
    expect(await verifyBearer(h.store, next.apiKey)).toMatchObject({ ok: true, userId: "alice" });
  });

  it("confirm is idempotent: a replay returns already_active and changes nothing", async () => {
    const h = setup();
    const old = await activeKey(h);
    const next = minted(await rotateCredential(h.store, { credentialId: old.credentialId }));
    const first = await confirmCredential(h.store, { credentialId: next.credentialId });
    const replay = await confirmCredential(h.store, { credentialId: next.credentialId });
    expect(first).toMatchObject({ ok: true, status: "confirmed" });
    expect(replay).toMatchObject({ ok: true, status: "already_active" });
    expect(replay.ok && first.ok && replay.expiresAt).toBe(first.ok && first.expiresAt);
  });

  it("rotate supersedes: a repeat call revokes the first pending key and converges on one live pending key", async () => {
    const h = setup();
    const old = await activeKey(h);
    const first = minted(await rotateCredential(h.store, { credentialId: old.credentialId }));
    const second = minted(await rotateCredential(h.store, { credentialId: old.credentialId }));
    expect(second.apiKey).not.toBe(first.apiKey);
    expect(h.rows.filter((r) => r.predecessorId === old.credentialId && r.revokedAt === null && r.confirmedAt === null)).toHaveLength(1);
    expect(await confirmCredential(h.store, { credentialId: first.credentialId })).toEqual({ ok: false, reason: "revoked" });
    expect(await confirmCredential(h.store, { credentialId: second.credentialId })).toMatchObject({ ok: true, status: "confirmed" });
  });

  it("revoked-pending-successor: revoking the old key revokes its pending successor, so a late confirm fails", async () => {
    const h = setup();
    const old = await activeKey(h);
    const next = minted(await rotateCredential(h.store, { credentialId: old.credentialId }));
    await revokeCredential(h.store, { credentialId: old.credentialId, userId: "alice", revokedBy: "alice" });
    expect(await verifyBearer(h.store, next.apiKey, ["pending"])).toEqual({ ok: false, reason: "invalid" });
    expect(await confirmCredential(h.store, { credentialId: next.credentialId })).toEqual({ ok: false, reason: "revoked" });
  });

  it("confirm after the pending window is refused; the predecessor is untouched", async () => {
    const h = setup();
    const old = await activeKey(h);
    const next = minted(await rotateCredential(h.store, { credentialId: old.credentialId }));
    h.advance(DEFAULT_CREDENTIAL_POLICY.pendingSec + 1);
    expect(await confirmCredential(h.store, { credentialId: next.credentialId })).toEqual({ ok: false, reason: "expired" });
    expect(await verifyBearer(h.store, old.apiKey)).toMatchObject({ ok: true });
  });

  it("a renew_only key may rotate; a pending or revoked key may not", async () => {
    const h = setup();
    const old = await activeKey(h);
    h.advance(31 * DAY);
    const next = minted(await rotateCredential(h.store, { credentialId: old.credentialId }));
    expect(await rotateCredential(h.store, { credentialId: next.credentialId })).toEqual({ ok: false, reason: "not_rotatable" });
    // the predecessor passed expiry during the pending window yet confirm still works (it authenticated at rotate time)
    expect(await confirmCredential(h.store, { credentialId: next.credentialId })).toMatchObject({ ok: true, status: "confirmed" });
    expect(await rotateCredential(h.store, { credentialId: old.credentialId })).toEqual({ ok: false, reason: "not_rotatable" });
  });

  it("every credential in a chain keeps the same user id", async () => {
    const h = setup();
    let key = await activeKey(h);
    for (let i = 0; i < 3; i++) {
      const next = minted(await rotateCredential(h.store, { credentialId: key.credentialId }));
      await confirmCredential(h.store, { credentialId: next.credentialId });
      key = next;
    }
    expect(new Set(h.rows.map((r) => r.userId))).toEqual(new Set(["alice"]));
    expect(h.rows.filter((r) => r.revokedAt === null)).toHaveLength(1);
  });
});
