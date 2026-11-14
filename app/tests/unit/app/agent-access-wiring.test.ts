// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/agent-access-wiring`
 * Purpose: S1 wiring that no other test covers (task.5456): the admin-area route the admin AI-access page calls, its mount, and its absence from the profile. (The DTO-equals-view guarantee is a compile-time check in
 *   src/app/_lib/agent-access/dto-type-check.ts; a vitest test cannot enforce types.)
 * Scope: Reads source files and imports route modules; renders nothing. Fails if the admin page's endpoint path stops pointing at an existing admin-area route, or if an old route returns.
 * Invariants: HUMAN_ROUTES_SESSION_ONLY, NON_ADMIN_SEES_NOTHING (wiring half).
 * Side-effects: filesystem reads
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AGENT_ACCESS_ENDPOINTS,
  AGENT_ACCESS_ROLES_PATH,
} from "@/app/(admin)/admin/ai-access/agent-access-endpoints";
import {
  AGENT_ACCESS_MINE_ENDPOINTS,
  AGENT_ACCESS_MINE_PATH,
  AGENT_ACCESS_MINE_PREVIEW_PATH,
} from "@/app/(app)/profile/agent-access-mine-endpoints";

const SRC = resolve(__dirname, "../../../src");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

describe("S1 wiring", () => {
  it("points the AI-access page at an existing admin-area route that serves GET, POST and DELETE", async () => {
    expect(AGENT_ACCESS_ROLES_PATH).toBe("/api/v1/admin/ai-access");
    expect(AGENT_ACCESS_ENDPOINTS.roles).toBe(AGENT_ACCESS_ROLES_PATH);
    const route = resolve(SRC, `app${AGENT_ACCESS_ROLES_PATH}/route.ts`);
    expect(existsSync(route)).toBe(true);
    const source = readFileSync(route, "utf8");
    for (const verb of ["GET", "POST", "DELETE"])
      expect(source).toMatch(new RegExp(`export const ${verb} =`));
    // Every handler takes its AdminSession from the one mint, and writes through the port.
    expect(source.match(/requireAdminSession\(request, /g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain("nodeAdminPort");
    expect(source).not.toMatch(/agentAuthority|adminCheck/);
  });

  it("uses that endpoint in the admin AI-access client and mounts the block there", () => {
    const view = read("app/(admin)/admin/ai-access/AiAccess.client.tsx");
    expect(view).toContain('from "./agent-access-endpoints"');
    expect(view).toContain("<AgentAccessSection endpoints={AGENT_ACCESS_ENDPOINTS} token={token} />");
    expect(view).toContain("useApprovalFragment()");
    expect(view).not.toMatch(/\/api\/v1\/agent\/roles/);
  });

  it("the profile mounts the SAME section in account mode with the mine endpoints, never the admin endpoint, and the admin page is linked from the admin index", () => {
    const profile = read("app/(app)/profile/view.tsx");
    expect(profile).toContain("<AiAccessProfile />");
    expect(profile).not.toContain("AgentAccessSection");
    expect(profile).not.toContain("agent-access-endpoints");
    expect(existsSync(resolve(SRC, "app/(app)/profile/agent-access-endpoints.ts"))).toBe(false);
    const mount = read("app/(app)/profile/AiAccessProfile.client.tsx");
    expect(mount).toContain('<AgentAccessSection mode="account" endpoints={AGENT_ACCESS_MINE_ENDPOINTS} token={token} />');
    expect(mount).toContain("useApprovalFragment()");
    expect(mount).not.toMatch(/api\/v1\/admin|\(admin\)/);
    expect(read("app/(admin)/admin/page.tsx")).toContain('href="/admin/ai-access"');
    expect(existsSync(resolve(SRC, "app/(app)/gov/ai-access"))).toBe(false);
  });

  it("the profile endpoints point at existing session-only routes: mine (GET, POST, DELETE) and its preview (POST), each refusing an Authorization header first", () => {
    expect(AGENT_ACCESS_MINE_PATH).toBe("/api/v1/agent-access/mine");
    expect(AGENT_ACCESS_MINE_ENDPOINTS).toEqual({ roles: AGENT_ACCESS_MINE_PATH, preview: AGENT_ACCESS_MINE_PREVIEW_PATH });
    const mine = readFileSync(resolve(SRC, `app${AGENT_ACCESS_MINE_PATH}/route.ts`), "utf8");
    for (const verb of ["GET", "POST", "DELETE"]) expect(mine).toMatch(new RegExp(`export const ${verb} =`));
    expect(mine.match(/requirePerson\(request, /g)?.length).toBe(3);
    expect(mine).toContain("refuseNonSession");
    expect(mine).not.toMatch(/requireAdminSession|nodeAdminPort|adminCheck/); // an account decision never takes an admin session
    const preview = readFileSync(resolve(SRC, `app${AGENT_ACCESS_MINE_PREVIEW_PATH}/route.ts`), "utf8");
    expect(preview).toMatch(/export const POST =/);
    expect(preview).toContain("refuseNonSession");
    const adminPreview = readFileSync(resolve(SRC, "app/api/v1/admin/ai-access/preview/route.ts"), "utf8");
    expect(adminPreview).toContain("requireAdminSession(request, ");
    expect(AGENT_ACCESS_ENDPOINTS.preview).toBe("/api/v1/admin/ai-access/preview");
  });

  it("the gated credits read declares its door: sameDoor account:read with the account in the path", () => {
    const route = readFileSync(resolve(SRC, "app/api/v1/accounts/[accountId]/credits/route.ts"), "utf8");
    expect(route).toContain('sameDoor: "core__account_credits_read"');
    expect(route).toContain('sameDoorAccountParam: "accountId"');
    expect(route).toMatch(/export const GET =/);
  });

  it("keeps the old AI-plane path and the old human roles route gone", () => {
    expect(existsSync(resolve(SRC, "app/api/v1/agent/roles/route.ts"))).toBe(false);
    expect(existsSync(resolve(SRC, "app/api/v1/agent-access/roles/route.ts"))).toBe(false);
  });
});
