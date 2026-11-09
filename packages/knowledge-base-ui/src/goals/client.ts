// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals` (client)
 * Purpose: The browser read contract for the Goals board: goal progress, ranged metric history, one metric's evidence and one pinned observation, each parsed with the shared metrics wire schemas.
 * Scope: GET only. A node supplies a base URL and, when its auth is not the page's cookie session, a `fetch` or request `init` carrying its credentials; or it replaces any fetcher outright.
 * Invariants:
 *   - ONE_WIRE_CONTRACT: every body is parsed by the schema in `@cogni-dao/metrics/contracts`.
 *   - READ_ONLY: the UI never POSTs; agents and the clock refresh readings.
 *   - BUCKETS_LE_400: every history read is an aligned window (`historyWindow`) of at most 400 buckets.
 *   - STATUS_ON_ERROR: a failed read throws `GoalsReadError` carrying the HTTP `status`, so callers branch on status, never on message text.
 * Side-effects: IO (GET `${baseUrl}/goals`, `/{id}/history`, `/{id}`, `/{id}/observations/{observationId}`)
 * Links: packages/metrics/src/contracts.ts, packages/metrics/src/http.ts
 * @public
 */

import {
  type GoalsProgress,
  GoalsProgressSchema,
  type MetricHistory,
  MetricHistorySchema,
  type MetricReadResponse,
  MetricReadResponseSchema,
  type MetricSnapshot,
  MetricSnapshotSchema,
} from "@cogni-dao/metrics/contracts";

import type { HistoryWindow } from "./presentation.js";

/** Default mount of the metrics routes. */
export const GOALS_BASE_URL = "/api/v1/metrics";

export type GoalsResource = "goals" | "history" | "metric" | "observation";

/** A failed read with its HTTP status, so callers branch on status, not message text. */
export class GoalsReadError extends Error {
  constructor(
    readonly resource: GoalsResource,
    readonly status: number
  ) {
    super(`${resource}_read_failed:${status}`);
    this.name = "GoalsReadError";
  }
}

/** The HTTP status carried by a failed read, from any fetcher that attaches `status` to its error. */
export function goalsErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

export interface GoalsClient {
  readonly fetchGoals: (signal?: AbortSignal) => Promise<GoalsProgress>;
  readonly fetchHistory: (
    metricId: string,
    window: HistoryWindow,
    signal?: AbortSignal
  ) => Promise<MetricHistory>;
  readonly fetchMetric: (
    metricId: string,
    signal?: AbortSignal
  ) => Promise<MetricReadResponse>;
  readonly fetchObservation: (
    metricId: string,
    observationId: string,
    signal?: AbortSignal
  ) => Promise<MetricSnapshot>;
}

export interface GoalsClientOptions {
  /** Where the metrics routes are mounted. Default `/api/v1/metrics`. */
  readonly baseUrl?: string;
  /** Replace `fetch` (for example to add an Authorization header). Default `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
  /** Extra request options; `cache` defaults to `no-store` and `signal` is always the caller's. */
  readonly init?: Omit<RequestInit, "signal" | "method">;
}

export function createGoalsClient(options: GoalsClientOptions = {}): GoalsClient {
  const base = (options.baseUrl ?? GOALS_BASE_URL).replace(/\/+$/, "");
  const read = async (
    resource: GoalsResource,
    path: string,
    signal: AbortSignal | undefined
  ): Promise<unknown> => {
    const doFetch = options.fetch ?? globalThis.fetch;
    const response = await doFetch(`${base}${path}`, {
      cache: "no-store",
      ...options.init,
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new GoalsReadError(resource, response.status);
    return response.json();
  };
  const metricPath = (metricId: string) => `/${encodeURIComponent(metricId)}`;
  return {
    async fetchGoals(signal) {
      return GoalsProgressSchema.parse(await read("goals", "/goals", signal));
    },
    /** One aligned window (see historyWindow): 1D/1W hourly, 1M/3M daily. */
    async fetchHistory(metricId, window, signal) {
      const { from, to, step } = window;
      const qs = new URLSearchParams({ from, to, step }).toString();
      return MetricHistorySchema.parse(
        await read("history", `${metricPath(metricId)}/history?${qs}`, signal)
      );
    },
    async fetchMetric(metricId, signal) {
      return MetricReadResponseSchema.parse(
        await read("metric", metricPath(metricId), signal)
      );
    },
    async fetchObservation(metricId, observationId, signal) {
      return MetricSnapshotSchema.parse(
        await read(
          "observation",
          `${metricPath(metricId)}/observations/${encodeURIComponent(observationId)}`,
          signal
        )
      );
    },
  };
}
