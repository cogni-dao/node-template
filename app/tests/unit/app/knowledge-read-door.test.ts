// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/knowledge-read-door`
 * Purpose: Every GET handler under `/api/v1/knowledge` carries the `knowledge.read` door (story.0038), so an enrolled service principal cannot read
 *   a knowledge route the admin has not turned on. The route list is declared once (`ROUTE_ONLY_CAPABILITIES["knowledge.read"].routes`); this test fails when a
 *   knowledge GET handler is added without it, or when the declaration names a route that does not exist.
 * Scope: Static reads of the route files. Behavior of the door itself is in `wrapRouteHandlerWithLogging.same-door.test.ts` and the package tests.
 * Side-effects: filesystem reads
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROUTE_ONLY_CAPABILITIES } from "@cogni/agent-grants";
import { describe, expect, it } from "vitest";

const KNOWLEDGE = resolve(__dirname, "../../../src/app/api/v1/knowledge");
function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? routeFiles(p) : name === "route.ts" ? [p] : [];
  });
}

/** Every GET handler: its route id and whether the same options block names the door. */
function getHandlers(): Array<{ file: string; routeId: string; door: boolean }> {
  return routeFiles(KNOWLEDGE).flatMap((file) => {
    const parts = readFileSync(file, "utf8").split(/export const GET\s*=/);
    return parts.slice(1).map((chunk) => {
      const options = chunk.slice(0, 900);
      return {
        file,
        routeId: /routeId:\s*"([^"]+)"/.exec(options)?.[1] ?? "?",
        door: /routeId:\s*"[^"]+",\s*sameDoor:\s*"knowledge\.read"/.test(options),
      };
    });
  });
}

describe("knowledge.read door on every knowledge GET route", () => {
  const handlers = getHandlers();

  it("finds the knowledge GET handlers", () => {
    expect(handlers.length).toBeGreaterThanOrEqual(12);
  });

  it("every GET handler declares sameDoor: knowledge.read next to its route id", () => {
    expect(handlers.filter((h) => !h.door).map((h) => `${h.routeId} (${h.file})`)).toEqual([]);
  });

  it("the declaration lists exactly these GET route ids", () => {
    expect(handlers.map((h) => h.routeId).sort()).toEqual([...(ROUTE_ONLY_CAPABILITIES["knowledge.read"]?.routes ?? [])].sort());
  });
});
