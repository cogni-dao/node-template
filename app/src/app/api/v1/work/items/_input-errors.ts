// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/_input-errors`
 * Purpose: One HTTP mapping for the metric, cite and moves failures that create and patch share (task.0086, story.0033).
 * Scope: Maps typed work-item errors to a JSON response; returns `undefined` for any other error so the caller keeps its own mapping.
 * Invariants:
 *   - UNRESOLVED_IS_400: an unknown id is HTTP400 `cite_unresolved`; the issue path is `cites`, or `set.moves` / `moves` for a metric id.
 *   - NEW_METRICS_ONLY: only ids new on the item reach the resolver, so this error never names a stored entry.
 *   - EACH_FAILURE_HAS_ITS_OWN_503: a resolver failure is `cite_resolver_unavailable`; a baseline failure is `metric_baseline_unavailable`.
 * Side-effects: none
 * @internal
 */

import { NextResponse } from "next/server";

import {
  EntryResolverUnavailableError,
  EntryUnresolvedError,
  MetricBaselineUnavailableError,
  MovesInvalidError,
  MovesUnsupportedError,
} from "@/app/_facades/work/items.server";

/** `prefix` is the request path to `moves`: `["set"]` on a patch, `[]` on a create. */
export function inputErrorResponse(
  e: unknown,
  prefix: readonly string[],
): NextResponse | undefined {
  const movesPath = [...prefix, "moves"];
  if (e instanceof EntryUnresolvedError) {
    return NextResponse.json(
      {
        error: "invalid input",
        errorCode: e.code,
        ids: e.ids,
        issues: e.ids.map((cited) => ({
          code: "custom",
          path: e.field === "moves" ? movesPath : ["cites"],
          message:
            e.field === "moves"
              ? `metric not found or deprecated: ${cited}`
              : `cited entry not found: ${cited}`,
        })),
      },
      { status: 400 },
    );
  }
  if (e instanceof MovesInvalidError) {
    return NextResponse.json(
      {
        error: "invalid input",
        errorCode: e.code,
        issues: e.issues.map((message) => ({
          code: "custom",
          path: movesPath,
          message,
        })),
      },
      { status: 400 },
    );
  }
  if (e instanceof MovesUnsupportedError) {
    return NextResponse.json(
      {
        error: "invalid input",
        errorCode: e.code,
        issues: [{ code: "custom", path: movesPath, message: e.message }],
      },
      { status: 400 },
    );
  }
  if (e instanceof EntryResolverUnavailableError) {
    return NextResponse.json(
      { error: "cites_unavailable", errorCode: e.code, message: e.message },
      { status: 503 },
    );
  }
  if (e instanceof MetricBaselineUnavailableError) {
    return NextResponse.json(
      {
        error: "metric_baseline_unavailable",
        errorCode: e.code,
        message: e.message,
      },
      { status: 503 },
    );
  }
  return undefined;
}
