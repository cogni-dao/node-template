// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/summary-query`
 * Purpose: The one bounded work-summary read contract shared by client and server: page budgets, the query shape, and its search-param codec (task.0055).
 * Scope: Pure schemas and functions over `URLSearchParams`; no I/O, adapters or environment. A node supplies only its endpoint and auth.
 * Invariants:
 *   - BOUNDED_PAGE: a parsed query always carries a `limit` in 1..`WORK_SUMMARY_PAGE_MAX`; absent means `WORK_SUMMARY_PAGE_DEFAULT`; above max is rejected, never silently widened.
 *   - BOUNDED_INPUT: each list filter names at most `WORK_SUMMARY_LIST_MAX` values, `text` is at most `WORK_SUMMARY_TEXT_MAX` characters and `cursor` at most 2048.
 *   - ONE_CODEC: the browser encodes and the route decodes with these two functions, so a cursor issued for one request stays valid for the identical request.
 *   - STABLE_ENCODING: `workSummaryQueryToSearchParams` emits keys in a fixed order, so equal queries give equal strings (cache keys).
 * Side-effects: none
 * Links: task.0055, packages/work-items/src/contracts.ts
 * @public
 */

import { z } from "zod";

import { WorkItemSummarySchema } from "./contracts.js";
import {
  WORK_ITEM_SORT_DIRECTIONS,
  WORK_ITEM_SORT_FIELDS,
} from "./query-order.js";

/** Rows per summary page when a request names no limit. */
export const WORK_SUMMARY_PAGE_DEFAULT = 25;
/** Largest summary page any request may ask for. */
export const WORK_SUMMARY_PAGE_MAX = 100;
/** Rows per board column on first load and on each column "Load more". */
export const WORK_BOARD_COLUMN_PAGE = 20;

const CURSOR_MAX_CHARS = 2048;
/** Most values one list filter (types, statuses, projectIds, labels) may name. */
export const WORK_SUMMARY_LIST_MAX = 50;
/** Longest free-text search a request may carry. */
export const WORK_SUMMARY_TEXT_MAX = 200;

const filterList = z.array(z.string()).max(WORK_SUMMARY_LIST_MAX);

/** The filters, order and page window of one summary read. */
export const WorkSummaryQuerySchema = z.object({
  sortBy: z.enum(WORK_ITEM_SORT_FIELDS).optional(),
  sortDirection: z.enum(WORK_ITEM_SORT_DIRECTIONS).optional(),
  types: filterList.optional(),
  statuses: filterList.optional(),
  text: z.string().max(WORK_SUMMARY_TEXT_MAX).optional(),
  actor: z.enum(["human", "ai", "either"]).optional(),
  projectId: z.string().optional(),
  projectIds: filterList.optional(),
  rankMin: z.number().finite().optional(),
  rankMax: z.number().finite().optional(),
  node: z.union([z.string(), z.array(z.string())]).optional(),
  /** Any-of label filter: items carrying at least one of these labels. */
  labels: filterList.optional(),
  /** Items with at least one label whose text starts with this prefix. */
  labelPrefix: z.string().optional(),
  /** true = only complete 6-axis scores; false = only unscored. */
  scored: z.boolean().optional(),
  limit: z.number().int().positive().max(WORK_SUMMARY_PAGE_MAX).optional(),
  cursor: z.string().max(CURSOR_MAX_CHARS).optional(),
});
export type WorkSummaryQuery = z.infer<typeof WorkSummaryQuerySchema>;
/** A parsed query: `limit` is always present and within budget. */
export type ParsedWorkSummaryQuery = WorkSummaryQuery & { limit: number };

export type WorkSummaryIssue = z.core.$ZodIssue;
export type WorkSummaryQueryParse =
  | { readonly ok: true; readonly query: ParsedWorkSummaryQuery }
  | { readonly ok: false; readonly issues: readonly WorkSummaryIssue[] };

