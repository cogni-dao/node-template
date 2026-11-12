// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Credential conformance suite (task.0070, SUITE_GATES_RELEASE) over the package's memory store. The same rows
 * (`runCredentialConformance`) run in a node over real Postgres. The memory store has the SQL adapter's semantics.
 */

import { describe, expect, it } from "vitest";
import { type ConformanceFacts, runCredentialConformance } from "../src/credentials/conformance";
import { createPostgresCredentialStore, type CredentialSql } from "../src/credentials/postgres";
import { confirmCredential } from "../src/credentials/service";
import { memoryCredentialStore } from "./credentials-memory-store";

let current: ReturnType<typeof memoryCredentialStore> | undefined;

runCredentialConformance({
  describe,
  it,
  expect,
  async setup(users: Record<string, ConformanceFacts>) {
    const ids = Object.fromEntries(Object.keys(users).map((name) => [name, `user-${name}`]));
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
  broken: () => memoryCredentialStore({ users: {}, failing: true }).store,
  storedHash: async (credentialId) => current?.rows.find((r) => r.id === credentialId)?.tokenHash ?? null,
  liveSuccessors: async (predecessorId) =>
    current?.rows.filter((r) => r.predecessorId === predecessorId && r.confirmedAt === null && r.revokedAt === null).length ?? 0,
});


describe("confirmation history rollout", () => {
  it("a confirmed identity remains superseded when its credential audit row is unavailable", async () => {
    const m = memoryCredentialStore({ users: { alice: {} } });
    const issued = await m.store.issueUpgrade({ userId: "alice", tokenHash: "test-hash", policy: { ttlSec: 60, renewWindowSec: 60, pendingSec: 60 } });
    if (!issued.ok) throw new Error("issue refused");
    await confirmCredential(m.store, { credentialId: issued.credentialId });
    m.rows.splice(0); // Reader qualification control, not permission to enable SQL purge.
    expect(await m.store.everConfirmed("alice")).toBe(true);
    expect(await m.store.everConfirmed("never-confirmed")).toBe(false);
  });

  it("an incomplete migration fails closed instead of reporting never confirmed", async () => {
    const sql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("pg_roles")) return [{ bypass: true }];
      if (query.includes("agent_authority_maintenance")) return [{ backfill_ready: false }];
      throw new Error("history must not be read as a fallback to incomplete migration");
    }) as unknown as CredentialSql;
    const store = createPostgresCredentialStore(sql, { hasRoles: async () => false });
    await expect(store.everConfirmed("alice")).rejects.toThrow("confirmation migration incomplete");
  });
});
