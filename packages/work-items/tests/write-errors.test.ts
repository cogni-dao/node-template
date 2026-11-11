// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/write-errors`
 * Purpose: Proves one HTTP answer for every work-item write error, matched by name, so no node copies the map (task.0097).
 * Scope: Pure; real error classes, a second module copy of each, and name-only objects.
 * Invariants:
 *   - DROPPED_MAPPING_FAILS: each row below names an error; deleting a table entry fails its row, and the name list test fails too.
 *   - COPIES_MAP_THE_SAME: a class loaded as a separate module (so `instanceof` fails) and a plain object with only a `name` give the same status and errorCode.
 *   - NEW_ERROR_NEEDS_A_DECISION: an exported `*Error` class that is neither mapped nor listed as unmapped fails the drift test.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it } from "vitest";

import * as doltgres from "../src/adapters/doltgres/index.js";
import {
  CitesInvalidError,
  CitesUnsupportedError,
  EntryResolverUnavailableError,
  EntryUnresolvedError,
} from "../src/cites.js";
import { WorkItemRevisionConflictError, WorkItemScoresInvalidError, WorkItemWriteOutcomeUnknownError } from "../src/errors.js";
import { ChangeReasonInvalidError } from "../src/history.js";
import * as root from "../src/index.js";
import {
  MetricBaselineUnavailableError,
  MovesInvalidError,
  MovesUnsupportedError,
} from "../src/moves.js";
import {
  WORK_ITEM_WRITE_ERROR_NAMES,
  workItemWriteErrorResponse,
} from "../src/write-errors.js";

const scoreIssues = [{ code: "too_big", path: ["goal", "v"], message: "v must be at most 5" }];
const custom = (path: string[], message: string) => ({ code: "custom", path, message });

interface Row {
  readonly name: string;
  readonly make: () => Error;
  /** Fields a name-only copy keeps, so the default body is still checkable. */
  readonly status: number;
  readonly errorCode: string;
  readonly patchBody: Record<string, unknown>;
  readonly createBody?: Record<string, unknown>;
}

