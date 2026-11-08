// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/graphs/brief-steward/graph`
 * Purpose: The scheduled `brief-steward` program on the shared Cogni harness (hub brief-steward-design).
 * Scope: Pure factory plus run hooks. The model sees reads and one guarded write tool; chat (answer mode) gets
 *   reads only, so it makes zero writes. Does not read env, the store, or any clock but the guard's.
 * Invariants:
 *   - PURE_GRAPH_FACTORY: no env or ALS; the compiled deep-agent graph is returned unwrapped
 *   - DECIDE_ONLY_WRITES: the guarded writer is bound only when the trusted request intent is `decide`, which the
 *     host sets for a validated scheduled run
 *   - HOST_TOOLS_HIDDEN: `core__work_item_reconcile` and `core__work_item_history` reach the guard, never the model
 *   - ONE_TERMINAL_EVENT: `projectOutput` returns the run's single `ai.brief_steward.cycle` telemetry
 * Side-effects: none
 * Links: hub brief-steward-design, hub program-behavior-mode, hub graph-compiled-not-wrapped
 * @public
 */
import { cogniProfile, createCogniProgram } from "../cogni/graph";
import type { CreateReactAgentGraphOptions } from "../types";
import { BRIEF_STEWARD_PROMPT, stewardPrompt } from "./prompts";
import { StewardReceipts } from "./receipts";
import { createReconcileGuard } from "./reconcile-guard";
import {
  BRIEF_STEWARD_MODEL_TOOL_IDS,
  BRIEF_STEWARD_REQUIRED_GUIDANCE,
  WORK_ITEM_HISTORY_NAME,
  WORK_ITEM_RECONCILE_NAME,
} from "./tools";

export const BRIEF_STEWARD_GRAPH_NAME = "brief-steward" as const;

export function createBriefStewardGraph(opts: CreateReactAgentGraphOptions) {
  const receipts = opts.programState as StewardReceipts | undefined;
  const modelTools = new Set<string>(BRIEF_STEWARD_MODEL_TOOL_IDS);
  const readAuthority = new Set<string>(opts.readToolIds ?? modelTools);
  const readToolIds = opts.tools
    .map((tool) => tool.name)
    .filter((name) => modelTools.has(name) && readAuthority.has(name));
  const deciding =
    opts.program === "brief-steward" && opts.requestIntent === "decide";
  const writer = opts.tools.find(
    (tool) => tool.name === WORK_ITEM_RECONCILE_NAME,
  );
  const history = opts.tools.find(
    (tool) => tool.name === WORK_ITEM_HISTORY_NAME,
  );
  const profile = cogniProfile({
    id: "brief-steward",
    instructions: stewardPrompt(
      opts.systemPrompt ?? BRIEF_STEWARD_PROMPT,
      deciding,
    ),
    modelTier: "main",
    toolIds: readToolIds,
    allowedChildProfiles: [],
    skillIds: (opts.sourceContext?.governingIndex ?? []).map(
      (entry) => entry.id,
    ),
  });
  return createCogniProgram({
    ...opts,
    onSkillReadFailure: () => {
      if (receipts) receipts.denied = true;
    },
    guardedTools:
      deciding && receipts && writer
        ? [
            createReconcileGuard({
              receipts,
              writer,
              history,
              requiredGuidance: BRIEF_STEWARD_REQUIRED_GUIDANCE,
              origin: opts.sourceContext?.origin ?? "",
            }),
          ]
        : [],
    profile,
    children: [],
  });
}

export function createBriefStewardRunHooks(context: {
  program?: CreateReactAgentGraphOptions["program"];
  origin?: string;
}) {
  const receipts = new StewardReceipts(context.origin ?? "");
  return {
    graphOptions: { programState: receipts },
    onSkillReadFailure: () => {
      receipts.denied = true;
    },
    observeTool: (
      name: string,
      args: unknown,
      result: { ok: boolean; value?: unknown; errorCode?: string },
    ) => {
      if (result.ok) receipts.observe(name, args, result.value);
      // A refused write or an unavailable history is per item: the guard fails that item closed.
      else if (
        name !== WORK_ITEM_RECONCILE_NAME &&
        name !== WORK_ITEM_HISTORY_NAME
      )
        receipts.denied = true;
    },
    projectOutput: () => ({ telemetry: receipts.telemetry() }),
  };
}
createBriefStewardGraph.createRunHooks = createBriefStewardRunHooks;
