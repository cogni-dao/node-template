// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/work-items-event-registry`
 * Purpose: Every event name the status-gate work (task.0122) emits is registered in `EVENT_NAMES` (observability finish pass: never an inline string).
 *   The work-items package cannot import the registry, so its literals are pinned here against it.
 * Scope: Reads the adapter and route sources; no database, no network.
 * Invariants: REGISTERED_NAMES_ONLY.
 * Side-effects: filesystem reads
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EVENT_NAMES } from "@cogni/node-shared";
import { describe, expect, it } from "vitest";

const registered = new Set<string>(Object.values(EVENT_NAMES));
const root = resolve(__dirname, "../../../..");
const adapter = readFileSync(resolve(root, "packages/work-items/src/adapters/doltgres/adapter.ts"), "utf8");

describe("work-items event names", () => {
  it.each([
    "adapter.work_items.stage_start",
    "adapter.work_items.stage_complete",
    "adapter.work_items.stage_error",
    "adapter.work_items.gate_pr_read_failed",
    "adapter.work_items.deploy_verified_write",
  ])("%s is emitted by the store and registered", (name) => {
    expect(registered.has(name)).toBe(true);
    // The stage names are built from `stage_${state}`; the others are literals.
    expect(adapter.includes(name) || adapter.includes("adapter.work_items.stage_${state}")).toBe(true);
  });

  it.each([
    "work.items.create_success",
    "work.items.create_refused",
    "work.items.patch_success",
    "work.items.patch_refused",
    "work.items.artifact_recorded",
    "work.items.artifact_refused",
    "work.items.artifacts_read",
    "work.items.envelope_degraded",
    "adapter.work_items.pr_repo_unpinned",
    "adapter.work_items.pr_repo_ignored",
    "agent.route_denied",
  ])("%s is registered", (name) => {
    expect(registered.has(name)).toBe(true);
  });

  it("the routes log no inline success or refusal name", () => {
    for (const file of ["app/src/app/api/v1/work/items/route.ts", "app/src/app/api/v1/work/items/[id]/route.ts"]) {
      const source = readFileSync(resolve(root, file), "utf8");
      expect(source).not.toMatch(/"work\.items\.(create|patch)_(success|refused)"/);
    }
  });
});
