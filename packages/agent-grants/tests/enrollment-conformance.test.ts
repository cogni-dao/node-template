// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Service enrollment conformance suite (story.0038, SUITE_GATES_RELEASE) over the package's memory store. The same rows
 * (`runEnrollmentConformance`) run in a node over real Postgres. The memory store has the SQL adapter's semantics.
 */

import { describe, expect, it } from "vitest";
import { type EnrollmentConformanceSetup, runEnrollmentConformance } from "../src/enrollment/conformance";
import { hashAgentKey } from "../src/credentials";
import { memoryEnrollmentStore } from "./enrollment-memory-store";

runEnrollmentConformance({
  describe,
  it,
  expect,
  async setup(): Promise<EnrollmentConformanceSetup> {
    const m = memoryEnrollmentStore();
    return {
      store: m.store,
      credentials: m.credentials,
      askableScopes: ["knowledge:read", "knowledge:contribute"],
      async approve(userId, scope) {
        m.approve(userId, scope);
      },
      async dismiss(userId, scope) {
        m.dismiss(userId, scope);
      },
      async switchOff(userId, scope) {
        m.switchOff(userId, scope);
      },
      async switchOn(userId, scope) { m.switchOn(userId, scope); },
      async hasLiveRole(userId, scope) {
        return m.roles.some((r) => r.principal === userId && r.scope === scope && r.approved && !r.revoked);
      },
      async pendingAsks(userId, scope) {
        return m.roles.filter((r) => r.principal === userId && r.scope === scope && !r.approved && !r.revoked).length;
      },
      async skipPollInterval() {
        for (const e of m.enrollments) e.lastPolledAt = e.lastPolledAt === null ? null : m.clock.now - 60_000;
      },
      async lapse(userId) {
        for (const e of m.enrollments) if (e.principalUserId === userId) e.expiresAt = m.clock.now - 1;
        for (const r of m.roles) if (r.principal === userId && !r.approved) r.expiresAt = m.clock.now - 1;
      },
      async expireCredential(credentialId) {
        const row = m.credentialRows.find((r) => r.id === credentialId);
        if (!row) throw new Error("credential not found");
        row.expiresAt = m.clock.now - 2;
        row.renewUntil = m.clock.now - 1;
        row.pendingExpiresAt = m.clock.now - 1;
      },
      async ageUnredeemed(userId) {
        const p = m.principals.find((x) => x.userId === userId);
        if (p) p.createdAt = m.clock.now - 25 * 3600 * 1000;
      },
      async principalExists(userId) {
        return m.principals.some((p) => p.userId === userId);
      },
      async deviceCodeStoredPlain(code) {
        return m.enrollments.some((e) => Object.values(e).includes(code));
      },
      async deviceCodeHashStored(code) {
        const hash = await hashAgentKey(code);
        return m.enrollments.some((e) => e.deviceCodeHash === hash);
      },
      async storedHash(credentialId) {
        return m.credentialRows.find((r) => r.id === credentialId)?.tokenHash ?? null;
      },
      broken: m.broken,
    };
  },
});
