// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/same-door-routes`
 * Purpose: SAME_DOOR wiring. Every route id in `SAME_DOOR_ROUTES` is declared by an app route that also names its tool
 *   (`routeId: "<id>"` next to `sameDoor: "<toolId>"`), so the map cannot drift from the routes.
 * Side-effects: filesystem reads
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { authorizeCaller, type AgentGrantsStore, DEFERRED_WRITE_ROUTES, NO_ROUTE_TWIN, OPEN_BY_DESIGN_ROUTES, ROUTE_ONLY_CAPABILITIES, SAME_DOOR_ROUTES } from "@cogni/agent-grants";
import { createAdminCheck } from "@/bootstrap/agent-authority";
import { CORE_TOOL_BUNDLE, VCS_TOOL_BUNDLE } from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";

const API = resolve(__dirname, "../../../src/app/api");
function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? routeFiles(p) : name === "route.ts" ? [p] : [];
  });
}
const sources = routeFiles(API).map((f) => readFileSync(f, "utf8"));

const DECLARED: Record<string, { routes: readonly string[] }> = {
  ...SAME_DOOR_ROUTES,
  ...ROUTE_ONLY_CAPABILITIES,
};

describe("same-door routes", () => {
  for (const [tool, entry] of Object.entries(DECLARED)) {
    for (const routeId of entry.routes) {
      it(`${routeId} declares sameDoor: ${tool}`, () => {
        const declared = sources.some((s) =>
          new RegExp(`routeId:\\s*"${routeId.replace(".", "\\.")}",\\s*sameDoor:\\s*"${tool}"`).test(s)
        );
        expect(declared).toBe(true);
      });
    }
  }

  it("no route declares sameDoor for a tool the map does not list", () => {
    const declared = sources.flatMap((s) => [...s.matchAll(/sameDoor:\s*"([^"]+)"/g)].map((m) => m[1]));
    for (const tool of declared) expect(tool && tool in DECLARED, String(tool)).toBe(true);
  });

  it("S4: admin route capabilities are explicit and bearer authority never comes from a role row alone", async () => {
    const contracts = new Map([...CORE_TOOL_BUNDLE, ...VCS_TOOL_BUNDLE].map((t) => [t.contract.name, t.contract]));
    for (const tool of Object.keys(SAME_DOOR_ROUTES))
      expect(contracts.get(tool)?.requires?.subject, tool).not.toBe("admin");
    expect(Object.entries(ROUTE_ONLY_CAPABILITIES).filter(([, cap]) => cap.requires.subject === "admin").map(([id]) => id)).toEqual(["agent-access.manage", "service-link.manage"]);
    const roles = new Proxy({} as AgentGrantsStore, { get: (_target, name) => {
      if (name === "hasLiveRole") return async () => true;
      throw new Error(`unexpected role-store read: ${String(name)}`);
    } });
    const check = createAdminCheck(async () => [], { check: async (actor) => actor.userId === "dao-approved-ai" ? { ok: true } : { ok: false, errorCode: "authz_denied" } });
    for (const id of ["service-link.manage", "agent-access.manage"]) {
      const capability = ROUTE_ONLY_CAPABILITIES[id];
      if (!capability) throw new Error("missing admin declaration");
      const requires = capability.requires;
      expect(await authorizeCaller(roles, check, { userId: "role-only-agent", via: "bearer", requires })).toMatchObject({ decision: "deny", reason: "subject_not_admin" });
      expect(await authorizeCaller(roles, check, { userId: "dao-approved-ai", via: "bearer", requires })).toMatchObject({ decision: "allow" });
      expect(await authorizeCaller(roles, async () => "unavailable", { userId: "dao-approved-ai", via: "bearer", requires })).toMatchObject({ decision: "deny", code: "authz_unavailable" });
      const noRole = new Proxy({} as AgentGrantsStore, { get: () => async () => false });
      expect(await authorizeCaller(noRole, check, { userId: "dao-approved-ai", via: "bearer", requires })).toMatchObject({ decision: "deny", reason: "no_role" });
    }
    // The admin-subject tools are exactly the allowlisted ones.
    for (const [name, contract] of contracts)
      if (contract.requires?.subject === "admin") expect(name in NO_ROUTE_TWIN, name).toBe(true);
  });

  it("S5: every write handler under work, schedules, edo, knowledge and metrics declares sameDoor or is on the deferred list", () => {
    const dirs = ["work", "schedules", "edo", "knowledge", "metrics", "agent/access-requests", "agent/register"].map((d) => join(API, "v1", d));
    const unaccounted: string[] = [];
    for (const dir of dirs)
      for (const file of routeFiles(dir)) {
        const parts = readFileSync(file, "utf8").split(/export const (POST|PATCH|PUT|DELETE) =/);
        for (let i = 1; i < parts.length; i += 2) {
          const chunk = (parts[i + 1] ?? "").slice(0, 600);
          const routeId = /routeId:\s*"([^"]+)"/.exec(chunk)?.[1] ?? `${file}#${parts[i]}`;
          if (/sameDoor:/.test(chunk) || routeId in DEFERRED_WRITE_ROUTES || routeId in OPEN_BY_DESIGN_ROUTES) continue;
          unaccounted.push(routeId);
        }
      }
    expect(unaccounted).toEqual([]);
  });

  it("the ask door is on the open-by-design list, says why, and is not also gated", () => {
    const gated = new Set(Object.values(DECLARED).flatMap((e) => e.routes));
    expect(Object.keys(OPEN_BY_DESIGN_ROUTES)).toEqual(["agent.access.requests.create", "agent.register"]);
    for (const [routeId, reason] of Object.entries(OPEN_BY_DESIGN_ROUTES)) {
      expect(gated.has(routeId), routeId).toBe(false);
      expect(reason.length).toBeGreaterThan(30);
      expect(reason).toMatch(/NO_SELF_APPROVAL|bug\.0297/);
      expect(sources.join("\n")).toContain(`routeId: "${routeId}"`);
    }
  });

  it("S5: the deferred list names a route that exists and is not also gated, and every entry names its design item", () => {
    const gated = new Set(Object.values(DECLARED).flatMap((e) => e.routes));
    const all = sources.join("\n");
    for (const [routeId, reason] of Object.entries(DEFERRED_WRITE_ROUTES)) {
      expect(all.includes(`routeId: "${routeId}"`), routeId).toBe(true);
      expect(gated.has(routeId), routeId).toBe(false);
      expect(reason, routeId).toMatch(/task\.54(65|66)|retired/);
    }
  });
});
