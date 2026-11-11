// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/conformance`
 * Purpose: The credential conformance suite (SUITE_GATES_RELEASE). Every node that adopts `@cogni-dao/agent-grants/credentials` runs these
 *   rows over ITS store, so one definition of "a correct credential store" gates every adopter and the package release.
 * Scope: Test rows only. The package imports no test runner: the caller passes `describe`, `it` and `expect` (vitest) and a harness that
 *   prepares users, moves timestamps and breaks the store. The package runs the rows over a memory store; a node runs them over real SQL.
 * Invariants: Rows assert behavior through `verifyBearer` and the service functions, never store internals, except the three harness reads
 *   (`storedHash`, `liveSuccessors`) that prove hash-only storage and the one-pending-successor rule.
 * Side-effects: whatever the harness does
 * @public
 */

import { REVOCABLE_KEY_PREFIX, formatRevocableKey, isWellFormedRevocableKey } from "./key-format";
import {
  confirmCredential,
  hashAgentKey,
  type MintedKey,
  revokeCredential,
  rotateCredential,
  upgradeSignedKey,
  verifyBearer,
} from "./service";
import type { CredentialStore } from "./types";

/** What a user needs to have before an upgrade. The harness creates it in its backing store. */
export interface ConformanceFacts {
  wallet?: boolean;
  internal?: boolean;
  /** A live `agent_roles` row. */
  roles?: boolean;
  /** A GitHub binding. */
  github?: boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: structural match for vitest's `expect`
type Expect = (value: unknown) => any;

export interface CredentialConformanceHarness {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void>) => void;
  expect: Expect;
  /** A fresh store with these named users created. `ids` maps each name to its real user id. */
  setup(users: Record<string, ConformanceFacts>): Promise<{ store: CredentialStore; ids: Record<string, string> }>;
  /**
   * Move one credential's timestamps (the database clock keeps its own time): `renew_only` = expired, inside the renew window;
   * `expired` = past the renew window; `pending_expired` = the pending window ended.
   */
  age(credentialId: string, to: "renew_only" | "expired" | "pending_expired"): Promise<void>;
  /** Approve a live role for an existing user AFTER setup (the node's role read now says yes). */
  addRoles(userId: string): Promise<void>;
  /** A store whose every call throws, for the outage rows. */
  broken(): CredentialStore;
  /** The stored `token_hash` of a credential. */
  storedHash(credentialId: string): Promise<string | null>;
  /** Unconfirmed, unrevoked successors of a predecessor. */
  liveSuccessors(predecessorId: string): Promise<number>;
}

const okKey = (m: MintedKey) => {
  if (!m.ok) throw new Error(`refused: ${m.reason}`);
  return m;
};
const INVALID = { ok: false, reason: "invalid" } as const;