const rows: Row[] = [
  {
    name: "WorkItemScoresInvalidError",
    make: () => new WorkItemScoresInvalidError(scoreIssues),
    status: 400,
    errorCode: "work_item_scores_invalid",
    patchBody: { error: "invalid input", errorCode: "work_item_scores_invalid", issues: scoreIssues },
  },
  {
    name: "ChangeReasonInvalidError",
    make: () => new ChangeReasonInvalidError("reason is required"),
    status: 400,
    errorCode: "reason_invalid",
    patchBody: {
      error: "invalid input",
      errorCode: "reason_invalid",
      issues: [custom(["reason"], "reason is required")],
    },
  },
  {
    name: "CitesInvalidError",
    make: () => new CitesInvalidError(["cites must hold at most 8 entries", "cites[1].id repeats a-b"]),
    status: 400,
    errorCode: "cites_invalid",
    patchBody: {
      error: "invalid input",
      errorCode: "cites_invalid",
      issues: [
        custom(["cites"], "cites must hold at most 8 entries"),
        custom(["cites"], "cites[1].id repeats a-b"),
      ],
    },
  },
  {
    name: "CitesUnsupportedError",
    make: () => new CitesUnsupportedError(),
    status: 400,
    errorCode: "cites_unsupported",
    patchBody: {
      error: "invalid input",
      errorCode: "cites_unsupported",
      issues: [custom(["cites"], "cites are not supported: no entry resolver is wired on this node")],
    },
  },
  {
    name: "EntryUnresolvedError",
    make: () => new EntryUnresolvedError(["ghost", "gone"]),
    status: 400,
    errorCode: "cite_unresolved",
    patchBody: {
      error: "invalid input",
      errorCode: "cite_unresolved",
      ids: ["ghost", "gone"],
      issues: [
        custom(["cites"], "cited entry not found: ghost"),
        custom(["cites"], "cited entry not found: gone"),
      ],
    },
  },
  {
    name: "MovesInvalidError",
    make: () => new MovesInvalidError(["moves must hold at most 3 entries"]),
    status: 400,
    errorCode: "moves_invalid",
    patchBody: {
      error: "invalid input",
      errorCode: "moves_invalid",
      issues: [custom(["set", "moves"], "moves must hold at most 3 entries")],
    },
    createBody: {
      error: "invalid input",
      errorCode: "moves_invalid",
      issues: [custom(["moves"], "moves must hold at most 3 entries")],
    },
  },
  {
    name: "MovesUnsupportedError",
    make: () => new MovesUnsupportedError(),
    status: 400,
    errorCode: "moves_unsupported",
    patchBody: {
      error: "invalid input",
      errorCode: "moves_unsupported",
      issues: [
        custom(
          ["set", "moves"],
          "moves are not supported: no metric resolver or baseline reader is wired on this node",
        ),
      ],
    },
    createBody: {
      error: "invalid input",
      errorCode: "moves_unsupported",
      issues: [
        custom(
          ["moves"],
          "moves are not supported: no metric resolver or baseline reader is wired on this node",
        ),
      ],
    },
  },
  {
    name: "EntryResolverUnavailableError",
    make: () => new EntryResolverUnavailableError("resolver down"),
    status: 503,
    errorCode: "cite_resolver_unavailable",
    patchBody: { error: "cites_unavailable", errorCode: "cite_resolver_unavailable", message: "resolver down" },
  },
  {
    name: "MetricBaselineUnavailableError",
    make: () => new MetricBaselineUnavailableError("baseline down"),
    status: 503,
    errorCode: "metric_baseline_unavailable",
    patchBody: {
      error: "metric_baseline_unavailable",
      errorCode: "metric_baseline_unavailable",
      message: "baseline down",
    },
  },
  {
    name: "WorkItemRevisionConflictError",
    make: () => new WorkItemRevisionConflictError("task.0001", 7, 8),
    status: 409,
    errorCode: "revision_conflict",
    patchBody: { error: "revision_conflict", expectedRevision: 7, currentRevision: 8 },
  },
  {
    name: "WorkItemWriteOutcomeUnknownError",
    make: () => new WorkItemWriteOutcomeUnknownError("op-1", "branch-1", "abc", "task.0001"),
    status: 409,
    errorCode: "work_item_write_outcome_unknown",
    patchBody: {
      error: "work_item_write_outcome_unknown",
      retryable: false,
      lookup: { operationId: "op-1", branch: "branch-1", commitHash: "abc", itemId: "task.0001" },
      message: expect.stringContaining("op-1"),
    },
  },
  {
    name: "WorkItemAlreadyExistsError",
    make: () => Object.assign(new Error("work item id 'task.0001' already exists"), { name: "WorkItemAlreadyExistsError" }),
    status: 409,
    errorCode: "work_item_exists",
    patchBody: { error: "work item id 'task.0001' already exists" },
  },
];

/** Error classes the package exports that this map leaves to the node, each with the reason. */
const UNMAPPED: Readonly<Record<string, string>> = {
  WorkItemsBusyError: "backend unavailable: the node picks its 503 envelope",
  WorkItemsCapacityError: "backend unavailable: the node picks its 503 envelope",
  WorkItemLeaseConflictError: "lease routes own their conflict answer",
  WorkItemAuthorizationError: "authorization: the node picks its 403 envelope",
  WorkItemDeletionRetiredError: "delete is retired by the node route with 410",
  MoveMetricGoneError: "read-time only: the judge reads it as unknown, never an HTTP answer",
  InvalidCursorError: "read-side: the list routes own it",
};

