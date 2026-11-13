// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Read-only and triage capabilities for the shared-harness node programs. */
import {
  GET_CURRENT_TIME_NAME,
  GOAL_LIST_NAME,
  KNOWLEDGE_READ_NAME,
  KNOWLEDGE_SEARCH_NAME,
  WORK_ITEM_QUERY_NAME,
  WORK_ITEM_READ_NAME,
  WORK_ITEM_UPDATE_NAME,
} from "@cogni/ai-tools";

export { WORK_ITEM_QUERY_MAX_LIMIT } from "@cogni/ai-tools";

export { WORK_ITEM_READ_NAME };
/** Measured goal reads (ai-tools createMetricTools); core__metric_compute writes, so it is not here. */
export const METRIC_READ_TOOL_IDS = [
  "core__goal_progress",
  "core__metric_list",
  "core__metric_read",
  "core__metric_history",
] as const;
export const COGNI_READ_TOOL_IDS = [
  GOAL_LIST_NAME,
  ...METRIC_READ_TOOL_IDS,
  WORK_ITEM_QUERY_NAME,
  WORK_ITEM_READ_NAME,
  KNOWLEDGE_SEARCH_NAME,
  KNOWLEDGE_READ_NAME,
  GET_CURRENT_TIME_NAME,
] as const;
export const FLASH_SUBAGENT_MODEL = "deepseek-v4-flash";
export const COGNI_DECIDE_TOOL_IDS = [
  GOAL_LIST_NAME,
  // Triage names the metric an item moves and judges the goal score from its KPI reading (task.0099).
  "core__goal_progress",
  "core__metric_list",
  KNOWLEDGE_READ_NAME,
  KNOWLEDGE_SEARCH_NAME,
  WORK_ITEM_QUERY_NAME,
  WORK_ITEM_READ_NAME,
  WORK_ITEM_UPDATE_NAME,
  GET_CURRENT_TIME_NAME,
] as const;
/** Triage guide: a run changes at most this many distinct items. */
export const MAX_CHANGED_ITEMS_PER_RUN = 5;
/** Max characters of one failed tool result echoed back in a receipt or completion report. */
export const RECEIPT_ERROR_MAX_CHARS = 240;
/** Evidence defects one rejection reports before counting the rest as omitted, and each one's max characters. */
export const EVIDENCE_ISSUES_MAX = 12;
export const EVIDENCE_ISSUE_MAX_CHARS = 300;
export const OPEN_STATUSES = [
  "needs_triage",
  "needs_research",
  "needs_design",
  "needs_implement",
  "needs_closeout",
  "needs_merge",
  "blocked",
] as const;

export const WORK_PRIORITIZER_TOOL_IDS = COGNI_DECIDE_TOOL_IDS;
