// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Tool ids of the brief steward: model reads plus two host-only tools the guard calls. */
import {
  KNOWLEDGE_READ_NAME,
  WORK_ITEM_HISTORY_NAME,
  WORK_ITEM_QUERY_NAME,
  WORK_ITEM_READ_NAME,
  WORK_ITEM_RECONCILE_NAME,
} from "@cogni/ai-tools";

export { WORK_ITEM_HISTORY_NAME, WORK_ITEM_RECONCILE_NAME };
/** What the model may call. Guidance is read through the hub skill backend. */
export const BRIEF_STEWARD_MODEL_TOOL_IDS = [
  "core__metric_read",
  WORK_ITEM_READ_NAME,
  WORK_ITEM_QUERY_NAME,
  KNOWLEDGE_READ_NAME,
] as const;
/**
 * The catalog entry's tool list. The last two are bound to the run but the model never receives them:
 * the guard calls the history read and the reconcile writer. Only this program lists either.
 */
export const BRIEF_STEWARD_TOOL_IDS = [
  ...BRIEF_STEWARD_MODEL_TOOL_IDS,
  WORK_ITEM_HISTORY_NAME,
  WORK_ITEM_RECONCILE_NAME,
] as const;
export const BRIEF_STEWARD_REQUIRED_GUIDANCE = [
  "program-behavior-mode",
] as const;
