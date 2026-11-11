// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Work Closeout: a program on the shared harness that closes items whose merged pull request is live in the build
 * this node runs, so validated work counts in convergence-ratio-7d (story.0035). It binds core__work_item_update,
 * the PATCH route's twin, behind the closeout guard. Receipts feed the guard and the cycle report.
 */
import { WORK_ITEM_UPDATE_NAME } from "@cogni/ai-tools";
import { cogniProfile, createCogniProgram } from "../cogni/graph";
import type { CreateReactAgentGraphOptions } from "../types";
import { createCloseoutGuard } from "./closeout-guard";
import { WORK_CLOSEOUT_SYSTEM_PROMPT } from "./prompts";
import { CloseoutReceipts } from "./receipts";

export const WORK_CLOSEOUT_GRAPH_NAME = "work-closeout" as const;

export function createWorkCloseoutGraph(opts: CreateReactAgentGraphOptions) {
  const receipts = opts.programState as CloseoutReceipts | undefined;
  const writer = opts.tools.find((tool) => tool.name === WORK_ITEM_UPDATE_NAME);
  const readAuthority = new Set(
    opts.readToolIds ?? opts.tools.map((tool) => tool.name),
  );
  const profile = cogniProfile({
    id: opts.program ?? WORK_CLOSEOUT_GRAPH_NAME,
    instructions: opts.systemPrompt ?? WORK_CLOSEOUT_SYSTEM_PROMPT,
    modelTier: "main",
    toolIds: opts.tools
      .map((tool) => tool.name)
      .filter((name) => name !== WORK_ITEM_UPDATE_NAME && readAuthority.has(name)),
    allowedChildProfiles: [],
    skillIds: (opts.sourceContext?.governingIndex ?? []).map((entry) => entry.id),
  });
  return createCogniProgram({
    ...opts,
    profile,
    children: [],
    guardedTools: receipts && writer ? [createCloseoutGuard(receipts, writer)] : [],
  });
}

function cycleTelemetry(receipts: CloseoutReceipts, aborted: boolean, report: string) {
  return {
    telemetry: {
      changedItemIds: [...receipts.closed],
      changeCount: receipts.closed.size,
      refusedCount: receipts.refused,
      toolErrorCount: receipts.toolErrors,
      itemsRead: receipts.items.size,
      mergedPrsRead: receipts.mergedPrs.size,
      liveCommits: receipts.liveCommits.size,
      aborted,
      ...(aborted ? { abortReason: "step_budget" } : {}),
      report: report.slice(0, 2048),
    },
  };
}

export function createCloseoutRunHooks(context: { origin?: string }) {
  const receipts = new CloseoutReceipts(context.origin ?? "");
  return {
    graphOptions: { programState: receipts },
    observeTool: (
      name: string,
      args: unknown,
      result: { ok: boolean; value?: unknown; errorCode?: string },
    ) => {
      if (result.ok) receipts.observe(name, args, result.value);
      else receipts.toolErrors += 1;
    },
    projectOutput: (answer: string) => cycleTelemetry(receipts, false, answer),
    /** The step budget ended the run: report the receipts, with no further model call. */
    projectStepBudget: () => {
      const closed = [...receipts.closed];
      const answer = `STEP_BUDGET: the run reached its step limit. Closed ${closed.length} item(s)${closed.length ? `: ${closed.join(", ")}` : ""}. Remaining candidates wait for the next run.`;
      return { answer, output: cycleTelemetry(receipts, true, answer) };
    },
  };
}
createWorkCloseoutGraph.createRunHooks = createCloseoutRunHooks;
createWorkCloseoutGraph.tierModelIds = { flash: "deepseek-v4-flash" };
