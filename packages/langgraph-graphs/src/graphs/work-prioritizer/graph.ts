// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Read-only mission adapter for the shared evidence/verification factory.
 * Retains cycleTelemetry as a compatibility helper for existing consumers.
 * Host LLM/tools are injected; business writes are not exposed. task.5333.
 */

import {
  EDO_DECIDE_NAME,
  GOAL_LIST_NAME,
  WORK_ITEM_TRANSITION_NAME,
} from "@cogni/ai-tools";
import { type BaseMessage, isToolMessage } from "@langchain/core/messages";
import { createEvidenceVerificationGraph } from "../evidence-verification/graph";
import type { CreateReactAgentGraphOptions } from "../types";
import { MISSION_EVIDENCE_PROGRAM } from "./program";

export const WORK_PRIORITIZER_GRAPH_NAME = "work-prioritizer" as const;

const REPORT_MAX_CHARS = 2048;
const ABORT_REASON_MAX_CHARS = 300;

const text = (m: BaseMessage | undefined): string => {
  const c = m?.content;
  return Array.isArray(c)
    ? c
        .map((p) => (typeof p === "string" ? p : "text" in p ? p.text : ""))
        .join("")
    : String(c ?? "");
};

const parse = (s: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
};

/** One flat cycle summary from the run's messages (safe to log). */
export function cycleTelemetry(
  messages: readonly BaseMessage[],
  abortReason?: string
) {
  const aborted = abortReason !== undefined;
  let goalIds: string[] | undefined;
  let edoDecisionId: string | undefined;
  const changedItemIds: string[] = [];
  let deniedCount = 0;
  let toolErrorCount = 0;
  for (const m of messages) {
    if (!isToolMessage(m)) continue;
    const raw = text(m);
    const v = parse(raw);
    if (!v || typeof v.error === "string" || v.success === false) {
      if (raw.includes("authz_denied")) deniedCount++;
      else toolErrorCount++;
    } else if (m.name === GOAL_LIST_NAME && Array.isArray(v.goals)) {
      goalIds = v.goals.map((g: { id?: unknown }) => String(g?.id));
    } else if (m.name === WORK_ITEM_TRANSITION_NAME && v.success === true) {
      changedItemIds.push(String(v.id));
    } else if (m.name === EDO_DECIDE_NAME) {
      const id = (v.entry as { id?: unknown } | undefined)?.id;
      if (typeof id === "string") edoDecisionId = id;
    }
  }
  return {
    ...(goalIds && { goalIds }),
    changedItemIds,
    changeCount: changedItemIds.length,
    deniedCount,
    toolErrorCount,
    ...(edoDecisionId && { edoDecisionId }),
    aborted,
    ...(aborted && {
      abortReason: abortReason.slice(0, ABORT_REASON_MAX_CHARS),
    }),
    report: aborted ? "" : text(messages.at(-1)).slice(0, REPORT_MAX_CHARS),
  };
}

export type MissionLoopTelemetry = ReturnType<typeof cycleTelemetry>;

/** Compatibility graph ID; mission policy configures the shared read-only factory. */
export function createWorkPrioritizerGraph(opts: CreateReactAgentGraphOptions) {
  return createEvidenceVerificationGraph(opts, MISSION_EVIDENCE_PROGRAM);
}
