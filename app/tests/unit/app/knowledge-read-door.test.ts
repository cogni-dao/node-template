// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/knowledge-read-door`
 * Purpose: Every GET route under `app/src/app/api` either carries the `knowledge.read` door (story.0038) or sits on the explicit exempt list below with a reason.
 *   An enrolled service principal cannot read a knowledge route the admin has not turned on. A new GET route with neither fails this test. The door list is declared once
 *   (`ROUTE_ONLY_CAPABILITIES["knowledge.read"].routes`). As a cross-check, imports are followed (relative and `@/app/**`, depth 3) and an exempt route that reads the
 *   store must say so on its entry.
 * Scope: Static reads of the route files. Behavior of the door itself is in `wrapRouteHandlerWithLogging.same-door.test.ts` and the package tests.
 * Side-effects: filesystem reads
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ROUTE_ONLY_CAPABILITIES } from "@cogni/agent-grants";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../../../src");
const API = join(SRC, "app/api");
const MAX_DEPTH = 3;
/** A module reads the store when its text names one of these. */
const STORE_READ = /@cogni\/knowledge-store|knowledgeStorePort|EdoCapability|@cogni-dao\/metrics|metrics\.server/;
/** Every way a route file can export a GET handler. */
const GET_EXPORT = /export\s+(?:async\s+)?(?:const|let|var|function)\s+GET\b|export\s*\{[^}]*\bGET\b[^}]*\}/g;
/** Export forms this test cannot classify (they could hide a GET): `export *`, destructured exports and comma declarators (`export const a = 1, GET = ...`). A route file using one fails the test. */
const UNCLASSIFIABLE_EXPORT = /export\s*\*|export\s+(?:const|let|var)\s*[{[]|export\s+(?:const|let|var)\s+[^;]*?,\s*GET\s*[=:]/;
const ROUTE_FILE = /^route\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const DOOR = /sameDoor:\s*"knowledge\.read"/;

const NOT_STORE = {
  auth: "Auth/session plumbing; reads no knowledge-store content.",
  ai: "AI run/thread/agent/model state in its own tables; reads no knowledge-store content.",
  ledger: "Attribution ledger (epochs, claimants, statements) in its own tables; reads no knowledge-store content.",
  money: "Billing/payments/treasury state in its own tables; reads no knowledge-store content.",
  schedules: "Schedule rows in the scheduler tables; reads no knowledge-store content.",
  identity: "The caller's own account and agent-access records; reads no knowledge-store content.",
  ops: "Node health/governance/telemetry; reads no knowledge-store content.",
} as const;
const WORK_ITEMS =
  "Work-item plane: its own work.* authorization and ownership checks, not the knowledge notes this door covers. Reads the store; service keys denied by default (the wrapper refuses a service_key principal on any route without the knowledge.read door).";

/** GET routes that legitimately stay open to humans and existing agent keys (a service_key principal is refused on every one of them by the wrapper).  Key = path under `app/src/app/api`. `readsStore` = the cross-check found a store reader behind it. */
const EXEMPT: Record<string, { reason: string; readsStore?: true }> = {
  "auth/[...nextauth]/route.ts": { reason: NOT_STORE.auth },
  "v1/auth/openai-codex/status/route.ts": { reason: NOT_STORE.auth },
  "v1/auth/openai-compatible/status/route.ts": { reason: NOT_STORE.auth },
  "metrics/route.ts": { reason: NOT_STORE.ops },
  "v1/node/stream/route.ts": { reason: NOT_STORE.ops },
  "v1/governance/activity/route.ts": { reason: NOT_STORE.ops },
  "v1/governance/status/route.ts": { reason: NOT_STORE.ops },
  "v1/activity/route.ts": { reason: NOT_STORE.ops },
  "v1/public/analytics/summary/route.ts": { reason: NOT_STORE.ops },
  "v1/ai/agents/route.ts": { reason: NOT_STORE.ai },
  "v1/ai/models/route.ts": { reason: NOT_STORE.ai },
  "v1/ai/runs/route.ts": { reason: NOT_STORE.ai },
  "v1/ai/runs/[runId]/stream/route.ts": { reason: NOT_STORE.ai },
  "v1/ai/runs/[runId]/ui-stream/route.ts": { reason: NOT_STORE.ai },
  "v1/ai/threads/route.ts": { reason: NOT_STORE.ai },
  "v1/ai/threads/[stateKey]/route.ts": { reason: NOT_STORE.ai },
  "v1/agent/runs/route.ts": { reason: NOT_STORE.ai },
  "v1/agent/runs/[runId]/stream/route.ts": { reason: NOT_STORE.ai },
  "v1/attribution/epochs/route.ts": { reason: NOT_STORE.ledger },
  "v1/attribution/epochs/[id]/activity/route.ts": { reason: NOT_STORE.ledger },
  "v1/attribution/epochs/[id]/claimants/route.ts": { reason: NOT_STORE.ledger },
  "v1/attribution/epochs/[id]/distribution-tx/route.ts": { reason: NOT_STORE.ledger },
  "v1/attribution/epochs/[id]/review-subject-overrides/route.ts": { reason: NOT_STORE.ledger },
  "v1/attribution/epochs/[id]/sign-data/route.ts": { reason: NOT_STORE.ledger },
  "v1/attribution/epochs/[id]/statement/route.ts": { reason: NOT_STORE.ledger },
  "v1/attribution/epochs/[id]/user-projections/route.ts": { reason: NOT_STORE.ledger },
  "v1/attribution/settlement-lifecycle/route.ts": { reason: NOT_STORE.ledger },
  "v1/public/attribution/distribution/latest/route.ts": { reason: NOT_STORE.ledger },
  "v1/public/attribution/epochs/route.ts": { reason: NOT_STORE.ledger },
  "v1/public/attribution/epochs/[id]/claimants/route.ts": { reason: NOT_STORE.ledger },
  "v1/public/attribution/epochs/[id]/distribution/route.ts": { reason: NOT_STORE.ledger },
  "v1/public/attribution/epochs/[id]/statement/route.ts": { reason: NOT_STORE.ledger },
  "v1/public/attribution/epochs/[id]/user-projections/route.ts": { reason: NOT_STORE.ledger },
  "v1/payments/attempts/[id]/route.ts": { reason: NOT_STORE.money },
  "v1/payments/credits/summary/route.ts": { reason: NOT_STORE.money },
  "v1/public/treasury/snapshot/route.ts": { reason: NOT_STORE.money },
  "v1/schedules/route.ts": { reason: NOT_STORE.schedules },
  "v1/schedules/[scheduleId]/route.ts": { reason: NOT_STORE.schedules },
  "v1/schedules/[scheduleId]/runs/route.ts": { reason: NOT_STORE.schedules },
  "v1/users/me/route.ts": { reason: NOT_STORE.identity },
  "v1/users/me/ownership/route.ts": { reason: NOT_STORE.identity },
  "v1/agent-access/roles/route.ts": { reason: NOT_STORE.identity },
  "v1/agent/access-requests/route.ts": { reason: NOT_STORE.identity },
  "v1/work/board/route.ts": { reason: WORK_ITEMS, readsStore: true },
  "v1/work/summaries/route.ts": { reason: WORK_ITEMS, readsStore: true },
  "v1/work/items/route.ts": { reason: WORK_ITEMS, readsStore: true },
  "v1/work/items/[id]/route.ts": { reason: WORK_ITEMS, readsStore: true },
  "v1/work/items/[id]/coordination/route.ts": { reason: WORK_ITEMS, readsStore: true },
  "v1/work/items/[id]/history/route.ts": { reason: WORK_ITEMS },
};

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? routeFiles(p) : ROUTE_FILE.test(name) ? [p] : [];
  });
}

