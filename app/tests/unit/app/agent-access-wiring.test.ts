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
      expect(source).toMatch(new RegExp(`export const ${verb} = adminRoute\\(`));
    // Every handler takes its AdminSession from the one mint (inside the Admin route builder), and writes through the port.
    const builder = read("app/api/v1/admin/_lib/ai-access-route.ts");
    expect(builder.match(/requireAdminSession\(request, /g)?.length).toBe(1);
    expect(builder).toContain("nodeAdminPort");
    expect(`${source}${builder}`).not.toMatch(/agentAuthority|adminCheck/);
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
    expect(mine.match(/= mineRoute\(/g)?.length).toBe(3);
    const builder = read("app/_lib/agent-access/routes.ts");
    expect(builder).toContain("refuseNonSession"); // any Authorization header is refused before a read
    expect(`${mine}${builder}`).not.toMatch(/requireAdminSession|nodeAdminPort|adminCheck/); // an account decision never takes an admin session
    const preview = readFileSync(resolve(SRC, `app${AGENT_ACCESS_MINE_PREVIEW_PATH}/route.ts`), "utf8");
    expect(preview).toMatch(/export const POST = mineRoute\(/);
    const adminPreview = readFileSync(resolve(SRC, "app/api/v1/admin/ai-access/preview/route.ts"), "utf8");
    expect(adminPreview).toMatch(/export const POST = adminRoute\(/);
    expect(AGENT_ACCESS_ENDPOINTS.preview).toBe("/api/v1/admin/ai-access/preview");
  });

  it("every bearer-reachable GET keyed to a billing account declares the ONE account scope: the credits twin by path, the credits summary by query", () => {
    const summary = readFileSync(resolve(SRC, "app/api/v1/payments/credits/summary/route.ts"), "utf8");
    expect(summary).toContain('sameDoor: "core__account_credits_read"');
    expect(summary).toContain('sameDoorAccountQuery: "accountId"');
    // Routes that stay un-gated, each for a stated reason: the activity feed and the profile read are session-only (no bearer reaches them), the payment
    // attempt status poll can settle credits (a write, not a read), and runs and threads are keyed to the user, not to a billing account.
    for (const rel of ["app/api/v1/activity/route.ts", "app/api/v1/users/me/route.ts"])
      expect(readFileSync(resolve(SRC, rel), "utf8")).toContain("getServerSessionUser");
    expect(readFileSync(resolve(SRC, "app/api/v1/payments/attempts/[id]/route.ts"), "utf8")).not.toContain("sameDoor");
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
