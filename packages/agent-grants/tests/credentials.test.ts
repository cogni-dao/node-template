// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Credential conformance suite (task.0070, SUITE_GATES_RELEASE) over the package's memory store. The same rows
 * (`runCredentialConformance`) run in a node over real Postgres. The memory store has the SQL adapter's semantics.
 */

import { describe, expect, it } from "vitest";
import { type ConformanceFacts, runCredentialConformance } from "../src/credentials/conformance";
import { memoryCredentialStore } from "./credentials-memory-store";

let current: ReturnType<typeof memoryCredentialStore> | undefined;

runCredentialConformance({
  describe,
  it,
  expect,
  async setup(users: Record<string, ConformanceFacts>) {
    const ids = Object.fromEntries(Object.keys(users).map((name) => [name, `user-${name}-${crypto.randomUUID()}`]));
    const facts = Object.fromEntries(Object.entries(users).map(([name, f]) => [ids[name] as string, f]));
    current = memoryCredentialStore({ users: facts });
    return { store: current.store, ids };
  },
  async age(credentialId, to) {
    const row = current?.rows.find((r) => r.id === credentialId);
    if (!row || !current) throw new Error("unknown credential");
    const past = current.clock.now - 1000;
    const future = current.clock.now + 86_400_000;
    if (to === "pending_expired") row.pendingExpiresAt = past;
    else {
      row.expiresAt = past;
      row.renewUntil = to === "renew_only" ? future : past;
    }
  },
  async addRoles(userId) {
    const user = current?.users[userId];
    if (!user) throw new Error("unknown user");
    user.roles = true;
  },
  async expireChallenge(challengeId) {
    const c = current?.challenges.find((x) => x.id === challengeId);
    if (!c || !current) throw new Error("unknown challenge");
    c.expiresAt = current.clock.now - 1000;
  },
  async challengeInfo(challengeId) {
    const c = current?.challenges.find((x) => x.id === challengeId);
    return c ? { attempts: c.attempts, consumed: c.consumedAt !== null } : null;
  },
  async credentialRows(userId) {
    return current?.rows.filter((r) => r.userId === userId).length ?? 0;
  },
  async githubBindings(userId) {
    return current?.bindingsOf(userId) ?? [];
  },
  async bindEvents(userId) {
    return current?.identityEvents.filter((e) => e.userId === userId).length ?? 0;
  },
  broken: () => memoryCredentialStore({ users: {}, failing: true }).store,
  storedHash: async (credentialId) => current?.rows.find((r) => r.id === credentialId)?.tokenHash ?? null,
  liveSuccessors: async (predecessorId) =>
    current?.rows.filter((r) => r.predecessorId === predecessorId && r.confirmedAt === null && r.revokedAt === null).length ?? 0,
});