describe("workItemWriteErrorResponse", () => {
  it.each(rows)("$name maps to $status $errorCode", (row) => {
    const result = workItemWriteErrorResponse(row.make(), "patch");
    expect(result).toBeDefined();
    expect(result?.status).toBe(row.status);
    expect(result?.errorCode).toBe(row.errorCode);
    expect(result?.body).toEqual(row.patchBody);
    expect(result?.message).toBe(row.make().message);
  });

  it.each(rows)("$name keeps its create body", (row) => {
    expect(workItemWriteErrorResponse(row.make(), "create")?.body).toEqual(
      row.createBody ?? row.patchBody,
    );
  });

  it("names exactly the errors these rows cover", () => {
    expect([...WORK_ITEM_WRITE_ERROR_NAMES].sort()).toEqual(rows.map((r) => r.name).sort());
  });

  it.each(rows)("$name as a plain object with only a name still maps", (row) => {
    const copy = { name: row.name, message: "copy" };
    const result = workItemWriteErrorResponse(copy, "patch");
    expect(result?.status).toBe(row.status);
    expect(result?.errorCode).toBe(row.errorCode);
    expect(result?.message).toBe("copy");
  });

  it("applies shape defaults to a copy that lost its fields", () => {
    const issues = (name: string, field?: string) =>
      (workItemWriteErrorResponse({ name, message: "m", ...(field && { field }) }, "patch")?.body as {
        issues: unknown[];
      }).issues;
    expect(issues("CitesInvalidError")).toEqual([custom(["cites"], "m")]);
    expect(issues("MovesInvalidError")).toEqual([custom(["set", "moves"], "m")]);
    expect(issues("WorkItemScoresInvalidError")).toEqual([]);
    expect(issues("EntryUnresolvedError")).toEqual([]);
    const unresolved = workItemWriteErrorResponse(
      { name: "EntryUnresolvedError", message: "m", ids: ["x"], field: "weird" },
      "patch",
    );
    expect(unresolved?.body).toMatchObject({ issues: [custom(["cites"], "cited entry not found: x")] });
  });

  it("puts a moves unresolved id at the moves path", () => {
    const patch = workItemWriteErrorResponse(new EntryUnresolvedError(["m-1"], "moves"), "patch");
    expect(patch?.body).toMatchObject({
      ids: ["m-1"],
      issues: [custom(["set", "moves"], "metric not found or deprecated: m-1")],
    });
    const create = workItemWriteErrorResponse(new EntryUnresolvedError(["m-1"], "moves"), "create");
    expect(create?.body).toMatchObject({ issues: [custom(["moves"], "metric not found or deprecated: m-1")] });
  });

  it("maps a class loaded as a separate module copy, where instanceof fails", async () => {
    // A query string makes vite load a second instance of the module, like a second bundle.
    const copyUrl = "../src/cites.js?copy=1";
    const copy = (await import(/* @vite-ignore */ copyUrl)) as typeof import("../src/cites.js");
    const original = new EntryUnresolvedError(["ghost"]);
    const other = new copy.EntryUnresolvedError(["ghost"]);
    expect(other instanceof EntryUnresolvedError).toBe(false); // not vacuous: a real second class
    expect(original instanceof copy.EntryUnresolvedError).toBe(false);
    expect(workItemWriteErrorResponse(other, "patch")).toEqual(workItemWriteErrorResponse(original, "patch"));
    const unavailable = new copy.EntryResolverUnavailableError("x");
    expect(unavailable instanceof EntryResolverUnavailableError).toBe(false);
    expect(workItemWriteErrorResponse(unavailable, "patch")?.status).toBe(503);
  });

  it.each([
    ["a plain error", new Error("boom")],
    ["a not-found error", Object.assign(new Error("Work item not found: x"), { name: "WorkItemNotFoundError" })],
    ["a busy error", Object.assign(new Error("busy"), { name: "WorkItemsBusyError" })],
    ["a string", "boom"],
    ["null", null],
    ["a prototype key", { name: "toString" }],
  ])("returns undefined for %s", (_label, error) => {
    expect(workItemWriteErrorResponse(error, "patch")).toBeUndefined();
  });

  it("decides every exported error class: mapped or listed as the node's", () => {
    const exported = new Set<string>();
    for (const mod of [root, doltgres] as Record<string, unknown>[]) {
      for (const [key, value] of Object.entries(mod)) {
        if (/^[A-Z]\w*Error$/.test(key) && typeof value === "function") exported.add(key);
      }
    }
    const undecided = [...exported].filter(
      (name) => !WORK_ITEM_WRITE_ERROR_NAMES.includes(name) && !(name in UNMAPPED),
    );
    expect(undecided).toEqual([]);
    // The unmapped list stays honest: each name is a real export.
    expect(Object.keys(UNMAPPED).filter((name) => !exported.has(name))).toEqual([]);
  });
});
