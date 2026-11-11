// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { CredentialPolicy, CredentialStore } from "../src/credentials";
import type {
  CreateEnrollmentResult,
  EnrollmentStatus,
  EnrollmentStore,
  PollOutcome,
  ServiceEnrollmentCnfJwk,
} from "../src/enrollment";
import { MAX_PENDING_PER_AGENT, MAX_PENDING_TOTAL } from "../src";
import { memoryCredentialStore } from "./credentials-memory-store";

interface EnrollmentRow {
  id: string;
  jti: string;
  principalUserId: string;
  scope: string;
  deviceCodeHash: string;
  cnfJwk: ServiceEnrollmentCnfJwk;
  status: EnrollmentStatus;
  credentialId: string | null;
  expiresAt: number;
  lastPolledAt: number | null;
}
interface PrincipalRow {
  userId: string;
  serviceKey: string;
  createdAt: number;
}
interface RoleRow {
  principal: string;
  scope: string;
  approved: boolean;
  revoked: boolean;
}

/**
 * Enrollment store over memory with the same semantics as the Postgres adapter's SQL, sharing ONE database clock and the credential rows of
 * `memoryCredentialStore`. The trigger `agent_credentials_enrollment_confirm_siblings` is played by the wrapped `confirm`.
 */
export function memoryEnrollmentStore(init: { failing?: boolean } = {}) {
  const creds = memoryCredentialStore({ users: {}, failing: init.failing });
  const { clock, rows: credentialRows } = creds;
  const enrollments: EnrollmentRow[] = [];
  const principals: PrincipalRow[] = [];
  const roles: RoleRow[] = [];
  let seq = 0;
  const guard = () => {
    if (init.failing) throw new Error("db down");
  };
  const sweepUnredeemed = () => {
    for (const p of [...principals]) {
      const stale = p.createdAt < clock.now - 24 * 3600 * 1000;
      const hasCredential = credentialRows.some((c) => c.userId === p.userId);
      const approved = roles.some((r) => r.principal === p.userId && r.approved);
      const open = enrollments.some((e) => e.principalUserId === p.userId && e.status === "open" && e.expiresAt > clock.now);
      if (stale && !hasCredential && !approved && !open) {
        for (const list of [enrollments, roles] as Array<Array<{ principalUserId?: string; principal?: string }>>)
          for (let i = list.length - 1; i >= 0; i--) if ((list[i]?.principalUserId ?? list[i]?.principal) === p.userId) list.splice(i, 1);
        principals.splice(principals.indexOf(p), 1);
      }
    }
  };

  const store: EnrollmentStore = {
    async createEnrollment(input): Promise<CreateEnrollmentResult> {
      guard();
      sweepUnredeemed();
      if (enrollments.some((e) => e.jti === input.claims.jti)) return { ok: false, reason: "replayed_token" };
      for (const e of enrollments) if (e.status === "open" && e.expiresAt <= clock.now) e.status = "expired";
      for (const e of enrollments) if (e.status === "open" && credentialRows.find((c) => c.id === e.credentialId)?.confirmedAt != null) e.status = "redeemed";
      const existing = principals.find((p) => p.serviceKey === input.serviceKey);
      if (enrollments.filter((e) => e.status === "open" && e.principalUserId !== (existing?.userId ?? "")).length >= input.limits.openEnrollments)
        return { ok: false, reason: "too_many_enrollments" };
      let userId: string;
      if (!existing) {
        if (principals.length >= input.limits.enrolledAgents) return { ok: false, reason: "too_many_agents" };
        userId = `svc-user-${++seq}`;
        principals.push({ userId, serviceKey: input.serviceKey, createdAt: clock.now });
      } else {
        userId = existing.userId;
        for (const r of roles) if (r.principal === userId && r.scope === input.scope && !r.revoked) r.revoked = true;
        for (const e of enrollments) if (e.principalUserId === userId && e.status === "open") e.status = "expired";
      }
      const pendingAll = roles.filter((r) => !r.approved && !r.revoked).length;
      const pendingMine = roles.filter((r) => r.principal === userId && !r.approved && !r.revoked).length;
      if (pendingMine >= MAX_PENDING_PER_AGENT || pendingAll >= MAX_PENDING_TOTAL) {
        if (!existing) principals.pop();
        return { ok: false, reason: "node_full" };
      }
      roles.push({ principal: userId, scope: input.scope, approved: false, revoked: false });
      const id = `enrollment-${++seq}`;
      enrollments.push({
        id,
        jti: input.claims.jti,
        principalUserId: userId,
        scope: input.scope,
        deviceCodeHash: input.deviceCodeHash,
        cnfJwk: input.claims.cnf.jwk,
        status: "open",
        credentialId: null,
        expiresAt: clock.now + input.limits.deviceCodeSec * 1000,
        lastPolledAt: null,
      });
      return { ok: true, principalUserId: userId, enrollmentId: id, principalCreated: !existing };
    },

    async poll({ deviceCodeHash, tokenHash, policy, intervalSec }): Promise<PollOutcome> {
      guard();
      const e = enrollments.find((x) => x.deviceCodeHash === deviceCodeHash);
      if (!e) return { state: "expired_token" };
      if (e.status === "denied") return { state: "access_denied" };
      if (e.status !== "open") return { state: "expired_token" };
      if (e.expiresAt <= clock.now) {
        e.status = "expired";
        for (const r of roles) if (r.principal === e.principalUserId && r.scope === e.scope && !r.approved && !r.revoked) r.revoked = true;
        sweepUnredeemed();
        return { state: "expired_token" };
      }
      if (e.lastPolledAt !== null && e.lastPolledAt > clock.now - intervalSec * 1000) return { state: "slow_down" };
      e.lastPolledAt = clock.now;
      const role = [...roles].reverse().find((r) => r.principal === e.principalUserId && r.scope === e.scope);
      if (!role) {
        e.status = "denied";
        return { state: "access_denied" };
      }
      if (!role.approved && !role.revoked) return { state: "authorization_pending" };
      if (role.revoked) {
        e.status = "denied";
        return { state: "access_denied" };
      }
      const previous = e.credentialId;
      if (previous) {
        const prev = credentialRows.find((c) => c.id === previous);
        if (prev?.confirmedAt != null) {
          e.status = "redeemed";
          return { state: "expired_token" };
        }
        if (prev && prev.revokedAt === null && prev.confirmedAt === null) {
          prev.revokedAt = clock.now;
          prev.revokedReason = "superseded";
        }
      }
      const p: CredentialPolicy = policy;
      const row = {
        id: `00000000-0000-4000-9000-${String(++seq).padStart(12, "0")}`,
        userId: e.principalUserId,
        tokenHash,
        createdFrom: "service_enrollment",
        predecessorId: null,
        expiresAt: clock.now + p.ttlSec * 1000,
        renewUntil: clock.now + (p.ttlSec + p.renewWindowSec) * 1000,
        pendingExpiresAt: clock.now + p.pendingSec * 1000,
        confirmedAt: null,
        revokedAt: null,
        revokedReason: null,
      };
      credentialRows.push(row);
      e.credentialId = row.id;
      return {
        state: "issued",
        enrollmentId: e.id,
        credentialId: row.id,
        userId: e.principalUserId,
        pendingExpiresAt: new Date(row.pendingExpiresAt).toISOString(),
        cnfJwk: e.cnfJwk,
      };
    },
  };

  // The SQL trigger: a confirmed enrollment key revokes every other unrevoked key of its principal in the same statement.
  const credentials: CredentialStore = {
    ...creds.store,
    async confirm(input) {
      const row = credentialRows.find((r) => r.id === input.credentialId);
      const pending = row?.confirmedAt === null && row.createdFrom === "service_enrollment";
      const result = await creds.store.confirm(input);
      if (pending && row && result.ok && result.status === "confirmed")
        for (const other of credentialRows)
          if (other.userId === row.userId && other.id !== row.id && other.revokedAt === null) {
            other.revokedAt = clock.now;
            other.revokedReason = "superseded";
          }
      return result;
    },
  };

  return {
    store,
    credentials,
    enrollments,
    principals,
    roles,
    credentialRows,
    clock,
    approve(userId: string, scope: string) {
      const r = roles.find((x) => x.principal === userId && x.scope === scope && !x.revoked && !x.approved);
      if (r) r.approved = true;
    },
    dismiss(userId: string, scope: string) {
      const r = roles.find((x) => x.principal === userId && x.scope === scope && !x.revoked && !x.approved);
      if (r) r.revoked = true;
    },
    switchOff(userId: string, scope: string) {
      const r = roles.find((x) => x.principal === userId && x.scope === scope && !x.revoked && x.approved);
      if (r) r.revoked = true;
    },
    broken: () => memoryEnrollmentStore({ failing: true }).store,
  };
}
