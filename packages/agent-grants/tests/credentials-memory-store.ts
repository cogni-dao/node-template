// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type {
  ChallengeIssueResult,
  ConfirmResult,
  CredentialLookup,
  CredentialPolicy,
  CredentialState,
  CredentialStore,
  FinishBindResult,
  FinishRecoverResult,
  IssueResult,
  KeyHolder,
  LiftResult,
  OpenProofCheckResult,
  StopResult,
} from "../src/credentials";

interface Row {
  id: string;
  userId: string;
  tokenHash: string;
  createdFrom: string;
  predecessorId: string | null;
  issuedAt: number;
  expiresAt: number;
  renewUntil: number;
  pendingExpiresAt: number;
  confirmedAt: number | null;
  revokedAt: number | null;
  revokedReason: string | null;
}

export interface MemoryUser {
  wallet?: boolean;
  internal?: boolean;
  roles?: boolean;
  github?: boolean;
  /** The bound GitHub id (implies `github`). */
  githubId?: string;
  /** An external agent principal row exists (an upgrade or a bind writes it). */
  agent?: boolean;
}

interface Challenge {
  id: string;
  purpose: string;
  nonceHash: string;
  secretHash: string;
  principal: string | null;
  issuedAt: number;
  expiresAt: number;
  attempts: number;
  fetchedAt: number | null;
  consumedAt: number | null;
}
interface Stop {
  stoppedAt: number;
  stoppedBy: string;
  liftedAt: number | null;
}

/**
 * In-memory store with the same semantics as the Postgres adapter's SQL: state derived from timestamps against ONE clock (the "database"
 * clock, `clock.now`), one pending successor per predecessor, confirm retires the predecessor. The component test runs the real SQL.
 */
