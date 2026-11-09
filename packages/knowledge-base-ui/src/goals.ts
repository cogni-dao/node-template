// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals`
 * Purpose: Subpath entry for the whole Goals capability (task.0062): the board with its KPI cards, open chart and range control, the measurement-evidence view, the read client and the shared progress hook.
 * Scope: Re-exports only. Kept off the root entry so work-board-only adopters never need the `@cogni-dao/metrics` (>= 0.7.0) and `recharts` peers. A node supplies its endpoint (`createGoalsClient`), auth (a `fetch` or request `init`), link component and hrefs, and the `?observation=` URL value; it renders no Goals markup of its own.
 * Invariants: Requires the host's `QueryClientProvider` (react-query 5). Imports no router, no node app code and no node UI kit.
 * Side-effects: none
 * Links: task.0062, packages/metrics/src/contracts.ts
 * @public
 */

export {
  createGoalsClient,
  GOALS_BASE_URL,
  type GoalsClient,
  type GoalsClientOptions,
  GoalsReadError,
  type GoalsResource,
  goalsErrorStatus,
} from "./goals/client.js";
export {
  DEFAULT_GOALS_HREFS,
  type GoalsContextValue,
  type GoalsHostOptions,
  type GoalsHrefs,
  type GoalsLinkComponent,
  type GoalsLinkProps,
  GoalsProvider,
  useGoalsHost,
} from "./goals/context.js";
export {
  cardHint,
  cardSeries,
  displayOf,
  formatPercent,
  formatValue,
  MIN_DAILY_SHAPE,
  meetsTarget,
  progressFraction,
  sloBudget,
} from "./goals/display.js";
export {
  GoalsBoard,
  type GoalsBoardProps,
  STALE_AFTER_FAILURES,
} from "./goals/goals-board.js";
export { initialRange, KpiChart } from "./goals/kpi-chart.js";
export { AvailabilityStrip, ProgressBar, Sparkline, StatusPill } from "./goals/marks.js";
export { MetricEvidence, type MetricEvidenceProps } from "./goals/metric-evidence.js";
export {
  attentionCount,
  type GoalKpi,
  goalNeedsAttention,
  HISTORY_RANGES,
  type HistoryRange,
  type HistoryWindow,
  historyWindow,
  isMeasured,
  observationHref,
  REASON_TEXT,
  reasonText,
  STATUS_META,
  summarize,
  worstStatus,
} from "./goals/presentation.js";
export {
  GOALS_POLL_MS,
  GOALS_QUERY_KEY,
  goalsProgressKey,
  metricEvidenceKey,
  metricHistoryKey,
  type UseGoalsProgressOptions,
  useGoalsProgress,
} from "./goals/use-goals-progress.js";
