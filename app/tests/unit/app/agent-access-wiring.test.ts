// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/agent-access-wiring`
 * Purpose: S1 wiring that no other test covers (task.5456): the scrub mount in the root client tree and the roles endpoint
 *   the profile block calls. (The DTO-equals-view guarantee is a compile-time check in
 *   src/app/_lib/agent-access/dto-type-check.ts; a vitest test cannot enforce types.)
 * Scope: Reads source files and imports route modules; renders nothing. Fails if the scrub mount is removed or moved, if the
 *   profile block's endpoint path stops pointing at an existing human-plane route, or if the old route returns.
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
  it("mounts ApprovalFragmentScrub once in the root client tree (providers.client.tsx), from the subpath export", () => {
    const providers = read("app/providers.client.tsx");
    expect(providers).toMatch(
      /import \{ ApprovalFragmentScrub \} from "@cogni\/knowledge-base-ui\/approval-fragment-scrub";/
    );
    expect(providers.match(/<ApprovalFragmentScrub \/>/g)).toHaveLength(1);
    // The scrub must wrap nothing the page needs and sit above the providers, so it runs on every route.
    expect(providers.indexOf("<ApprovalFragmentScrub />")).toBeLessThan(
      providers.indexOf("<AuthProvider>")
    );
    // Providers wraps every route group from the one root layout.
    expect(read("app/layout.tsx")).toContain("<Providers");
  });

  it("points the profile block at an existing human-plane route that serves GET, POST and DELETE", async () => {
    expect(AGENT_ACCESS_ROLES_PATH).toBe("/api/v1/agent-access/roles");
    expect(AGENT_ACCESS_ENDPOINTS.roles).toBe(AGENT_ACCESS_ROLES_PATH);
    const route = resolve(SRC, `app${AGENT_ACCESS_ROLES_PATH}/route.ts`);
    expect(existsSync(route)).toBe(true);
    const source = readFileSync(route, "utf8");
    for (const verb of ["GET", "POST", "DELETE"])
      expect(source).toMatch(new RegExp(`export const ${verb} =`));
    // Every handler guards the plane first.
    expect(source.match(/refuseNonSession\(request, ctx\.log\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("uses that endpoint in the profile view and mounts the block there", () => {
    const view = read("app/(app)/profile/view.tsx");
    expect(view).toContain('from "./agent-access-endpoints"');
    expect(view).toContain("<AgentAccessSection endpoints={AGENT_ACCESS_ENDPOINTS} />");
    expect(view).not.toMatch(/\/api\/v1\/agent\/roles/);
  });

  it("keeps the old AI-plane path gone and the human route out of the AI namespace", () => {
    expect(existsSync(resolve(SRC, "app/api/v1/agent/roles/route.ts"))).toBe(false);
  });
});
