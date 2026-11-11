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

import type { AdminCheck } from "../types";
import { REVOCABLE_KEY_PREFIX, formatRevocableKey, isWellFormedRevocableKey } from "./key-format";
import { type CommentRead, type ProofComment, type ProofVerifier, parseProofLine } from "./proofs";
import {
  assertV1NotSuperseded,
  bindGithubIdentity,
  type ChallengeOutcome,
  confirmCredential,
  hashAgentKey,
  issueProofChallenge,
  liftPrincipalStop,
  type MintedKey,
  type ProofConfig,
  recoverCredential,
  revokeCredential,
  revokePrincipalCredentials,
  rotateCredential,
  upgradeSignedKey,
  verifyBearer,
} from "./service";
import { type CredentialStore, DEFAULT_PROOF_POLICY, type ProofPolicy } from "./types";

/** What a user needs to have before an upgrade. The harness creates it in its backing store. */
export interface ConformanceFacts {
  wallet?: boolean;
  internal?: boolean;
  /** A live `agent_roles` row. */
  roles?: boolean;
  /** A GitHub binding. */
  github?: boolean;
  /** A GitHub binding with this exact external id (implies `github`). */
  githubId?: string;
  /** An EXTERNAL agent_principals row, with no credential (a signed-key agent that bound, or one that only upgraded once). */
  agent?: boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: structural match for vitest's `expect`
type Expect = (value: unknown) => any;

export interface CredentialConformanceHarness {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void>) => void;
  expect: Expect;
  /**
   * A fresh store with these named users created. `ids` maps each name to its real user id. Real SQL: also clear `agent_proof_challenges`, because
   * the proof limits (per hour, GitHub budget) are node-wide counts and the rows share one database.
   */
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
  /** Move one challenge past its expiry. */
  expireChallenge(challengeId: string): Promise<void>;
  /** A challenge's failed-check count and whether it was consumed, or null when no row exists. */
  challengeInfo(challengeId: string): Promise<{ attempts: number; consumed: boolean } | null>;
  /** How many `agent_credentials` rows exist for the user, any state. */
  credentialRows(userId: string): Promise<number>;
  /** The user's GitHub binding external ids. */
  githubBindings(userId: string): Promise<string[]>;
  /** How many `identity_events` rows of type `bind` exist for the user. */
  bindEvents(userId: string): Promise<number>;
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

