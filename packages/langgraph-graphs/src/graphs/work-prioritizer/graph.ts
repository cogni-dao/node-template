// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Pure triage-program configuration of the shared native harness.
 * The program binds core__work_item_transition, the tool an outside agent uses, behind a thin guard.
 * Program-owned receipts feed the guard and the cycle report.
 */
import { WORK_ITEM_TRANSITION_NAME } from "@cogni/ai-tools";
import { cogniProfile, createCogniProgram } from "../cogni/graph";
import type { CreateReactAgentGraphOptions } from "../types";
import {
  COGNI_READ_PROMPT,
  COGNI_DECIDE_PROMPT,
  EVIDENCE_READER_DESCRIPTION,
  EVIDENCE_READER_PROMPT,
  LEDGER_READER_DESCRIPTION,
  LEDGER_READER_PROMPT,
  REQUIRED_GUIDANCE_IDS,
} from "./prompts";
import { RunReceipts } from "./receipts";
import { projectMissionCycleReport, projectStepBudgetReport } from "./report";
import { createTransitionGuard } from "./transition-guard";
import { COGNI_READ_TOOL_IDS } from "./tools";
export {
  cycleScores,
  cycleTelemetry,
  projectMissionCycleReport,
  type MissionLoopTelemetry,
} from "./report";
export const WORK_PRIORITIZER_GRAPH_NAME = "work-prioritizer" as const;

export function createWorkPrioritizerGraph(opts: CreateReactAgentGraphOptions) {
  const receipts = opts.programState as RunReceipts | undefined;
  // The program, not the input channel, owns capability: triage programs bind the guarded
  // writer for chat and scheduled runs alike.
  const readAuthority = new Set<string>(opts.readToolIds ?? COGNI_READ_TOOL_IDS);
  const readToolIds = opts.tools
    .map((tool) => tool.name)
    .filter(
      (name) =>
        name !== WORK_ITEM_TRANSITION_NAME &&
        readAuthority.has(name),
    );
  const deciding = opts.program === "work-review";
  const writer = opts.tools.find(
    (tool) => tool.name === WORK_ITEM_TRANSITION_NAME,
  );
  const requiredGuidanceIds = deciding ? REQUIRED_GUIDANCE_IDS : [];
  const profile = cogniProfile({
    id: opts.program ?? "work-review",
    instructions:
      opts.systemPrompt ?? (deciding ? COGNI_DECIDE_PROMPT : COGNI_READ_PROMPT),
    modelTier: "main",
    toolIds: readToolIds,
    allowedChildProfiles: ["general-purpose", "ledger-reader"],
    skillIds: (opts.sourceContext?.governingIndex ?? []).map(
      (entry) => entry.id,
    ),
  });
  const guardedTools =
    deciding && receipts && writer
      ? [createTransitionGuard(receipts, writer, requiredGuidanceIds)]
      : [];
  return createCogniProgram({
    ...opts,
    guardedTools,
    profile,
    children: [
      {
        description: EVIDENCE_READER_DESCRIPTION,
        profile: cogniProfile({
          id: "general-purpose",
          instructions: EVIDENCE_READER_PROMPT,
          modelTier: "flash",
          toolIds: readToolIds,
          skillIds: profile.skillIds,
          allowedChildProfiles: [],
        }),
      },
      {
        description: LEDGER_READER_DESCRIPTION,
        profile: cogniProfile({
          id: "ledger-reader",
          instructions: LEDGER_READER_PROMPT,
          modelTier: "flash",
          toolIds: [
            "core__goal_list",
            "core__work_item_query",
            "core__work_item_read",
            "core__knowledge_read",
            "core__get_current_time",
          ],
          skillIds: profile.skillIds,
          allowedChildProfiles: [],
        }),
      },
    ],
  });
}

export function createPrioritizerRunHooks(context: {
  program?: CreateReactAgentGraphOptions["program"];
  origin?: string;
}) {
  const receipts = new RunReceipts(context.origin ?? "");
  return {
    graphOptions: { programState: receipts },
    observeTool: (
      name: string,
      args: unknown,
      result: { ok: boolean; value?: unknown; errorCode?: string },
      toolCallId?: string,
    ) => {
      // A failed read records nothing and blocks nothing (no latch); telemetry counts it.
      if (result.ok) receipts.observe(name, args, result.value);
      if (!context.program || context.program === "work-review")
        receipts.recordTool(
          name,
          args,
          result.ok
            ? result.value
            : { error: result.errorCode ?? "tool_error" },
          toolCallId,
        );
    },
    projectOutput: (answer: string) =>
      projectMissionCycleReport(
        context.program ?? "work-review",
        receipts,
        answer,
      ),
    /** The step budget ended the run: report what the receipts show, with no further model call. */
    projectStepBudget: () =>
      projectStepBudgetReport(context.program ?? "work-review", receipts),
  };
}
createWorkPrioritizerGraph.createRunHooks = createPrioritizerRunHooks;
createWorkPrioritizerGraph.tierModelIds = { flash: "deepseek-v4-flash" };