/** One keyset page boundary. `endCursor` is valid only for the identical query. */
export const WorkSummaryPageInfoSchema = z.object({
  endCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type WorkSummaryPageInfo = z.infer<typeof WorkSummaryPageInfoSchema>;

/** One bounded page of summaries. */
export const WorkSummaryPageSchema = z.object({
  items: z.array(WorkItemSummarySchema),
  pageInfo: WorkSummaryPageInfoSchema,
  /** @deprecated Use `pageInfo.endCursor`. */
  nextCursor: z.string().optional(),
});
export type WorkSummaryPage = z.infer<typeof WorkSummaryPageSchema>;

/** Serialization order; also the complete list of accepted parameter names. */
const LIST_PARAMS = [
  "types",
  "statuses",
  "projectIds",
  "labels",
] as const;

function list(value: string | null): string[] | undefined {
  if (value === null) return undefined;
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

function text(value: string | null): string | undefined {
  return value === null || value === "" ? undefined : value;
}

function number(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  return Number(value);
}

function bool(value: string | null): boolean | string | undefined {
  if (value === null || value === "") return undefined;
  return value === "true" ? true : value === "false" ? false : value;
}

/**
 * Decode and validate a summary request. Only the parameter names listed in the
 * contract are read; unknown names are ignored. `limit` defaults to
 * `WORK_SUMMARY_PAGE_DEFAULT` and is rejected above `WORK_SUMMARY_PAGE_MAX`.
 */
export function parseWorkSummarySearchParams(
  params: URLSearchParams,
): WorkSummaryQueryParse {
  const node = params.get("node");
  const parsed = WorkSummaryQuerySchema.safeParse({
    sortBy: text(params.get("sortBy")),
    sortDirection: text(params.get("sortDirection")),
    types: list(params.get("types")),
    statuses: list(params.get("statuses")),
    text: text(params.get("text")),
    actor: text(params.get("actor")),
    projectId: text(params.get("projectId")),
    projectIds: list(params.get("projectIds")),
    rankMin: number(params.get("rankMin")),
    rankMax: number(params.get("rankMax")),
    node: node ? (node.includes(",") ? list(node) : node) : undefined,
    labels: list(params.get("labels")),
    labelPrefix: text(params.get("labelPrefix")),
    scored: bool(params.get("scored")),
    limit: number(params.get("limit")) ?? WORK_SUMMARY_PAGE_DEFAULT,
    cursor: text(params.get("cursor")),
  });
  if (!parsed.success) return { ok: false, issues: parsed.error.issues };
  const query = parsed.data;
  if (
    query.rankMin !== undefined &&
    query.rankMax !== undefined &&
    query.rankMin > query.rankMax
  ) {
    return {
      ok: false,
      issues: [
        {
          code: "custom",
          path: ["rankMin"],
          message: "invalid rank range",
          input: query.rankMin,
        },
      ],
    };
  }
  return {
    ok: true,
    query: { ...query, limit: query.limit ?? WORK_SUMMARY_PAGE_DEFAULT },
  };
}

/**
 * Encode a query for `/summaries`-style endpoints. Empty values are omitted and
 * `limit` is clamped into budget, so a client can never emit an over-budget
 * request.
 */
export function workSummaryQueryToSearchParams(
  query: WorkSummaryQuery,
): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of LIST_PARAMS) {
    const value = query[key];
    if (value?.length) params.set(key, value.join(","));
  }
  if (query.projectId) params.set("projectId", query.projectId);
  const node = typeof query.node === "string" ? [query.node] : query.node;
  if (node?.length) params.set("node", node.join(","));
  if (query.labelPrefix) params.set("labelPrefix", query.labelPrefix);
  if (query.scored !== undefined) params.set("scored", String(query.scored));
  if (query.actor) params.set("actor", query.actor);
  if (query.rankMin !== undefined) params.set("rankMin", String(query.rankMin));
  if (query.rankMax !== undefined) params.set("rankMax", String(query.rankMax));
  if (query.sortBy) params.set("sortBy", query.sortBy);
  if (query.sortDirection) params.set("sortDirection", query.sortDirection);
  if (query.text) params.set("text", query.text);
  const limit = Math.min(
    Math.max(Math.trunc(query.limit ?? WORK_SUMMARY_PAGE_DEFAULT), 1),
    WORK_SUMMARY_PAGE_MAX,
  );
  params.set("limit", String(limit));
  if (query.cursor) params.set("cursor", query.cursor);
  return params;
}