    it("onInvalid spends only on a lookup that finds no usable key: a valid key, a bad checksum and an outage never spend", async () => {
      const { store, ids } = await h.setup(alice);
      const key = await active(store, ids.alice as string);
      let spent = 0;
      const options = { admit: () => true, onInvalid: () => void spent++ };
      expect(await verifyBearer(store, key.apiKey, ["active"], options)).toMatchObject({ ok: true });
      expect(await verifyBearer(store, key.apiKey, ["pending"], options)).toEqual(INVALID); // a known key in a state the route refuses is a miss
      expect(spent).toBe(1);
      expect(await verifyBearer(store, formatRevocableKey("a".repeat(43)), ["active"], options)).toEqual(INVALID); // unknown key
      expect(spent).toBe(2);
      expect(await verifyBearer(store, `${REVOCABLE_KEY_PREFIX}junk`, ["active"], options)).toEqual(INVALID);
      expect(await verifyBearer(h.broken(), key.apiKey, ["active"], options)).toEqual({ ok: false, reason: "unavailable" });
      expect(spent).toBe(2);
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

  runProofConformance(h);
}

// ---------------------------------------------------------------------------------------------------------------------
// Proofs: bind, recover, stop, lift (task.0091). Same rows over the memory store and over real SQL.
// ---------------------------------------------------------------------------------------------------------------------

const ISSUE = "cogni-dao/proof-issues#1";
const ISSUE_URL = "https://api.github.com/repos/cogni-dao/proof-issues/issues/1";
const NODE_ID = "node-conformance";
const uniqueGithubId = () => 100_000_000 + Math.floor(Math.random() * 800_000_000);

/** A scripted GitHub: the rows post comments into it, and can take it down. */
function scriptedGithub() {
  const comments = new Map<number, CommentRead>();
  const state = { down: false, fetches: 0, next: 1000 };
  const verifier: ProofVerifier = {
    async fetchComment({ issue, commentId }) {
      state.fetches++;
      if (state.down || `${issue.owner}/${issue.repo}#${issue.number}` !== ISSUE) return { kind: "unavailable" };
      return comments.get(commentId) ?? { kind: "not_found" };
    },
  };
  const post = (over: Partial<ProofComment> & { body: string }): number => {
    const id = state.next++;
    const at = new Date(Date.now()).toISOString();
    comments.set(id, {
      kind: "found",
      comment: { issueUrl: ISSUE_URL, userId: uniqueGithubId(), login: "agent-account", userType: "User", createdAt: at, updatedAt: at, ...over },
    });
    return id;
  };
  return { verifier, post, state, comments };
}

type Ok<T> = Extract<T, { ok: true }>;

function runProofConformance(h: CredentialConformanceHarness): void {
  const { describe, it, expect } = h;
  const config = (policy: Partial<ProofPolicy> = {}): ProofConfig => ({ nodeId: NODE_ID, issues: [ISSUE], policy: { ...DEFAULT_PROOF_POLICY, ...policy } });
  const challenge = async (store: CredentialStore, purpose: "bind" | "recover", principalUserId?: string, policy: Partial<ProofPolicy> = {}) => {
    const out = await issueProofChallenge(store, { ...config(policy), purpose, ...(principalUserId ? { principalUserId } : {}) });
    if (!out.ok) throw new Error(`challenge refused: ${out.reason}`);
    return out as Ok<ChallengeOutcome>;
  };
  /** The comment time a fair proof has: one second after the challenge was made. */
  const createdFor = (ch: { expiresAt: string }, offsetSec = 1) =>
    new Date(Date.parse(ch.expiresAt) - DEFAULT_PROOF_POLICY.challengeTtlSec * 1000 + offsetSec * 1000).toISOString();
  const proofComment = (ch: Ok<ChallengeOutcome>, over: Partial<ProofComment> = {}) => {
    const at = over.createdAt ?? createdFor(ch);
    return { body: `hello\n${ch.proofLine}\n`, createdAt: at, updatedAt: at, ...over };
  };
  const attempt = (ch: Ok<ChallengeOutcome>, commentId: number, over: Record<string, unknown> = {}) => ({
    challengeId: ch.challengeId,
    challengeSecret: ch.challengeSecret,
    issue: ISSUE,
    commentId,
    ...over,
  });
  const admin = (adminId: string): AdminCheck => async (id) => (id === adminId ? "allow" : "denied");
  const okKey = (m: MintedKey) => {
    if (!m.ok) throw new Error(`refused: ${m.reason}`);
    return m;
  };
  const activeKey = async (store: CredentialStore, userId: string) => {
    const key = okKey(await upgradeSignedKey(store, { userId }));
    await confirmCredential(store, { credentialId: key.credentialId });
    return key;
  };
  /** Bind `userId` to a fresh GitHub account through the real flow. */
  const bind = async (store: CredentialStore, gh: ReturnType<typeof scriptedGithub>, userId: string, githubId = uniqueGithubId()) => {
    const ch = await challenge(store, "bind", userId);
    const id = gh.post({ ...proofComment(ch), userId: githubId });
    return { githubId, outcome: await bindGithubIdentity(store, gh.verifier, config(), { ...attempt(ch, id), principalUserId: userId }) };
  };

  describe("proof conformance: challenge, replay and the requester secret", () => {
    it("a challenge holds a public proof line with the node id and a private secret; no issues configured is proof_unavailable", async () => {
      const { store, ids } = await h.setup({ alice: {} });
      const ch = await challenge(store, "bind", ids.alice as string);
      const parts = parseProofLine(ch.proofLine);
      expect(parts).toMatchObject({ nodeId: NODE_ID, challengeId: ch.challengeId });
      expect(ch.proofLine).not.toContain(ch.challengeSecret);
      expect(ch.challengeSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(ch.issues).toEqual([ISSUE]);
      expect(await issueProofChallenge(store, { nodeId: NODE_ID, issues: [], purpose: "recover" })).toEqual({ ok: false, reason: "proof_unavailable" });
    });

    it("replay: the public comment without the secret is 401 and the owner's later call succeeds; a wrong secret counts nothing", async () => {
      const gh = scriptedGithub();
      const { store, ids } = await h.setup({ alice: {} });
      const ch = await challenge(store, "bind", ids.alice as string);
      const id = gh.post(proofComment(ch));
      const thief = { ...attempt(ch, id), challengeSecret: "x".repeat(43), principalUserId: ids.alice as string };
      expect(await bindGithubIdentity(store, gh.verifier, config(), thief)).toEqual({ ok: false, reason: "invalid_challenge" });
      expect(await bindGithubIdentity(store, gh.verifier, config(), { ...thief, challengeSecret: "short" })).toEqual({ ok: false, reason: "invalid_challenge" });
      expect(await h.challengeInfo(ch.challengeId)).toEqual({ attempts: 0, consumed: false });
      expect(gh.state.fetches).toBe(0); // CHECK_BEFORE_FETCH
      const owner = await bindGithubIdentity(store, gh.verifier, config(), { ...attempt(ch, id), principalUserId: ids.alice as string });
      expect(owner).toMatchObject({ ok: true, result: "created" });
      expect(await bindGithubIdentity(store, gh.verifier, config(), { ...attempt(ch, id), principalUserId: ids.alice as string })).toEqual({
        ok: false,
        reason: "invalid_challenge",
      });
    });

    it("another principal's bearer and a wrong purpose are denied the same way; a challenge never works for the other purpose", async () => {
      const gh = scriptedGithub();
      const { store, ids } = await h.setup({ alice: {}, bob: {} });
      const ch = await challenge(store, "bind", ids.alice as string);
      const id = gh.post(proofComment(ch));
      expect(await bindGithubIdentity(store, gh.verifier, config(), { ...attempt(ch, id), principalUserId: ids.bob as string })).toEqual({
        ok: false,
        reason: "invalid_challenge",
      });
      expect(await recoverCredential(store, gh.verifier, config(), attempt(ch, id))).toEqual({ ok: false, reason: "invalid_challenge" });
      const rec = await challenge(store, "recover");
      const rid = gh.post(proofComment(rec));
      expect(await bindGithubIdentity(store, gh.verifier, config(), { ...attempt(rec, rid), principalUserId: ids.alice as string })).toEqual({
        ok: false,
        reason: "invalid_challenge",
      });
      expect(gh.state.fetches).toBe(0);
    });

    it("an expired challenge is invalid; bind challenges are limited per principal (3 open)", async () => {
      const gh = scriptedGithub();
      const { store, ids } = await h.setup({ alice: {} });
      const ch = await challenge(store, "bind", ids.alice as string);
      const id = gh.post(proofComment(ch));
      await h.expireChallenge(ch.challengeId);
      expect(await bindGithubIdentity(store, gh.verifier, config(), { ...attempt(ch, id), principalUserId: ids.alice as string })).toEqual({
        ok: false,
        reason: "invalid_challenge",
      });
      await challenge(store, "bind", ids.alice as string);
      await challenge(store, "bind", ids.alice as string);
      await challenge(store, "bind", ids.alice as string);
      expect(await issueProofChallenge(store, { ...config(), purpose: "bind", principalUserId: ids.alice as string })).toEqual({ ok: false, reason: "rate_limited" });
    });

    it("anonymous recover challenges are limited node-wide per hour", async () => {
      const { store } = await h.setup({});
      await challenge(store, "recover", undefined, { recoverPerHourNode: 2 });
      await challenge(store, "recover", undefined, { recoverPerHourNode: 2 });
      expect(await issueProofChallenge(store, { ...config({ recoverPerHourNode: 2 }), purpose: "recover" })).toEqual({ ok: false, reason: "rate_limited" });
    });
  });

  describe("proof conformance: the comment check", () => {
    const failing = async (mutate: (ch: Ok<ChallengeOutcome>) => Partial<ProofComment>, issue = ISSUE) => {
      const gh = scriptedGithub();
      const { store, ids } = await h.setup({ alice: {} });
      const ch = await challenge(store, "bind", ids.alice as string);
      const id = gh.post({ ...proofComment(ch), ...mutate(ch) });
      const out = await bindGithubIdentity(store, gh.verifier, config(), { ...attempt(ch, id, { issue }), principalUserId: ids.alice as string });
      return { out, store, ch, ids, gh };
    };

    it("a comment older than the challenge, a ghost author and an Organization author each fail with proof_failed", async () => {
      const old = await failing((ch) => ({ createdAt: createdFor(ch, -120), updatedAt: createdFor(ch, -120) }));
      expect(old.out).toEqual({ ok: false, reason: "proof_failed", failure: "outside_window" });
      const ghost = await failing(() => ({ userId: 10137, login: "ghost" }));
      expect(ghost.out).toEqual({ ok: false, reason: "proof_failed", failure: "author_invalid" });
      const deleted = await failing(() => ({ userId: null, login: null, userType: null }));
      expect(deleted.out).toEqual({ ok: false, reason: "proof_failed", failure: "author_invalid" });
      const org = await failing(() => ({ userType: "Organization" }));
      expect(org.out).toEqual({ ok: false, reason: "proof_failed", failure: "author_invalid" });
      expect(await h.challengeInfo(org.ch.challengeId)).toEqual({ attempts: 1, consumed: false });
    });

    it("an issue outside the allowlist and a comment on another issue fail", async () => {
      expect((await failing(() => ({}), "other-org/other#9")).out).toEqual({ ok: false, reason: "proof_failed", failure: "issue_not_allowed" });
      expect((await failing(() => ({ issueUrl: "https://api.github.com/repos/other-org/other/issues/9" }))).out).toEqual({
        ok: false,
        reason: "proof_failed",
        failure: "wrong_issue",
      });
    });

    it("an edited comment proves nothing: updated_at after created_at, or a GraphQL lastEditedAt, is comment_edited", async () => {
      const edited = await failing((ch) => ({ updatedAt: createdFor(ch, 9) }));
      expect(edited.out).toEqual({ ok: false, reason: "proof_failed", failure: "comment_edited" });
      const sameSecond = await failing(() => ({ lastEditedAt: "2026-11-11T10:00:00Z" }));
      expect(sameSecond.out).toEqual({ ok: false, reason: "proof_failed", failure: "comment_edited" });
      const neverEdited = await failing(() => ({ lastEditedAt: null }));
      expect(neverEdited.out).toMatchObject({ ok: true });
    });

    it("a line for another node, another challenge, or no line at all is line_missing; a missing comment is comment_not_found", async () => {
      const otherNode = await failing((ch) => ({ body: ch.proofLine.replace(NODE_ID, "node-elsewhere") }));
      expect(otherNode.out).toEqual({ ok: false, reason: "proof_failed", failure: "line_missing" });
      const none = await failing(() => ({ body: "just a comment" }));
      expect(none.out).toEqual({ ok: false, reason: "proof_failed", failure: "line_missing" });
      const gh = scriptedGithub();
      const { store, ids } = await h.setup({ a: {}, b: {} });
      const a = await challenge(store, "bind", ids.a as string);
      const b = await challenge(store, "bind", ids.b as string);
      const aComment = gh.post(proofComment(a));
      expect(await bindGithubIdentity(store, gh.verifier, config(), { ...attempt(b, aComment), principalUserId: ids.b as string })).toEqual({
        ok: false,
        reason: "proof_failed",
        failure: "line_missing",
      });
      expect(await bindGithubIdentity(store, gh.verifier, config(), { ...attempt(b, 424242), principalUserId: ids.b as string })).toEqual({
        ok: false,
        reason: "proof_failed",
        failure: "comment_not_found",
      });
    });

    it("a GitHub outage is proof_unavailable and consumes nothing; the same challenge succeeds when GitHub is back", async () => {
      const gh = scriptedGithub();
      const { store, ids } = await h.setup({ alice: {} });
      const ch = await challenge(store, "bind", ids.alice as string);
      const id = gh.post(proofComment(ch));
      gh.state.down = true;
      expect(await bindGithubIdentity(store, gh.verifier, config(), { ...attempt(ch, id), principalUserId: ids.alice as string })).toEqual({
        ok: false,
        reason: "proof_unavailable",
      });
      expect(await h.challengeInfo(ch.challengeId)).toEqual({ attempts: 0, consumed: false });
      gh.state.down = false;
      expect(await bindGithubIdentity(store, gh.verifier, config(), { ...attempt(ch, id), principalUserId: ids.alice as string })).toMatchObject({ ok: true });
    });

    it("the third failed check kills the challenge, even for a good comment", async () => {
      const gh = scriptedGithub();
      const { store, ids } = await h.setup({ alice: {} });
      const ch = await challenge(store, "bind", ids.alice as string);
      const good = gh.post(proofComment(ch));
      for (let i = 0; i < 3; i++) {
        expect(await bindGithubIdentity(store, gh.verifier, config(), { ...attempt(ch, 5000 + i), principalUserId: ids.alice as string })).toMatchObject({
          reason: "proof_failed",
        });
      }
      expect(await bindGithubIdentity(store, gh.verifier, config(), { ...attempt(ch, good), principalUserId: ids.alice as string })).toEqual({
        ok: false,
        reason: "invalid_challenge",
      });
    });

    it("the node-wide GitHub budget: a spent budget is proof_unavailable and consumes nothing", async () => {
      const gh = scriptedGithub();
      const { store, ids } = await h.setup({ a: {}, b: {} });
      const policy = { fetchBudgetPerHour: 1 };
      const a = await challenge(store, "bind", ids.a as string, policy);
      const b = await challenge(store, "bind", ids.b as string, policy);
      const cfg = config(policy);
      const first = await bindGithubIdentity(store, gh.verifier, cfg, { ...attempt(a, gh.post(proofComment(a))), principalUserId: ids.a as string });
      expect(first).toMatchObject({ ok: true });
      const second = await bindGithubIdentity(store, gh.verifier, cfg, { ...attempt(b, gh.post(proofComment(b))), principalUserId: ids.b as string });
      expect(second).toEqual({ ok: false, reason: "proof_unavailable" });
      expect(await h.challengeInfo(b.challengeId)).toEqual({ attempts: 0, consumed: false });
    });
  });

  describe("proof conformance: bind", () => {
    it("binds the proven account with evidence; BINDING_BEFORE_UPGRADE then passes for a principal with roles", async () => {
      const gh = scriptedGithub();
      const { store, ids } = await h.setup({ roled: { roles: true } });
      const id = ids.roled as string;
      expect(await upgradeSignedKey(store, { userId: id })).toEqual({ ok: false, reason: "binding_required" });
      const { githubId, outcome } = await bind(store, gh, id);
      expect(outcome).toEqual({ ok: true, result: "created", githubId: String(githubId), userType: "User" });
      expect(await h.githubBindings(id)).toEqual([String(githubId)]);
      expect(await h.bindEvents(id)).toBe(1);
      expect(await upgradeSignedKey(store, { userId: id })).toMatchObject({ ok: true });
    });

    it("the same account again is already_bound (no second event); another account is binding_exists", async () => {
      const gh = scriptedGithub();
      const { store, ids } = await h.setup({ alice: {} });
      const id = ids.alice as string;
      const first = await bind(store, gh, id);
      expect(await bind(store, gh, id, first.githubId)).toMatchObject({ outcome: { ok: true, result: "already_bound" } });
      expect(await h.bindEvents(id)).toBe(1);
      expect((await bind(store, gh, id)).outcome).toEqual({ ok: false, reason: "binding_exists" });
      expect(await h.githubBindings(id)).toEqual([String(first.githubId)]);
    });

    it("NO_AUTO_MERGE: an account bound to another user is already_linked and stays with its owner", async () => {
      const gh = scriptedGithub();
      const { store, ids } = await h.setup({ a: {}, b: {} });
      const first = await bind(store, gh, ids.a as string);
      expect((await bind(store, gh, ids.b as string, first.githubId)).outcome).toEqual({ ok: false, reason: "already_linked" });
      expect(await h.githubBindings(ids.a as string)).toEqual([String(first.githubId)]);
      expect(await h.githubBindings(ids.b as string)).toEqual([]);
    });

    it("a wallet user and an internal principal cannot bind; a stopped principal cannot even ask", async () => {
      const gh = scriptedGithub();
      const { store, ids } = await h.setup({ w: { wallet: true }, i: { internal: true }, s: {}, root: {} });
      expect((await bind(store, gh, ids.w as string)).outcome).toEqual({ ok: false, reason: "not_agent" });
      expect((await bind(store, gh, ids.i as string)).outcome).toEqual({ ok: false, reason: "not_agent" });
      expect(await revokePrincipalCredentials(store, admin(ids.root as string), { actorUserId: ids.root as string, targetUserId: ids.s as string, plane: "human" })).toMatchObject({
        ok: true,
      });
      expect(await issueProofChallenge(store, { ...config(), purpose: "bind", principalUserId: ids.s as string })).toEqual({ ok: false, reason: "stopped" });
    });

    it("a stop between the challenge and the bind refuses the bind", async () => {
      const gh = scriptedGithub();
      const { store, ids } = await h.setup({ s: {}, root: {} });
      const ch = await challenge(store, "bind", ids.s as string);
      const id = gh.post(proofComment(ch));
      await revokePrincipalCredentials(store, admin(ids.root as string), { actorUserId: ids.root as string, targetUserId: ids.s as string, plane: "human" });
      expect(await bindGithubIdentity(store, gh.verifier, config(), { ...attempt(ch, id), principalUserId: ids.s as string })).toEqual({ ok: false, reason: "stopped" });
      expect(await h.githubBindings(ids.s as string)).toEqual([]);
    });
  });

  describe("proof conformance: recover", () => {
    const recoverWith = async (store: CredentialStore, gh: ReturnType<typeof scriptedGithub>, githubId: number, policy: Partial<ProofPolicy> = {}) => {
      const ch = await challenge(store, "recover", undefined, policy);
      const id = gh.post({ ...proofComment(ch), userId: githubId });
      return { ch, outcome: await recoverCredential(store, gh.verifier, config(policy), attempt(ch, id)) };
    };

    it("the owner of the bound account gets ONE active key on the SAME users.id; every sibling and pending key dies; an old key dies", async () => {
      const gh = scriptedGithub();
      const githubId = uniqueGithubId();
      const { store, ids } = await h.setup({ bound: { roles: true, githubId: String(githubId), agent: true } });
      const id = ids.bound as string;
      const old = await activeKey(store, id);
      const pending = okKey(await rotateCredential(store, { credentialId: old.credentialId }));
      const { outcome } = await recoverWith(store, gh, githubId);
      expect(outcome).toMatchObject({ ok: true, userId: id, revokedCount: 2 });
      if (!outcome.ok) return;
      expect(await verifyBearer(store, outcome.apiKey)).toMatchObject({ ok: true, userId: id, state: "active" });
      expect(await verifyBearer(store, old.apiKey)).toEqual(INVALID);
      expect(await verifyBearer(store, pending.apiKey, ["pending", "active"])).toEqual(INVALID);
      expect(await h.storedHash(outcome.credentialId)).toBe(await hashAgentKey(outcome.apiKey));
      // A lost recovery response is fixed by recovering again: the new run revokes the lost key.
      const again = await recoverWith(store, gh, githubId);
      expect(again.outcome).toMatchObject({ ok: true, userId: id, revokedCount: 1 });
      expect(await verifyBearer(store, outcome.apiKey)).toEqual(INVALID);
    });

    it("recovery works after the old key fully expired", async () => {
      const gh = scriptedGithub();
      const githubId = uniqueGithubId();
      const { store, ids } = await h.setup({ gone: { githubId: String(githubId), agent: true } });
      const old = await activeKey(store, ids.gone as string);
      await h.age(old.credentialId, "expired");
      expect(await verifyBearer(store, old.apiKey, ["active", "renew_only"])).toEqual(INVALID);
      const { outcome } = await recoverWith(store, gh, githubId);
      expect(outcome).toMatchObject({ ok: true, userId: ids.gone });
      if (outcome.ok) expect(await verifyBearer(store, outcome.apiKey)).toMatchObject({ ok: true });
    });

    it("a signed-key agent that bound (no credential row yet) recovers a key, and its signed keys are then superseded", async () => {
      const gh = scriptedGithub();
      const githubId = uniqueGithubId();
      const { store, ids } = await h.setup({ signed: { githubId: String(githubId), agent: true } });
      const id = ids.signed as string;
      expect(await h.credentialRows(id)).toBe(0);
      const { outcome } = await recoverWith(store, gh, githubId);
      expect(outcome).toMatchObject({ ok: true, userId: id, revokedCount: 0 });
      await expect(assertV1NotSuperseded(store, id)).rejects.toMatchObject({ code: "v1_superseded" });
    });

    it("a human with only a GitHub binding (no agent principal) and an unbound account get one uniform no_binding", async () => {
      const gh = scriptedGithub();
      const githubId = uniqueGithubId();
      const { store } = await h.setup({ human: { githubId: String(githubId) } });
      expect((await recoverWith(store, gh, githubId)).outcome).toEqual({ ok: false, reason: "no_binding" });
      expect((await recoverWith(store, gh, uniqueGithubId())).outcome).toEqual({ ok: false, reason: "no_binding" });
    });

    it("a stopped principal gets `stopped`: nothing changes and the challenge is not consumed; after a lift recovery works", async () => {
      const gh = scriptedGithub();
      const githubId = uniqueGithubId();
      const { store, ids } = await h.setup({ s: { githubId: String(githubId), agent: true }, root: {} });
      const id = ids.s as string;
      const old = await activeKey(store, id);
      const rootAdmin = admin(ids.root as string);
      const stop = { actorUserId: ids.root as string, targetUserId: id, plane: "human" as const };
      await revokePrincipalCredentials(store, rootAdmin, stop);
      const rows = await h.credentialRows(id);
      const refused = await recoverWith(store, gh, githubId);
      expect(refused.outcome).toEqual({ ok: false, reason: "stopped" });
      expect(await h.credentialRows(id)).toBe(rows);
      expect(await h.challengeInfo(refused.ch.challengeId)).toEqual({ attempts: 0, consumed: false });
      expect(await liftPrincipalStop(store, rootAdmin, stop)).toEqual({ ok: true });
      expect(await verifyBearer(store, old.apiKey)).toEqual(INVALID); // a lift revives nothing
      const after = await recoverWith(store, gh, githubId);
      expect(after.outcome).toMatchObject({ ok: true, userId: id });
    });

    it("the sixth recovery in 24 hours is refused", async () => {
      const gh = scriptedGithub();
      const githubId = uniqueGithubId();
      const policy = { recoverPerHourNode: 100 };
      const { store } = await h.setup({ loop: { githubId: String(githubId), agent: true } });
      for (let i = 0; i < 5; i++) expect((await recoverWith(store, gh, githubId, policy)).outcome).toMatchObject({ ok: true });
      expect((await recoverWith(store, gh, githubId, policy)).outcome).toEqual({ ok: false, reason: "recovery_limited" });
    });

    it("recover and the recovery key keep the lifecycle: the key rotates and confirms like any other", async () => {
      const gh = scriptedGithub();
      const githubId = uniqueGithubId();
      const { store } = await h.setup({ agent: { githubId: String(githubId), agent: true } });
      const { outcome } = await recoverWith(store, gh, githubId);
      if (!outcome.ok) throw new Error("recover refused");
      const next = okKey(await rotateCredential(store, { credentialId: outcome.credentialId }));
      expect(await confirmCredential(store, { credentialId: next.credentialId })).toMatchObject({ ok: true, status: "confirmed" });
      expect(await verifyBearer(store, outcome.apiKey)).toEqual(INVALID);
    });
  });

  describe("proof conformance: stop and lift (one gate, two doors)", () => {
    it("a non-admin changes nothing; an unavailable or throwing admin check is authz_unavailable; both doors answer the same", async () => {
      const { store, ids } = await h.setup({ victim: {}, root: {}, other: {} });
      const key = await activeKey(store, ids.victim as string);
      const input = (plane: "human" | "ai") => ({ actorUserId: ids.other as string, targetUserId: ids.victim as string, plane });
      const asAdmin = admin(ids.root as string);
      expect(await revokePrincipalCredentials(store, asAdmin, input("human"))).toEqual({ ok: false, reason: "authz_denied" });
      expect(await revokePrincipalCredentials(store, asAdmin, input("ai"))).toEqual({ ok: false, reason: "authz_denied" });
      expect(await revokePrincipalCredentials(store, async () => "unavailable", input("human"))).toEqual({ ok: false, reason: "authz_unavailable" });
      expect(
        await revokePrincipalCredentials(
          store,
          async () => {
            throw new Error("openfga down");
          },
          input("ai")
        )
      ).toEqual({ ok: false, reason: "authz_unavailable" });
      expect(await liftPrincipalStop(store, asAdmin, input("ai"))).toEqual({ ok: false, reason: "authz_denied" });
      expect(await verifyBearer(store, key.apiKey)).toMatchObject({ ok: true });
    });

    it("stop kills every key (pending too) on the next call; a second stop revokes 0; the stop is a store outage-safe write", async () => {
      const { store, ids } = await h.setup({ victim: {}, root: {} });
      const id = ids.victim as string;
      const key = await activeKey(store, id);
      const pending = okKey(await rotateCredential(store, { credentialId: key.credentialId }));
      const stop = { actorUserId: ids.root as string, targetUserId: id, plane: "human" as const };
      const rootAdmin = admin(ids.root as string);
      expect(await revokePrincipalCredentials(store, rootAdmin, stop)).toEqual({ ok: true, revokedCount: 2 });
      expect(await verifyBearer(store, key.apiKey)).toEqual(INVALID);
      expect(await verifyBearer(store, pending.apiKey, ["pending", "active"])).toEqual(INVALID);
      expect(await revokePrincipalCredentials(store, rootAdmin, { ...stop, plane: "ai" })).toEqual({ ok: true, revokedCount: 0 });
      await expect(revokePrincipalCredentials(h.broken(), async () => "allow", stop)).rejects.toMatchObject({ code: "authz_unavailable" });
    });

    it("a wallet user and an internal principal are not_agent; an unknown id is principal_not_found", async () => {
      const { store, ids } = await h.setup({ w: { wallet: true }, i: { internal: true }, root: {} });
      const rootAdmin = admin(ids.root as string);
      const input = (targetUserId: string) => ({ actorUserId: ids.root as string, targetUserId, plane: "human" as const });
      expect(await revokePrincipalCredentials(store, rootAdmin, input(ids.w as string))).toEqual({ ok: false, reason: "not_agent" });
      expect(await revokePrincipalCredentials(store, rootAdmin, input(ids.i as string))).toEqual({ ok: false, reason: "not_agent" });
      expect(await revokePrincipalCredentials(store, rootAdmin, input(crypto.randomUUID()))).toEqual({ ok: false, reason: "principal_not_found" });
    });

    it("a signed-key role holder with NO principal row: stop, then its signed key is v1_superseded and no credential row exists", async () => {
      const { store, ids } = await h.setup({ signed: { roles: true }, root: {} });
      const id = ids.signed as string;
      await expect(assertV1NotSuperseded(store, id)).resolves.toBeUndefined();
      expect(await revokePrincipalCredentials(store, admin(ids.root as string), { actorUserId: ids.root as string, targetUserId: id, plane: "human" })).toEqual({
        ok: true,
        revokedCount: 0,
      });
      await expect(assertV1NotSuperseded(store, id)).rejects.toMatchObject({ code: "v1_superseded" });
      expect(await h.credentialRows(id)).toBe(0);
      expect(await upgradeSignedKey(store, { userId: id })).toEqual({ ok: false, reason: "stopped" });
    });

    it("lift mints nothing and revives nothing; not_stopped, self_lift and principal_not_found are refused", async () => {
      const { store, ids } = await h.setup({ victim: {}, root: {} });
      const id = ids.victim as string;
      const key = await activeKey(store, id);
      const rootAdmin = admin(ids.root as string);
      const stop = { actorUserId: ids.root as string, targetUserId: id, plane: "human" as const };
      expect(await liftPrincipalStop(store, rootAdmin, stop)).toEqual({ ok: false, reason: "not_stopped" });
      await revokePrincipalCredentials(store, rootAdmin, stop);
      const rows = await h.credentialRows(id);
      expect(await liftPrincipalStop(store, rootAdmin, stop)).toEqual({ ok: true });
      expect(await h.credentialRows(id)).toBe(rows);
      expect(await verifyBearer(store, key.apiKey)).toEqual(INVALID);
      await expect(assertV1NotSuperseded(store, id)).rejects.toMatchObject({ code: "v1_superseded" }); // signed keys stay dead
      expect(await liftPrincipalStop(store, rootAdmin, stop)).toEqual({ ok: false, reason: "not_stopped" });
      expect(await liftPrincipalStop(store, rootAdmin, { ...stop, targetUserId: ids.root as string })).toEqual({ ok: false, reason: "self_lift" });
      expect(await liftPrincipalStop(store, rootAdmin, { ...stop, targetUserId: crypto.randomUUID() })).toEqual({ ok: false, reason: "principal_not_found" });
    });

    it("the keys row: a live key is On; a stop is Off and stays listed; a lift with no live key removes the row; a role-holding signed agent is On", async () => {
      const { store, ids } = await h.setup({ keyed: {}, signed: { roles: true }, plain: {}, w: { wallet: true }, root: {} });
      await activeKey(store, ids.keyed as string);
      const listed = async () => {
        const all = (await store.listKeyHolders(50)).holders.filter((x) => [ids.keyed, ids.signed, ids.plain, ids.w].includes(x.userId));
        return Object.fromEntries(all.map((x) => [x.userId, x.on]));
      };
      expect(await listed()).toEqual({ [ids.keyed as string]: true, [ids.signed as string]: true });
      const rootAdmin = admin(ids.root as string);
      const stop = { actorUserId: ids.root as string, targetUserId: ids.keyed as string, plane: "human" as const };
      await revokePrincipalCredentials(store, rootAdmin, stop);
      expect(await listed()).toEqual({ [ids.keyed as string]: false, [ids.signed as string]: true });
      await liftPrincipalStop(store, rootAdmin, stop);
      expect(await listed()).toEqual({ [ids.signed as string]: true });
      expect((await store.listKeyHolders(1)).more).toBeGreaterThanOrEqual(0);
    });

    it("every proof and stop call surfaces a store outage as authz_unavailable", async () => {
      const broken = h.broken();
      await expect(issueProofChallenge(broken, { ...config(), purpose: "recover" })).rejects.toMatchObject({ code: "authz_unavailable" });
      await expect(
        recoverCredential(broken, scriptedGithub().verifier, config(), { challengeId: crypto.randomUUID(), challengeSecret: "a".repeat(43), issue: ISSUE, commentId: 1 })
      ).rejects.toMatchObject({ code: "authz_unavailable" });
      await expect(liftPrincipalStop(broken, async () => "allow", { actorUserId: "a", targetUserId: "b", plane: "ai" })).rejects.toMatchObject({
        code: "authz_unavailable",
      });
    });
  });
}
