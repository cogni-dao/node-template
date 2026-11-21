// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/admin-acts-in-admin`
 * Purpose: ADMIN_ACTS_IN_ADMIN import lock (task.0114, task.0116). The admin port, its mint and the admin UI live only in the Admin area, and no other
 *   file asks the node-admin question. The lock fails on a new violation; the allowlist below holds today's violations and may only shrink (task.0115).
 * Scope: Reads source files only; renders nothing.
 * Invariants: ADMIN_ACTS_IN_ADMIN; ONE_MINT (no `as AdminSession` outside the mint); a stale allowlist entry fails.
 * Side-effects: filesystem reads
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../../../src");
const ADMIN_DIRS = ["app/(admin)/", "app/api/v1/admin/"];
const MINT = "app/(admin)/_lib/admin-session.ts";

/** Wiring that may name the port: its definition and the container that builds it. The routes and pages reach it only through the container. */
const PORT_WIRING = ["ports/node-admin.port.ts", "ports/index.ts", "bootstrap/node-admin-port.ts", "bootstrap/container.ts"];

/** Callers of the node-admin question (`adminCheck(`, `checkNodeAdmin(`, `nodeAdmin.check(`) and the roster lookup (`isDaoAdmin(`) outside the Admin area. An entry must be the one adminCheck (ONE_ADMIN_CHECK) or the roster beneath it, with its reason; the removed legacy asks (`isLedgerApprover(`, `checkApprover(`) stay in ASK so a reintroduction fails. */
const ASK_ALLOWLIST: ReadonlyArray<{ path: string; reason: string }> = [
  { path: "app/api/v1/attribution/_lib/admin-guard.ts", reason: "attribution write and read gate: a thin wrapper over the one adminCheck (ONE_ADMIN_CHECK)" },
  { path: "app/api/v1/service-links/ask/route.ts", reason: "starts this node's AI enrollment on a configured remote node: the one adminCheck (ONE_ADMIN_CHECK), any credential" },
  { path: "app/api/v1/orgs/[orgId]/suspension/route.ts", reason: "suspends or resumes an org: the one adminCheck (ONE_ADMIN_CHECK), a cookie session only" },
  { path: "app/api/v1/orgs/outbound/route.ts", reason: "makes this node sign a link for an org on another node: the one adminCheck (ONE_ADMIN_CHECK), a cookie session only" },
  { path: "app/api/v1/payments/steward-withdrawal/route.ts", reason: "steward top-up gate: the one adminCheck (ONE_ADMIN_CHECK)" },
  { path: "app/(app)/gov/review/page.tsx", reason: "Finish Epoch eligibility hint: the one adminCheck (ONE_ADMIN_CHECK)" },
  { path: "app/_facades/work/items.server.ts", reason: "work-items facade: priority 0/1 through container.nodeAdmin, which is the one adminCheck (ONE_ADMIN_CHECK)" },
  { path: "bootstrap/node-admin-gate.ts", reason: "the roster beneath adminCheck, and the adminCheck-backed NodeAdminAuthority" },
  { path: "bootstrap/agent-authority.ts", reason: "defines the one adminCheck over bound wallets, and the tool guard" },
  { path: "app/(admin)/admin/payments/money-plane.server.ts", reason: "payments page gate: the one adminCheck (ONE_ADMIN_CHECK)" },
  { path: "app/(app)/layout.tsx", reason: "shows the Admin nav hint: the one adminCheck (ONE_ADMIN_CHECK)" },
  { path: "app/(admin)/layout.tsx", reason: "layout gate: the one adminCheck (ONE_ADMIN_CHECK)" },
  { path: "app/api/v1/agent/me/route.ts", reason: "self-check reports the one adminCheck (ONE_ADMIN_CHECK)" },
  { path: "shared/config/repoSpec.server.ts", reason: "isDaoAdmin definition: the roster lookup, called only beneath adminCheck" },
];
const ASK = /\b(isDaoAdmin|isLedgerApprover|checkApprover|checkNodeAdmin|adminCheck)\(|\bnodeAdmin\.check\(/;
// The container also hands the node-admin authority to the knowledge store and work-item capability as an object (not a call), so those files have no match to list.

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
const files = sourceFiles(SRC).map((file) => ({ rel: relative(SRC, file), text: readFileSync(file, "utf8") }));
const outsideAdmin = files.filter((f) => !ADMIN_DIRS.some((dir) => f.rel.startsWith(dir)));
const importsOf = (text: string) => text.match(/import[^;]*?from\s*["'][^"']+["']/g) ?? [];

describe("ADMIN_ACTS_IN_ADMIN", () => {
  it("imports the admin agent-access endpoints only from the Admin area, and AgentAccessSection only from the Admin area and the profile's account-mode mount", () => {
    const adminEndpoints = files.filter((f) => /from\s+["'][^"']*\/agent-access-endpoints["']/.test(f.text));
    expect(adminEndpoints.length).toBeGreaterThan(0);
    expect(adminEndpoints.map((f) => f.rel).filter((rel) => !ADMIN_DIRS.some((dir) => rel.startsWith(dir)))).toEqual([]);
    const sections = files.filter((f) => /import[^;]*\bAgentAccessSection\b[^;]*from/.test(f.text));
    expect(sections.length).toBeGreaterThan(0);
    // Outside the Admin area only the profile mount may import it, and only in account mode (a person's own account, never node-wide rows).
    const outside = sections.filter((f) => !ADMIN_DIRS.some((dir) => f.rel.startsWith(dir)));
    expect(outside.map((f) => f.rel)).toEqual(["app/(app)/profile/AiAccessProfile.client.tsx"]);
    expect(outside[0]?.text).toContain('mode="account"');
    expect(outside[0]?.text).not.toMatch(/api\/v1\/admin|\(admin\)/);
  });

  it("names NodeAdminPort, AdminSession, nodeAdminPort or the admin-session mint only in the Admin area and the explicit port wiring", () => {
    const outside = outsideAdmin
      .filter((f) => !PORT_WIRING.includes(f.rel))
      .filter((f) => importsOf(f.text).some((i) => /node-admin\.port|admin-session|\b(NodeAdminPort|AdminSession)\b/.test(i)) || /\bnodeAdminPort\b/.test(f.text));
    expect(outside.map((f) => f.rel)).toEqual([]);
  });

  it("makes an AdminSession only in the mint", () => {
    const minters = files.filter((f) => /\bas\s+AdminSession\b|<AdminSession>/.test(code(f.text))).map((f) => f.rel);
    expect(minters).toEqual([MINT]);
  });

  it("asks the node-admin question (isDaoAdmin, isLedgerApprover, checkApprover, checkNodeAdmin, nodeAdmin.check) only where the allowlist says", () => {
    const allowed = (rel: string) => ASK_ALLOWLIST.some((entry) => rel.startsWith(entry.path));
    // The mint is the one place that asks. Every other file, in the Admin area or not, is a violation unless listed.
    const violations = files.filter((f) => f.rel !== MINT && ASK.test(code(f.text))).map((f) => f.rel);
    expect(violations.filter((rel) => !allowed(rel))).toEqual([]);
    // The list can only shrink: an entry nothing matches any more must be deleted.
    const stale = ASK_ALLOWLIST.filter((entry) => !violations.some((rel) => rel.startsWith(entry.path))).map((entry) => entry.path);
    expect(stale).toEqual([]);
  });

  it("calls the roster lookup (isDaoAdmin) only beneath the one admin check, and never the retired login-wallet asks (isLedgerApprover, checkApprover)", () => {
    // Defect: a route that asked the roster with the session's login wallet admitted a login wallet with no bound wallet and refused a bearer.
    const ROSTER_ONLY = ["bootstrap/node-admin-gate.ts", "shared/config/repoSpec.server.ts"];
    const callers = files.filter((f) => /\b(isDaoAdmin|isLedgerApprover|checkApprover)\(/.test(code(f.text))).map((f) => f.rel);
    expect(callers.sort()).toEqual([...ROSTER_ONLY].sort());
    expect(files.filter((f) => /\b(isLedgerApprover|checkApprover)\b/.test(code(f.text))).map((f) => f.rel)).toEqual([]);
  });

  it("reads the approver list (getLedgerApprovers) or builds the roster authority only where listed, so `getLedgerApprovers().includes(wallet)` cannot re-derive admin", () => {
    // Defect: re-deriving admin from the roster with a login wallet bypasses the one admin check and the lock above.
    const ROSTER_READERS: Record<string, string> = {
      "app/api/v1/attribution/epochs/[id]/review/route.ts": "pins the approver set on the epoch (data, not authority)",
      "app/api/internal/attribution/collect/route.ts": "passes the approver set to the collect workflow as data",
      "bootstrap/node-admin-gate.ts": "the roster authority beneath adminCheck",
      "shared/config/repoSpec.server.ts": "definition, and the isDaoAdmin roster lookup",
      "bootstrap/container.ts": "builds the roster once and hands it to the agent authority",
    };
    const callers = files.filter((f) => /\b(getLedgerApprovers|createApproversNodeAdminAuthority)\(/.test(code(f.text))).map((f) => f.rel);
    expect(callers.filter((rel) => !(rel in ROSTER_READERS))).toEqual([]);
    expect(Object.keys(ROSTER_READERS).filter((rel) => !callers.includes(rel))).toEqual([]);
  });
});
