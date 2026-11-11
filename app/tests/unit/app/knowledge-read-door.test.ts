// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/knowledge-read-door`
 * Purpose: Every GET handler that reads the knowledge store (everything under `/api/v1/knowledge`, plus any other `api/**` GET route found by what it imports) carries the `knowledge.read` door (story.0038), so an enrolled service principal cannot read
 *   a knowledge route the admin has not turned on. The route list is declared once (`ROUTE_ONLY_CAPABILITIES["knowledge.read"].routes`); this test fails when a
 *   knowledge GET handler is added without it, or when the declaration names a route that does not exist.
 * Scope: Static reads of the route files. Behavior of the door itself is in `wrapRouteHandlerWithLogging.same-door.test.ts` and the package tests.
 * Side-effects: filesystem reads
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ROUTE_ONLY_CAPABILITIES } from "@cogni/agent-grants";
import { describe, expect, it } from "vitest";

const API = resolve(__dirname, "../../../src/app/api");
const KNOWLEDGE = join(API, "v1/knowledge");
/** A route reads the store when its file, or a local file it imports, names one of these. */
const STORE_READ = /@cogni\/knowledge-store|knowledgeStorePort|EdoCapability/;
function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? routeFiles(p) : name === "route.ts" ? [p] : [];
  });
}

/** The route file's own text plus the text of each local (relative) module it imports, one hop deep. */
function sourceWithLocalImports(file: string): string {
  const text = readFileSync(file, "utf8");
  const local = [...text.matchAll(/from\s+"(\.[^"]*)"/g)].flatMap((m) => {
    const base = resolve(dirname(file), m[1] as string);
    return [`${base}.ts`, join(base, "index.ts")].filter((c) => existsSync(c));
  });
  return [text, ...local.map((c) => readFileSync(c, "utf8"))].join("\n");
}

/** Every GET handler that reads the knowledge store: its route id and whether the same options block names the door. */
function getHandlers(): Array<{ file: string; routeId: string; door: boolean }> {
  const files = routeFiles(API).filter(
    (file) => file.startsWith(`${KNOWLEDGE}/`) || STORE_READ.test(sourceWithLocalImports(file)),
  );
  return files.flatMap((file) => {
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

describe("knowledge.read door on every GET route that reads the knowledge store", () => {
  const handlers = getHandlers();

  it("finds the knowledge GET handlers, and the ones outside api/v1/knowledge", () => {
    expect(handlers.length).toBeGreaterThanOrEqual(15);
    const ids = handlers.map((h) => h.routeId);
    expect(ids).toEqual(expect.arrayContaining(["cognition.bundle", "edo.chain", "citations.links"]));
  });

  it("every GET handler declares sameDoor: knowledge.read next to its route id", () => {
    expect(handlers.filter((h) => !h.door).map((h) => `${h.routeId} (${h.file})`)).toEqual([]);
  });

  it("the declaration lists exactly these GET route ids", () => {
    expect(handlers.map((h) => h.routeId).sort()).toEqual([...(ROUTE_ONLY_CAPABILITIES["knowledge.read"]?.routes ?? [])].sort());
  });
});
