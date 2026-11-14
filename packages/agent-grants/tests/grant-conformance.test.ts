// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Grant conformance suite (task.5465, SUITE_GATES_RELEASE) over the package's memory store. The same rows (`runGrantConformance`) run in a node
 * over real Postgres as the real app role. The memory store has the SQL adapter's semantics.
 */

import { describe, expect, it } from "vitest";
import { runGrantConformance } from "../src/grants-conformance";
import { memoryStore } from "./memory-store";

let current: ReturnType<typeof memoryStore> | undefined;

runGrantConformance({
  describe,
  it,
  expect,
  async setup({ owners, agents, internal }) {
    const ids = Object.fromEntries([...owners, ...agents, ...internal].map((name) => [name, `user-${name}`]));
    const accounts = Object.fromEntries(owners.map((name) => [name, `acct-${name}`]));
    current = memoryStore({
      principals: Object.fromEntries(internal.map((name) => [name, ids[name] as string])),
      accounts: Object.fromEntries(owners.map((name) => [ids[name] as string, accounts[name] as string])),
      names: Object.fromEntries(agents.map((name) => [ids[name] as string, name])),
    });
    return { store: current, ids, accounts };
  },
  async expireGrant(principalUserId, scope) {
    const row = current?.roles.find((r) => r.principal === principalUserId && r.scope === scope && r.resource === "account" && !r.revoked && r.approvedBy);
    if (!row || !current) throw new Error("no live account row");
    row.expiresAt = current.clock.now - 1;
  },
  async expireLink(principalUserId, scope) {
    const row = current?.roles.find((r) => r.principal === principalUserId && r.scope === scope && !r.revoked && !r.approvedBy);
    if (!row || !current) throw new Error("no pending row");
    row.linkExpiresAt = current.clock.now - 1;
  },
  broken: () => memoryStore({ failing: true }),
});
