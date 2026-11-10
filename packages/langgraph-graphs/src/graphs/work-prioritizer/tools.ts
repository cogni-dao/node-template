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
  WORK_ITEM_TRANSITION_NAME,
} from "@cogni/ai-tools";

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
  KNOWLEDGE_READ_NAME,
  KNOWLEDGE_SEARCH_NAME,
  WORK_ITEM_QUERY_NAME,
  WORK_ITEM_READ_NAME,
  WORK_ITEM_TRANSITION_NAME,
  GET_CURRENT_TIME_NAME,
] as const;
/** Triage guide: a run changes at most this many distinct items. */
export const MAX_CHANGED_ITEMS_PER_RUN = 5;
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
