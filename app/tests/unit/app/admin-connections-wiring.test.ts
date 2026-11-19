// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/admin-connections-wiring`
 * Purpose: Wiring for connect from home (story.0038) that no behaviour test covers: the two admin pages live in the `(admin)` group and render ONLY the package's sections
 *   (`ConnectedOrgsSection`, `ConnectionsSection` from `@cogni-dao/knowledge-base-ui`: the app keeps routes, the endpoints object and the page mounts); their endpoints point at admin-area routes that mint
 *   their session through `requireAdminSession` and write through `NodeAdminPort`.
 * Scope: Reads source files; renders nothing. The tables' behaviour and UI parity are tested in the package.
 * Invariants: ADMIN_ACTS_IN_ADMIN, HUMAN_ROUTES_SESSION_ONLY, UI_PARITY (one shared table, no node-local copy).
 * Side-effects: filesystem reads
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { CONNECTED_ORGS_ENDPOINTS, CONNECTED_ORGS_PATH } from "@/app/(admin)/admin/connected-orgs/connected-orgs-endpoints";
import { CONNECTIONS_ENDPOINTS, CONNECTIONS_PATH } from "@/app/(admin)/admin/connections/connections-endpoints";

const SRC = resolve(__dirname, "../../../src");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

describe("connect from home pages", () => {
  it("each page sits under the (admin) group, keeps the AI access page's container and carries no subtitle, and mounts the package's section with this node's endpoints only", () => {
    for (const [dir, mount, section, endpoints] of [
      ["connections", "Connections.mount.tsx", "ConnectionsSection", "CONNECTIONS_ENDPOINTS"],
      ["connected-orgs", "ConnectedOrgs.mount.tsx", "ConnectedOrgsSection", "CONNECTED_ORGS_ENDPOINTS"],
    ] as const) {
      const page = read(`app/(admin)/admin/${dir}/page.tsx`);
      expect(page).toContain('<PageContainer maxWidth="2xl">');
      // CEO: humans do not want to read. No subtitle or description sentence under the header: the page is the section.
      expect(page).not.toMatch(/<p[\s>]/);
      const view = read(`app/(admin)/admin/${dir}/${mount}`);
      expect(view).toContain(`import { ${section} } from "@cogni/knowledge-base-ui";`);
      expect(view).toContain(`<${section} endpoints={${endpoints}} />`);
      // No node-local copy of the table: the directory holds only the page, the mount and the endpoints object.
      expect(readdirSync(resolve(SRC, `app/(admin)/admin/${dir}`)).sort()).toEqual([mount, `${dir}-endpoints.ts`, "page.tsx"].sort());
    }
  });

  it("the endpoints point at existing admin-area routes that mint through requireAdminSession and write through the port", () => {
    expect(CONNECTED_ORGS_PATH).toBe("/api/v1/admin/connected-orgs");
    expect(CONNECTED_ORGS_ENDPOINTS).toEqual({ list: CONNECTED_ORGS_PATH });
    expect(CONNECTIONS_PATH).toBe("/api/v1/admin/connections");
    expect(CONNECTIONS_ENDPOINTS).toEqual({ connections: CONNECTIONS_PATH });
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
    const customer = read(`app${CONNECTIONS_PATH}/route.ts`);
    for (const verb of ["GET", "POST"]) expect(customer).toMatch(new RegExp(`export const ${verb} =`));
  });
});