/** Resolve a relative or `@/app/**` import to a file; other aliases (bootstrap wiring, shared, ports) are not followed. */
function resolveImport(from: string, spec: string): string | undefined {
  const base = spec.startsWith("@/app/") ? join(SRC, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : undefined;
  if (!base) return undefined;
  return [`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, join(base, "index.ts")].find((c) => existsSync(c));
}

/** True when the file, or a module it imports (transitively, bounded depth, visited set), names a store marker. */
function readsStore(file: string, depth = MAX_DEPTH, seen = new Set<string>()): boolean {
  if (seen.has(file) || depth < 0) return false;
  seen.add(file);
  const text = readFileSync(file, "utf8");
  if (STORE_READ.test(text)) return true;
  return [...text.matchAll(/from\s+"([^"]+)"/g)].some((m) => {
    const next = resolveImport(file, m[1] as string);
    return next !== undefined && readsStore(next, depth - 1, seen);
  });
}

type Handler = { key: string; file: string; door: boolean; routeIds: string[] };

/** Every route file that exports GET (any form). Door = the options block after an inline GET names it; a re-exported GET falls back to the file text. */
function getRoutes(): Handler[] {
  return routeFiles(API).flatMap((file) => {
    const text = readFileSync(file, "utf8");
    const hits = [...text.matchAll(GET_EXPORT)];
    if (hits.length === 0) return [];
    const blocks = hits.map((h) => (h[0].includes("{") ? text : text.slice(h.index, (h.index ?? 0) + 900)));
    const door = blocks.every((b) => DOOR.test(b));
    const routeIds = [...text.matchAll(/routeId:\s*"([^"]+)",\s*sameDoor:\s*"knowledge\.read"/g)].map((m) => m[1] as string);
    return [{ key: file.slice(API.length + 1), file, door, routeIds }];
  });
}

/** Route files whose exports cannot be classified. Must stay empty. */
function unclassifiableRoutes(): string[] {
  return routeFiles(API)
    .filter((file) => UNCLASSIFIABLE_EXPORT.test(readFileSync(file, "utf8")))
    .map((file) => file.slice(API.length + 1));
}

describe("knowledge.read door on every GET route (or an exempt reason)", () => {
  const routes = getRoutes();
  const door = routes.filter((r) => r.door);
  const open = routes.filter((r) => !r.door);

  it("finds the GET routes in every export form", () => {
    expect(routes.length).toBeGreaterThanOrEqual(60);
    expect(door.length).toBeGreaterThanOrEqual(21);
  });

  it("no route file uses an export form the scan cannot classify (export *, destructured exports, comma declarators)", () => {
    expect(unclassifiableRoutes()).toEqual([]);
  });

  it("every GET route carries sameDoor: knowledge.read or is on the exempt list", () => {
    expect(open.filter((r) => !EXEMPT[r.key]).map((r) => r.key)).toEqual([]);
  });

  it("no exempt entry is stale, doubles as a door route, or lacks a reason", () => {
    const keys = new Set(routes.map((r) => r.key));
    expect(Object.keys(EXEMPT).filter((k) => !keys.has(k))).toEqual([]);
    expect(Object.keys(EXEMPT).filter((k) => door.some((r) => r.key === k))).toEqual([]);
    expect(Object.entries(EXEMPT).filter(([, v]) => v.reason.length < 10)).toEqual([]);
  });

  it("an exempt route reads the store only where its entry says so", () => {
    const wrong = open.filter((r) => EXEMPT[r.key] && readsStore(r.file) !== (EXEMPT[r.key]?.readsStore === true));
    expect(wrong.map((r) => `${r.key}: store reader ${readsStore(r.file) ? "found" : "not found"}`)).toEqual([]);
  });

  it("the declaration lists exactly the door route ids", () => {
    expect(door.flatMap((r) => r.routeIds).sort()).toEqual([...(ROUTE_ONLY_CAPABILITIES["knowledge.read"]?.routes ?? [])].sort());
  });
});