export function memoryCredentialStore(init: { users: Record<string, MemoryUser>; failing?: boolean }) {
  const clock = { now: Date.parse("2026-11-10T12:00:00Z") };
  const rows: Row[] = [];
  const outage = { failing: init.failing ?? false, /** Fail only this store method (an outage AFTER a successful verify). */ failOn: null as string | null };
  let seq = 0;
  const challenges: Challenge[] = [];
  const stops = new Map<string, Stop>();
  const identityEvents: Array<{ userId: string; payload: Record<string, unknown> }> = [];
  const githubIdOf = (userId: string, u: MemoryUser): string | null => (u.githubId ?? (u.github ? `gh-${userId}` : null));
  const bindingsOf = (userId: string): string[] => {
    const u = init.users[userId];
    const own = u ? githubIdOf(userId, u) : null;
    return own ? [own] : [];
  };
  const isStopped = (userId: string) => stops.get(userId)?.liftedAt === null;
  const isWallet = (u: MemoryUser) => u.wallet === true;
  const guard = (method: string) => {
    if (outage.failing || outage.failOn === method) throw new Error("db down");
  };
  const state = (r: Row): CredentialState =>
    r.revokedAt !== null
      ? "revoked"
      : r.confirmedAt === null
        ? r.pendingExpiresAt > clock.now
          ? "pending"
          : "pending_expired"
        : r.expiresAt > clock.now
          ? "active"
          : r.renewUntil > clock.now
            ? "renew_only"
            : "expired";
  const plus = (sec: number) => clock.now + sec * 1000;
  const pending = (userId: string, tokenHash: string, createdFrom: string, predecessorId: string | null, p: CredentialPolicy): Row => {
    const row: Row = {
      id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
      userId,
      tokenHash,
      createdFrom,
      predecessorId,
      issuedAt: clock.now,
      expiresAt: plus(p.ttlSec),
      renewUntil: plus(p.ttlSec + p.renewWindowSec),
      pendingExpiresAt: plus(p.pendingSec),
      confirmedAt: null,
      revokedAt: null,
      revokedReason: null,
    };
    rows.push(row);
    return row;
  };
  const revokeRow = (r: Row, reason: string) => {
    r.revokedAt = clock.now;
    r.revokedReason = reason;
  };
  const iso = (ms: number) => new Date(ms).toISOString();

  const store: CredentialStore = {
    async lookup(tokenHash): Promise<CredentialLookup | null> {
      guard("lookup");
      const r = rows.find((x) => x.tokenHash === tokenHash);
      return r
        ? { credentialId: r.id, userId: r.userId, name: `name-${r.userId}`, state: state(r), expiresAt: iso(r.expiresAt), renewUntil: iso(r.renewUntil) }
        : null;
    },
    async issueUpgrade({ userId, tokenHash, policy }): Promise<IssueResult> {
      guard("issueUpgrade");
      const u = init.users[userId];
      if (!u) return { ok: false, reason: "unknown_user" };
      if (u.wallet) return { ok: false, reason: "wallet_user" };
      if (u.internal) return { ok: false, reason: "internal_principal" };
      if (isStopped(userId)) return { ok: false, reason: "stopped" };
      if (rows.some((r) => r.userId === userId && ["active", "renew_only"].includes(state(r)))) return { ok: false, reason: "already_upgraded" };
      if (u.roles && githubIdOf(userId, u) === null) return { ok: false, reason: "binding_required" };
      u.agent = true;
      for (const r of rows)
        if (r.userId === userId && r.createdFrom === "key_upgrade" && r.confirmedAt === null && r.revokedAt === null) revokeRow(r, "superseded");
      const row = pending(userId, tokenHash, "key_upgrade", null, policy);
      return { ok: true, credentialId: row.id, userId, pendingExpiresAt: iso(row.pendingExpiresAt) };
    },
    async issueSuccessor({ predecessorId, tokenHash, policy }): Promise<IssueResult> {
      guard("issueSuccessor");
      const pred = rows.find((r) => r.id === predecessorId);
      if (!pred || !["active", "renew_only"].includes(state(pred))) return { ok: false, reason: "not_rotatable" };
      for (const r of rows) if (r.predecessorId === predecessorId && r.confirmedAt === null && r.revokedAt === null) revokeRow(r, "superseded");
      const row = pending(pred.userId, tokenHash, "rotation", predecessorId, policy);
      return { ok: true, credentialId: row.id, userId: pred.userId, pendingExpiresAt: iso(row.pendingExpiresAt) };
    },
    async confirm({ credentialId, policy }): Promise<ConfirmResult> {
      guard("confirm");
      const r = rows.find((x) => x.id === credentialId);
      if (!r) return { ok: false, reason: "not_found" };
      const s = state(r);
      const done = (status: "confirmed" | "already_active") => ({
        ok: true as const,
        status,
        userId: r.userId,
        expiresAt: iso(r.expiresAt),
        renewUntil: iso(r.renewUntil),
      });
      if (s === "revoked") return { ok: false, reason: "revoked" };
      if (s === "pending_expired" || s === "expired") return { ok: false, reason: "expired" };
      if (s === "active" || s === "renew_only") return done("already_active");
      if (isStopped(r.userId)) return { ok: false, reason: "stopped" };
      const pred = r.predecessorId ? rows.find((x) => x.id === r.predecessorId) : undefined;
      if (pred?.revokedAt !== null && pred) return { ok: false, reason: "predecessor_revoked" };
      const u = init.users[r.userId];
      if (r.createdFrom === "key_upgrade" && u?.roles && githubIdOf(r.userId, u) === null) return { ok: false, reason: "binding_required" };
      r.confirmedAt = clock.now;
      r.expiresAt = plus(policy.ttlSec);
      r.renewUntil = plus(policy.ttlSec + policy.renewWindowSec);
      if (pred) revokeRow(pred, "rotated");
      return done("confirmed");
    },
    async everConfirmed(userId) {
      guard("everConfirmed");
      return rows.some((r) => r.userId === userId && r.confirmedAt !== null) || stops.has(userId);
    },
    async revoke({ credentialId, userId, reason }) {
      guard("revoke");
      const r = rows.find((x) => x.id === credentialId && x.userId === userId && x.revokedAt === null);
      if (!r) return false;
      revokeRow(r, reason);
      for (const s of rows) if (s.predecessorId === credentialId && s.confirmedAt === null && s.revokedAt === null) revokeRow(s, "predecessor_revoked");
      return true;
    },

    async createChallenge({ challengeId, purpose, principalUserId, nonceHash, secretHash, policy: p }): Promise<ChallengeIssueResult> {
      guard("createChallenge");
      for (let i = challenges.length - 1; i >= 0; i--) if ((challenges[i] as Challenge).expiresAt < clock.now - 3600_000) challenges.splice(i, 1);
      const open = (c: Challenge) => c.consumedAt === null && c.expiresAt > clock.now && c.attempts < p.maxFailedChecks;
      const hourly = (c: Challenge) => c.issuedAt > clock.now - 3600_000;
      if (purpose === "bind") {
        const userId = principalUserId as string;
        if (!init.users[userId]) return { ok: false, reason: "unknown_user" };
        if (isStopped(userId)) return { ok: false, reason: "stopped" };
        const mine = challenges.filter((c) => c.purpose === "bind" && c.principal === userId);
        if (mine.filter(open).length >= p.bindOpenPerPrincipal || mine.filter(hourly).length >= p.bindPerHourPerPrincipal)
          return { ok: false, reason: "rate_limited" };
      } else if (
        challenges.filter((c) => c.purpose === "recover" && hourly(c)).length >= p.recoverPerHourNode ||
        challenges.filter((c) => c.purpose === "recover" && open(c)).length >= p.maxOpenChallenges
      ) {
        return { ok: false, reason: "rate_limited" };
      }
      const c: Challenge = {
        id: challengeId,
        purpose,
        nonceHash,
        secretHash,
        principal: principalUserId,
        issuedAt: clock.now,
        expiresAt: plus(p.challengeTtlSec),
        attempts: 0,
        fetchedAt: null,
        consumedAt: null,
      };
      challenges.push(c);
      return { ok: true, challengeId, issuedAt: iso(c.issuedAt), expiresAt: iso(c.expiresAt) };
    },
    async openProofCheck({ challengeId, secretHash, purpose, principalUserId, policy: p }): Promise<OpenProofCheckResult> {
      guard("openProofCheck");
      const c = challenges.find(
        (x) =>
          x.id === challengeId &&
          x.purpose === purpose &&
          x.secretHash === secretHash &&
          x.consumedAt === null &&
          x.expiresAt > clock.now &&
          x.attempts < p.maxFailedChecks &&
          x.principal === principalUserId
      );
      if (!c) return { ok: false, reason: "invalid_challenge" };
      if (challenges.filter((x) => x.fetchedAt !== null && x.fetchedAt > clock.now - 3600_000).length >= p.fetchBudgetPerHour)
        return { ok: false, reason: "fetch_budget" };
      c.fetchedAt = clock.now;
      return { ok: true, issuedAt: iso(c.issuedAt), expiresAt: iso(c.expiresAt), nonceHash: c.nonceHash };
    },
    async recordProofFailure({ challengeId }) {
      guard("recordProofFailure");
      const c = challenges.find((x) => x.id === challengeId && x.consumedAt === null);
      if (c) c.attempts += 1;
      return { attempts: c?.attempts ?? 0 };
    },
    async finishBind({ challengeId, secretHash, principalUserId: userId, evidence, policy: p }): Promise<FinishBindResult> {
      guard("finishBind");
      const c = challenges.find(
        (x) =>
          x.id === challengeId &&
          x.purpose === "bind" &&
          x.principal === userId &&
          x.secretHash === secretHash &&
          x.consumedAt === null &&
          x.expiresAt > clock.now &&
          x.attempts < p.maxFailedChecks
      );
      if (!c) return { ok: false, reason: "invalid_challenge" };
      const u = init.users[userId];
      if (!u || isWallet(u) || u.internal) return { ok: false, reason: "not_agent" };
      if (isStopped(userId)) return { ok: false, reason: "stopped" };
      const mine = bindingsOf(userId);
      if (mine.length > 0) {
        if (!mine.includes(evidence.githubId)) return { ok: false, reason: "binding_exists" };
        u.agent = true;
        c.consumedAt = clock.now;
        return { ok: true, result: "already_bound" };
      }
      for (const [id, other] of Object.entries(init.users)) if (id !== userId && githubIdOf(id, other) === evidence.githubId) return { ok: false, reason: "already_linked" };
      u.githubId = evidence.githubId;
      u.agent = true;
      identityEvents.push({
        userId,
        payload: { provider: "github", external_id: evidence.githubId, method: "github_comment_proof", comment_id: evidence.commentId, issue: evidence.issue, user_type: evidence.userType },
      });
      c.consumedAt = clock.now;
      return { ok: true, result: "created" };
    },
    async finishRecover({ challengeId, secretHash, githubId, tokenHash, policy: p }): Promise<FinishRecoverResult> {
      guard("finishRecover");
      const c = challenges.find(
        (x) =>
          x.id === challengeId &&
          x.purpose === "recover" &&
          x.secretHash === secretHash &&
          x.consumedAt === null &&
          x.expiresAt > clock.now &&
          x.attempts < p.maxFailedChecks
      );
      if (!c) return { ok: false, reason: "invalid_challenge" };
      const found = Object.entries(init.users).find(([id, u]) => githubIdOf(id, u) === githubId && u.agent === true && !isWallet(u) && !u.internal);
      if (!found) return { ok: false, reason: "no_binding" };
      const userId = found[0];
      if (isStopped(userId)) return { ok: false, reason: "stopped" };
      if (rows.filter((r) => r.userId === userId && r.createdFrom === "binding_recovery" && r.issuedAt > clock.now - 86_400_000).length >= p.recoveriesPerDay)
        return { ok: false, reason: "recovery_limited" };
      let revokedCount = 0;
      for (const r of rows)
        if (r.userId === userId && r.revokedAt === null && ["pending", "active", "renew_only"].includes(state(r))) {
          revokeRow(r, "recovered");
          revokedCount++;
        }
      const row = pending(userId, tokenHash, "binding_recovery", null, p.credential);
      row.confirmedAt = clock.now;
      c.consumedAt = clock.now;
      return { ok: true, userId, credentialId: row.id, expiresAt: iso(row.expiresAt), renewUntil: iso(row.renewUntil), revokedCount };
    },
    async revokeAllForPrincipal({ actorUserId, targetUserId }): Promise<StopResult> {
      guard("revokeAllForPrincipal");
      const u = init.users[targetUserId];
      if (!u) return { ok: false, reason: "principal_not_found" };
      if (isWallet(u) || u.internal) return { ok: false, reason: "not_agent" };
      const existing = stops.get(targetUserId);
      if (!existing || existing.liftedAt !== null) stops.set(targetUserId, { stoppedAt: clock.now, stoppedBy: actorUserId, liftedAt: null });
      let revokedCount = 0;
      for (const r of rows)
        if (r.userId === targetUserId && r.revokedAt === null && ["pending", "active", "renew_only"].includes(state(r))) {
          revokeRow(r, "admin_revoked");
          revokedCount++;
        }
      return { ok: true, revokedCount };
    },
    async liftStop({ targetUserId }): Promise<LiftResult> {
      guard("liftStop");
      const stop = stops.get(targetUserId);
      if (stop && stop.liftedAt === null) {
        stop.liftedAt = clock.now;
        return { ok: true };
      }
      return { ok: false, reason: init.users[targetUserId] ? "not_stopped" : "principal_not_found" };
    },
    async listKeyHolders(limit) {
      guard("listKeyHolders");
      const all: Array<KeyHolder & { stopped: boolean }> = [];
      for (const [id, u] of Object.entries(init.users)) {
        if (isWallet(u) || u.internal) continue;
        const stopped = isStopped(id);
        const live = rows.some((r) => r.userId === id && ["active", "renew_only"].includes(state(r)));
        const signed = u.roles === true && !rows.some((r) => r.userId === id && r.confirmedAt !== null) && !stops.has(id);
        if (stopped || live || signed) all.push({ userId: id, name: `name-${id}`, githubId: githubIdOf(id, u), on: !stopped, stopped });
      }
      all.sort((a, b) => Number(b.stopped) - Number(a.stopped) || a.userId.localeCompare(b.userId));
      return { holders: all.slice(0, limit).map(({ stopped: _s, ...h }) => h), more: Math.max(0, all.length - limit) };
    },
  };
  return { store, rows, clock, outage, users: init.users, challenges, stops, identityEvents, bindingsOf, advance: (sec: number) => void (clock.now += sec * 1000) };
}