export function runCredentialConformance(h: CredentialConformanceHarness): void {
  const { describe, it, expect } = h;
  const alice = { alice: {} };
  const active = async (store: CredentialStore, userId: string) => {
    const key = okKey(await upgradeSignedKey(store, { userId }));
    await confirmCredential(store, { credentialId: key.credentialId });
    return key;
  };
  const revoke = (store: CredentialStore, credentialId: string, userId: string) =>
    revokeCredential(store, { credentialId, userId, revokedBy: userId });

  describe("credential conformance: key format and storage", () => {
    it("a key is the revocable prefix + 43 base64url chars + a 6-char CRC32 checksum, and only its sha256 is stored", async () => {
      const { store, ids } = await h.setup(alice);
      const key = okKey(await upgradeSignedKey(store, { userId: ids.alice as string }));
      expect(key.apiKey).toMatch(new RegExp(`^${REVOCABLE_KEY_PREFIX}[A-Za-z0-9_-]{43}[0-9A-Za-z]{6}$`));
      expect(isWellFormedRevocableKey(key.apiKey)).toBe(true);
      expect(await h.storedHash(key.credentialId)).toBe(await hashAgentKey(key.apiKey));
    });

    it("two keys never repeat", async () => {
      const { store, ids } = await h.setup({ alice: {}, bob: {} });
      const a = okKey(await upgradeSignedKey(store, { userId: ids.alice as string }));
      const b = okKey(await upgradeSignedKey(store, { userId: ids.bob as string }));
      expect(a.apiKey).not.toBe(b.apiKey);
    });
  });

  describe("credential conformance: checksum and admission before the store", () => {
    it("a key with a failing checksum (body or checksum edited) is refused before any store read", async () => {
      const { store, ids } = await h.setup(alice);
      const key = await active(store, ids.alice as string);
      const swap = (at: number) => key.apiKey.slice(0, at) + (key.apiKey[at] === "A" ? "B" : "A") + key.apiKey.slice(at + 1);
      for (const forged of [swap(REVOCABLE_KEY_PREFIX.length), swap(key.apiKey.length - 1), formatRevocableKey("a".repeat(43)).slice(0, -1) + "!"]) {
        expect(isWellFormedRevocableKey(forged)).toBe(false);
        expect(await verifyBearer(h.broken(), forged)).toEqual(INVALID);
      }
      expect(isWellFormedRevocableKey(formatRevocableKey("a".repeat(43)))).toBe(true);
    });

    it("admit runs after the shape check and before the store: over the limit is rate_limited with no store read; bad shape never spends it", async () => {
      const { store, ids } = await h.setup(alice);
      const key = await active(store, ids.alice as string);
      let spent = 0;
      const deny = { admit: () => (spent++, false) };
      expect(await verifyBearer(h.broken(), key.apiKey, ["active"], deny)).toEqual({ ok: false, reason: "rate_limited" });
      expect(spent).toBe(1);
      expect(await verifyBearer(h.broken(), `${REVOCABLE_KEY_PREFIX}junk`, ["active"], deny)).toEqual(INVALID);
      expect(spent).toBe(1);
      expect(await verifyBearer(store, key.apiKey, ["active"], { admit: () => true })).toMatchObject({ ok: true });
    });
  });

  describe("credential conformance: verifyBearer", () => {
    it("a valid revocable key: an active key resolves to its user", async () => {
      const { store, ids } = await h.setup(alice);
      const key = await active(store, ids.alice as string);
      expect(await verifyBearer(store, key.apiKey)).toMatchObject({
        ok: true,
        userId: ids.alice,
        state: "active",
        credentialId: key.credentialId,
      });
    });

    it("wrong hash: a one-char change, a signed key, a bad charset, a bad length and junk are all the same invalid", async () => {
      const { store, ids } = await h.setup(alice);
      const key = await active(store, ids.alice as string);
      const flipped = key.apiKey.slice(0, -1) + (key.apiKey.endsWith("A") ? "B" : "A");
      const badCharset = `${REVOCABLE_KEY_PREFIX}${"a".repeat(42)}!`;
      for (const token of [flipped, "cogni_ag_sk_v1_abc.def", `${REVOCABLE_KEY_PREFIX}short`, "", badCharset, `${key.apiKey}x`, `${REVOCABLE_KEY_PREFIX}${"x".repeat(43)}`]) {
        expect(await verifyBearer(store, token)).toEqual(INVALID);
      }
    });

    it("a token with the wrong shape never reaches the store", async () => {
      expect(await verifyBearer(h.broken(), `${REVOCABLE_KEY_PREFIX}${"a".repeat(42)}!`)).toEqual(INVALID);
      expect(await verifyBearer(h.broken(), `${REVOCABLE_KEY_PREFIX}${"a".repeat(44)}`)).toEqual(INVALID);
    });

    it("expiry: past expiry the key is denied on ordinary routes, renew_only inside the window, then dead", async () => {
      const { store, ids } = await h.setup(alice);
      const key = await active(store, ids.alice as string);
      await h.age(key.credentialId, "renew_only");
      expect(await verifyBearer(store, key.apiKey)).toEqual(INVALID);
      expect(await verifyBearer(store, key.apiKey, ["active", "renew_only"])).toMatchObject({ ok: true, state: "renew_only" });
      await h.age(key.credentialId, "expired");
      expect(await verifyBearer(store, key.apiKey, ["active", "renew_only"])).toEqual(INVALID);
    });

    it("revoked key: denied on the very next call (never cached); a sibling key of the same user stays valid", async () => {
      const { store, ids } = await h.setup(alice);
      const a = await active(store, ids.alice as string);
      const pending = okKey(await rotateCredential(store, { credentialId: a.credentialId }));
      expect(await verifyBearer(store, a.apiKey)).toMatchObject({ ok: true });
      await revoke(store, pending.credentialId, ids.alice as string);
      expect(await verifyBearer(store, pending.apiKey, ["pending", "active"])).toEqual(INVALID);
      expect(await verifyBearer(store, a.apiKey)).toMatchObject({ ok: true });
      expect(await revoke(store, a.credentialId, ids.alice as string)).toBe(true);
      expect(await verifyBearer(store, a.apiKey)).toEqual(INVALID);
    });

    it("A7: revoking one user's key leaves another user's key valid; a user cannot revoke another's credential id", async () => {
      const { store, ids } = await h.setup({ alice: {}, bob: {} });
      const a = await active(store, ids.alice as string);
      const b = await active(store, ids.bob as string);
      expect(await revoke(store, b.credentialId, ids.alice as string)).toBe(false);
      expect(await verifyBearer(store, b.apiKey)).toMatchObject({ ok: true });
      await revoke(store, a.credentialId, ids.alice as string);
      expect(await verifyBearer(store, a.apiKey)).toMatchObject({ ok: false });
      expect(await verifyBearer(store, b.apiKey)).toMatchObject({ ok: true });
    });

    it("pending key: refused on ordinary routes, accepted where the route opts in, dead after its window", async () => {
      const { store, ids } = await h.setup(alice);
      const key = okKey(await upgradeSignedKey(store, { userId: ids.alice as string }));
      expect(await verifyBearer(store, key.apiKey)).toEqual(INVALID);
      expect(await verifyBearer(store, key.apiKey, ["pending"])).toMatchObject({ ok: true, state: "pending" });
      await h.age(key.credentialId, "pending_expired");
      expect(await verifyBearer(store, key.apiKey, ["pending", "active"])).toEqual(INVALID);
    });

    it("store outage is `unavailable` (503), never `invalid` (401), and every service call throws instead of answering", async () => {
      const { store, ids } = await h.setup(alice);
      const key = await active(store, ids.alice as string);
      const broken = h.broken();
      expect(await verifyBearer(broken, key.apiKey)).toEqual({ ok: false, reason: "unavailable" });
      for (const call of [
        () => upgradeSignedKey(broken, { userId: ids.alice as string }),
        () => rotateCredential(broken, { credentialId: key.credentialId }),
        () => confirmCredential(broken, { credentialId: key.credentialId }),
        () => revoke(broken, key.credentialId, ids.alice as string),
      ]) {
        await expect(call()).rejects.toMatchObject({ code: "authz_unavailable" });
      }
    });
  });

  describe("credential conformance: upgrade (signed key -> revocable key, same users.id)", () => {
    it("mints a pending key for the same user id; confirm activates it", async () => {
      const { store, ids } = await h.setup(alice);
      const key = okKey(await upgradeSignedKey(store, { userId: ids.alice as string }));
      expect(key.userId).toBe(ids.alice);
      expect(await confirmCredential(store, { credentialId: key.credentialId })).toMatchObject({ ok: true, status: "confirmed", userId: ids.alice });
      expect(await verifyBearer(store, key.apiKey)).toMatchObject({ ok: true, userId: ids.alice });
    });

    it("a second upgrade supersedes the unconfirmed first; a user with a live revocable key is refused", async () => {
      const { store, ids } = await h.setup(alice);
      const first = okKey(await upgradeSignedKey(store, { userId: ids.alice as string }));
      const second = okKey(await upgradeSignedKey(store, { userId: ids.alice as string }));
      expect(await verifyBearer(store, first.apiKey, ["pending"])).toEqual(INVALID);
      expect(await verifyBearer(store, second.apiKey, ["pending"])).toMatchObject({ ok: true });
      await confirmCredential(store, { credentialId: second.credentialId });
      expect(await upgradeSignedKey(store, { userId: ids.alice as string })).toEqual({ ok: false, reason: "already_upgraded" });
    });

    it("v1 supersession: no confirmed credential until confirm, and still one after the revocable key is revoked", async () => {
      const { store, ids } = await h.setup(alice);
      const userId = ids.alice as string;
      expect(await store.everConfirmed(userId)).toBe(false);
      const key = okKey(await upgradeSignedKey(store, { userId }));
      expect(await store.everConfirmed(userId)).toBe(false); // the signed key keeps working while the revocable key is only pending
      await confirmCredential(store, { credentialId: key.credentialId });
      expect(await store.everConfirmed(userId)).toBe(true);
      await revoke(store, key.credentialId, userId);
      expect(await store.everConfirmed(userId)).toBe(true); // revoking must not bring the signed key back
    });

    it("refuses a wallet user, an internal principal and an unknown user", async () => {
      const { store, ids } = await h.setup({ w: { wallet: true }, i: { internal: true } });
      expect(await upgradeSignedKey(store, { userId: ids.w as string })).toEqual({ ok: false, reason: "wallet_user" });
      expect(await upgradeSignedKey(store, { userId: ids.i as string })).toEqual({ ok: false, reason: "internal_principal" });
      expect(await upgradeSignedKey(store, { userId: crypto.randomUUID() })).toEqual({ ok: false, reason: "unknown_user" });
    });

    it("BINDING_BEFORE_UPGRADE: a principal with roles and no GitHub binding is refused; with a binding it passes", async () => {
      const { store, ids } = await h.setup({ roled: { roles: true }, bound: { roles: true, github: true } });
      expect(await upgradeSignedKey(store, { userId: ids.roled as string })).toEqual({ ok: false, reason: "binding_required" });
      expect(await upgradeSignedKey(store, { userId: ids.bound as string })).toMatchObject({ ok: true });
    });

    it("BINDING_BEFORE_UPGRADE is re-checked at confirm: roles approved after the upgrade call, no binding, refuses confirm; a rotation key is not re-checked", async () => {
      const { store, ids } = await h.setup({ late: {}, bound: { github: true } });
      const late = okKey(await upgradeSignedKey(store, { userId: ids.late as string }));
      await h.addRoles(ids.late as string);
      expect(await confirmCredential(store, { credentialId: late.credentialId })).toEqual({ ok: false, reason: "binding_required" });
      expect(await verifyBearer(store, late.apiKey, ["pending", "active"])).toMatchObject({ ok: true, state: "pending" });
      expect(await store.everConfirmed(ids.late as string)).toBe(false); // the signed key still works; nothing was activated
      // With a binding the same roles pass, and a rotation of an active key is never re-checked.
      const bound = okKey(await upgradeSignedKey(store, { userId: ids.bound as string }));
      await h.addRoles(ids.bound as string);
      expect(await confirmCredential(store, { credentialId: bound.credentialId })).toMatchObject({ ok: true, status: "confirmed" });
      const next = okKey(await rotateCredential(store, { credentialId: bound.credentialId }));
      expect(await confirmCredential(store, { credentialId: next.credentialId })).toMatchObject({ ok: true, status: "confirmed" });
    });
  });

  describe("credential conformance: rotate, confirm, revoke", () => {
    it("rotate mints a pending successor for the same user; the old key works until confirm, then is dead", async () => {
      const { store, ids } = await h.setup(alice);
      const old = await active(store, ids.alice as string);
      const next = okKey(await rotateCredential(store, { credentialId: old.credentialId }));
      expect(next.userId).toBe(ids.alice);
      expect(await verifyBearer(store, next.apiKey)).toEqual(INVALID);
      expect(await verifyBearer(store, old.apiKey)).toMatchObject({ ok: true });
      expect(await confirmCredential(store, { credentialId: next.credentialId })).toMatchObject({ ok: true, status: "confirmed" });
      expect(await verifyBearer(store, old.apiKey)).toEqual(INVALID);
      expect(await verifyBearer(store, next.apiKey)).toMatchObject({ ok: true, userId: ids.alice });
    });

    it("confirm is idempotent: a replay returns already_active with the same expiry", async () => {
      const { store, ids } = await h.setup(alice);
      const old = await active(store, ids.alice as string);
      const next = okKey(await rotateCredential(store, { credentialId: old.credentialId }));
      const first = await confirmCredential(store, { credentialId: next.credentialId });
      const replay = await confirmCredential(store, { credentialId: next.credentialId });
      expect(first).toMatchObject({ ok: true, status: "confirmed" });
      expect(replay).toMatchObject({ ok: true, status: "already_active" });
      expect(replay).toMatchObject({ expiresAt: first.ok ? first.expiresAt : "" });
    });

    it("rotate supersedes: a repeat call revokes the first pending key and converges on one live pending key", async () => {
      const { store, ids } = await h.setup(alice);
      const old = await active(store, ids.alice as string);
      const first = okKey(await rotateCredential(store, { credentialId: old.credentialId }));
      const second = okKey(await rotateCredential(store, { credentialId: old.credentialId }));
      expect(second.apiKey).not.toBe(first.apiKey);
      expect(await h.liveSuccessors(old.credentialId)).toBe(1);
      expect(await confirmCredential(store, { credentialId: first.credentialId })).toEqual({ ok: false, reason: "revoked" });
      expect(await confirmCredential(store, { credentialId: second.credentialId })).toMatchObject({ ok: true, status: "confirmed" });
    });

    it("concurrent rotates serialize on the predecessor: every call succeeds, exactly one pending successor survives", async () => {
      const { store, ids } = await h.setup(alice);
      const old = await active(store, ids.alice as string);
      const results = await Promise.all([1, 2, 3, 4].map(() => rotateCredential(store, { credentialId: old.credentialId })));
      expect(results.every((r) => r.ok)).toBe(true);
      expect(await h.liveSuccessors(old.credentialId)).toBe(1);
    });

    it("revoked-pending-successor: revoking the old key revokes its pending successor, so a late confirm fails", async () => {
      const { store, ids } = await h.setup(alice);
      const old = await active(store, ids.alice as string);
      const next = okKey(await rotateCredential(store, { credentialId: old.credentialId }));
      await revoke(store, old.credentialId, ids.alice as string);
      expect(await verifyBearer(store, next.apiKey, ["pending"])).toEqual(INVALID);
      expect(await confirmCredential(store, { credentialId: next.credentialId })).toEqual({ ok: false, reason: "revoked" });
    });

    it("concurrent confirm and revoke of the predecessor never leave two live keys, and never revoke the winner", async () => {
      for (let round = 0; round < 3; round++) {
        const { store, ids } = await h.setup(alice);
        const old = await active(store, ids.alice as string);
        const next = okKey(await rotateCredential(store, { credentialId: old.credentialId }));
        const [confirmed, revoked] = await Promise.all([
          confirmCredential(store, { credentialId: next.credentialId }),
          revoke(store, old.credentialId, ids.alice as string),
        ]);
        const oldLive = (await verifyBearer(store, old.apiKey)).ok;
        const nextLive = (await verifyBearer(store, next.apiKey)).ok;
        expect(oldLive).toBe(false);
        // Either confirm won (new key live, the revoke found the old key already rotated) or the revoke won (new key dead).
        expect(nextLive).toBe(!revoked);
        expect(confirmed.ok).toBe(nextLive);
      }
    });

    it("concurrent confirms of one pending key both succeed (one confirmed, one replay)", async () => {
      const { store, ids } = await h.setup(alice);
      const old = await active(store, ids.alice as string);
      const next = okKey(await rotateCredential(store, { credentialId: old.credentialId }));
      const both = await Promise.all([
        confirmCredential(store, { credentialId: next.credentialId }),
        confirmCredential(store, { credentialId: next.credentialId }),
      ]);
      expect(both.every((r) => r.ok)).toBe(true);
      expect(both.filter((r) => r.ok && r.status === "confirmed")).toHaveLength(1);
    });

    it("confirm after the pending window is refused; the predecessor is untouched", async () => {
      const { store, ids } = await h.setup(alice);
      const old = await active(store, ids.alice as string);
      const next = okKey(await rotateCredential(store, { credentialId: old.credentialId }));
      await h.age(next.credentialId, "pending_expired");
      expect(await confirmCredential(store, { credentialId: next.credentialId })).toEqual({ ok: false, reason: "expired" });
      expect(await verifyBearer(store, old.apiKey)).toMatchObject({ ok: true });
    });

    it("a renew_only key may rotate; a pending key may not; a predecessor past renew_until during the pending window still confirms", async () => {
      const { store, ids } = await h.setup(alice);
      const old = await active(store, ids.alice as string);
      await h.age(old.credentialId, "renew_only");
      const next = okKey(await rotateCredential(store, { credentialId: old.credentialId }));
      expect(await rotateCredential(store, { credentialId: next.credentialId })).toEqual({ ok: false, reason: "not_rotatable" });
      // The predecessor authenticated at rotate time; its renew window may end while the successor is pending.
      await h.age(old.credentialId, "expired");
      expect(await confirmCredential(store, { credentialId: next.credentialId })).toMatchObject({ ok: true, status: "confirmed" });
      expect(await rotateCredential(store, { credentialId: old.credentialId })).toEqual({ ok: false, reason: "not_rotatable" });
    });

    it("every credential in a chain keeps the same user id and only the last key is live", async () => {
      const { store, ids } = await h.setup(alice);
      let key = await active(store, ids.alice as string);
      const all = [key];
      for (let i = 0; i < 3; i++) {
        const next = okKey(await rotateCredential(store, { credentialId: key.credentialId }));
        await confirmCredential(store, { credentialId: next.credentialId });
        key = next;
        all.push(next);
      }
      for (const k of all) {
        const v = await verifyBearer(store, k.apiKey);
        expect(v.ok).toBe(k === key);
        if (v.ok) expect(v.userId).toBe(ids.alice);
      }
    });
  });
}
