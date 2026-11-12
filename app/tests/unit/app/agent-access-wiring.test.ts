// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/agent-access-wiring`
 * Purpose: S1 wiring that no other test covers (task.5456): the roles endpoint the profile table calls and its mount. (The DTO-equals-view guarantee is a compile-time check in
 *   src/app/_lib/agent-access/dto-type-check.ts; a vitest test cannot enforce types.)
 * Scope: Reads source files and imports route modules; renders nothing. Fails if the profile table's endpoint path stops pointing at an existing human-plane route, or if the old route returns.
 * Invariants: HUMAN_ROUTES_SESSION_ONLY, NON_ADMIN_SEES_NOTHING (wiring half).
 * Side-effects: filesystem reads
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AGENT_ACCESS_ENDPOINTS,
  AGENT_ACCESS_ROLES_PATH,
} from "@/app/(app)/profile/agent-access-endpoints";

const SRC = resolve(__dirname, "../../../src");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

describe("S1 wiring", () => {
  it("points the profile block at an existing human-plane route that serves GET, POST and DELETE", async () => {
    expect(AGENT_ACCESS_ROLES_PATH).toBe("/api/v1/agent-access/roles");
    expect(AGENT_ACCESS_ENDPOINTS.roles).toBe(AGENT_ACCESS_ROLES_PATH);
    const route = resolve(SRC, `app${AGENT_ACCESS_ROLES_PATH}/route.ts`);
    expect(existsSync(route)).toBe(true);
    const source = readFileSync(route, "utf8");
    expect(source).toContain('createRoleRoutes("human")');
    const shared = read("app/_lib/agent-access/roles-route.ts");
    for (const verb of ["GET", "POST", "DELETE"])
      expect(shared).toContain(`const ${verb} =`);
    expect(shared).toContain("refuseNonSession(request, log)");
    expect(shared).toContain("guardPlane");
  });

  it("uses that endpoint in the profile view and mounts the block there", () => {
    const view = read("app/(app)/profile/view.tsx");
    expect(view).toContain('from "./agent-access-endpoints"');
    expect(view).toContain(
      "<AgentAccessSection endpoints={AGENT_ACCESS_ENDPOINTS} />"
    );
    expect(view).not.toMatch(/\/api\/v1\/agent\/roles/);
  });

  it("keeps the old AI-plane path gone and the human route out of the AI namespace", () => {
    expect(existsSync(resolve(SRC, "app/api/v1/agent/roles/route.ts"))).toBe(
      false
    );
  });
});
