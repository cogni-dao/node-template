// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/facades/work-item-write-parity`
 * Purpose: Parity proof (architect 4.5): node-template's work-item write surfaces call the package entries and keep no local copy of the error map, the field lists or the resolver wiring (task.0097).
 * Scope: Reads source text of the route, facade, capability and container. No runtime wiring.
 * Invariants:
 *   - NO_LOCAL_ERROR_MAP: the routes, facade and capability name no package-owned write error class and keep no `_input-errors` file.
 *   - STORE_VIA_FACTORY: the container builds the Doltgres store with `createDoltgresWorkItemStore`.
 *   - FORWARDING_VIA_BUILDERS: the facade and capability forward writes with the package input builders.
 * Side-effects: IO (reads source files)
 * @internal
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = (rel: string) => path.resolve(__dirname, "../../../src", rel);
const read = (rel: string) => readFileSync(src(rel), "utf8");

const PACKAGE_OWNED_ERRORS = [
  "WorkItemScoresInvalidError",
  "ChangeReasonInvalidError",
  "CitesInvalidError",
  "CitesUnsupportedError",
  "EntryUnresolvedError",
  "MovesInvalidError",
  "MovesUnsupportedError",
  "EntryResolverUnavailableError",
  "MetricBaselineUnavailableError",
  "WorkItemRevisionConflictError",
  "WorkItemWriteOutcomeUnknownError",
  "WorkItemAlreadyExistsError",
];

const SURFACES = [
  "app/_facades/work/items.server.ts",
  "app/api/v1/work/items/route.ts",
  "app/api/v1/work/items/[id]/route.ts",
];

/** Code lines only: the module headers may name the errors the package maps. */
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("work-item write parity with the package (task.0097)", () => {
  it.each(SURFACES)("%s names no package-owned write error", (rel) => {
    const text = code(read(rel));
    const named = PACKAGE_OWNED_ERRORS.filter((name) => text.includes(name));
    expect(named).toEqual([]);
  });

  it("the capability does not name the errors the package maps, except the tool's conflict conversion", () => {
    const text = code(read("bootstrap/capabilities/work-item.ts"));
    const named = PACKAGE_OWNED_ERRORS.filter((name) => text.includes(name));
    expect(named).toEqual(["WorkItemRevisionConflictError"]);
  });

  it("keeps no local input-error map", () => {
    expect(existsSync(src("app/api/v1/work/items/_input-errors.ts"))).toBe(false);
  });

  it("both write routes answer through workItemWriteErrorResponse", () => {
    expect(read("app/api/v1/work/items/route.ts")).toContain('workItemWriteErrorResponse(e, "create")');
    expect(read("app/api/v1/work/items/[id]/route.ts")).toContain('workItemWriteErrorResponse(e, "patch")');
  });

  it("the facade and the capability forward writes through the package builders", () => {
    const facade = read("app/_facades/work/items.server.ts");
    expect(facade).toContain("toWorkItemsCreateInput(input)");
    expect(facade).toContain("toWorkItemsPatchInput(input)");
    expect(read("bootstrap/capabilities/work-item.ts")).toContain("toWorkItemsPatchInput(");
  });

  it("the container builds the Doltgres work-item store through the package factory", () => {
    const container = code(read("bootstrap/container.ts"));
    expect(container).toContain("createDoltgresWorkItemStore(");
    expect(container).not.toContain("new DoltgresWorkItemAdapter(");
  });
});
