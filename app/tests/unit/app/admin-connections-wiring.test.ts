// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/admin-connections-wiring`
 * Purpose: Wiring for connect from home (story.0038) that no behaviour test covers: the two admin pages live in the `(admin)` group, are linked from the admin index, and call only admin-area
 *   routes that mint their session through `requireAdminSession` and write through `NodeAdminPort`; the pages carry no Authorization header, no filter control and no UI-only gate.
 * Scope: Reads source files; renders nothing.
 * Invariants: ADMIN_ACTS_IN_ADMIN, HUMAN_ROUTES_SESSION_ONLY, UI_PARITY (same layout and table style as the AI access page; no extra filters or controls).
 * Side-effects: filesystem reads
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { allowancePath, CONNECTED_ORGS_PATH, suspensionPath } from "@/app/(admin)/admin/connected-orgs/connected-orgs-endpoints";
import { CONNECTIONS_PATH } from "@/app/(admin)/admin/connections/connections-endpoints";

const SRC = resolve(__dirname, "../../../src");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

describe("connect from home pages", () => {
  it("each page sits under the (admin) group, is linked from the admin index, and keeps the AI access page's layout", () => {
    const index = read("app/(admin)/admin/page.tsx");
    for (const [href, dir] of [
      ["/admin/connections", "connections"],
      ["/admin/connected-orgs", "connected-orgs"],
    ] as const) {
      expect(existsSync(resolve(SRC, `app/(admin)/admin/${dir}/page.tsx`)), dir).toBe(true);
      expect(index).toContain(`href="${href}"`);
    }
    for (const dir of ["connections", "connected-orgs"]) {
      const page = read(`app/(admin)/admin/${dir}/page.tsx`);
      expect(page).toContain('<PageContainer maxWidth="2xl">');
      expect(page).toContain('className="max-w-prose text-muted-foreground"');
    }
    // The same table style as the AI access section: heading, rule, small table with a muted head.
    for (const file of ["connections/Connections.client.tsx", "connected-orgs/ConnectedOrgs.client.tsx"]) {
      const view = read(`app/(admin)/admin/${file}`);
      expect(view).toContain('className="font-semibold text-foreground text-lg"');
      expect(view).toContain('className="mt-2 border-border border-b"');
      expect(view).toContain('className="w-full text-left text-sm"');
      expect(view).toContain('className="text-muted-foreground text-xs"');
    }
  });

  it("the endpoint constants point at existing admin-area routes that mint through requireAdminSession and write through the port", () => {
    expect(CONNECTED_ORGS_PATH).toBe("/api/v1/admin/connected-orgs");
    expect(CONNECTIONS_PATH).toBe("/api/v1/admin/connections");
    expect(allowancePath("org-1")).toBe("/api/v1/admin/connected-orgs/org-1/allowance");
    expect(suspensionPath("org-1")).toBe("/api/v1/admin/connected-orgs/org-1/suspension");
    const routes = [
      `app${CONNECTED_ORGS_PATH}/route.ts`,
      `app${CONNECTED_ORGS_PATH}/[orgUserId]/allowance/route.ts`,
      `app${CONNECTED_ORGS_PATH}/[orgUserId]/suspension/route.ts`,
      `app${CONNECTIONS_PATH}/route.ts`,
    ];
    for (const rel of routes) {
      expect(existsSync(resolve(SRC, rel)), rel).toBe(true);
      const source = read(rel);
      expect(source, rel).toContain("requireAdminSession(request, ");
      expect(source, rel).toContain("nodeAdminPort");
      expect(source, rel).not.toMatch(/agentAuthority|adminCheck|serviceAccountService|createConnections/);
    }
    // The customer's route has both verbs; the allowance and Suspend routes are POST only.
    const customer = read(`app${CONNECTIONS_PATH}/route.ts`);
    for (const verb of ["GET", "POST"]) expect(customer).toMatch(new RegExp(`export const ${verb} =`));
  });

  it("the pages send the browser session only, hold no UI-only gate, and offer only the asked actions (no filter, search or sort control)", () => {
    for (const file of ["connections/Connections.client.tsx", "connected-orgs/ConnectedOrgs.client.tsx"]) {
      const view = read(`app/(admin)/admin/${file}`);
      const code = view.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/authorization|Authorization|Bearer/);
      expect(code, file).not.toMatch(/<select|<Select|type="search"|placeholder="(Search|Filter)/i);
      expect(code, file).not.toMatch(/isAdmin|adminCheck|role ===/);
    }
    const orgs = read("app/(admin)/admin/connected-orgs/ConnectedOrgs.client.tsx");
    for (const label of ["Grant allowance", "Suspend", "Resume"]) expect(orgs).toContain(label);
    const customer = read("app/(admin)/admin/connections/Connections.client.tsx");
    for (const label of ["Connect", "Disconnect", "This node has no signing key"]) expect(customer).toContain(label);
  });
});
