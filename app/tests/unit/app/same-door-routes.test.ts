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
import { ROUTE_ONLY_CAPABILITIES, SAME_DOOR_ROUTES } from "@cogni/agent-grants";
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
});
