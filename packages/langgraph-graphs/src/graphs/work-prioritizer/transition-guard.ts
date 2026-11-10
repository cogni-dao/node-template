// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * The prioritizer's `core__work_item_transition`: the real tool contract behind a thin guard.
 * The guard states only what the triage guide requires. The host ToolRunner still authorizes
 * `work_item:transition`, the same grant and door an outside agent uses.
 *   - the item was read this run, and a patch carries that exact revision;
 *   - a score of 4-5 cites a source read this run, never the item's own page;
 *   - at most MAX_CHANGED_ITEMS_PER_RUN distinct items change per run;
 *   - no priority, rank or summary; labels keep every existing label and add only a listed goal;
 *   - status routes only to research, design, implement or cancelled (a cancel states its reason);
 *   - a write that changes nothing writes nothing (a repeat run is quiet).
 * A failed read records nothing; it never blocks a write to a different item.
 */
import {
  WORK_ITEM_TRANSITION_NAME,
  type WorkItemTransitionInput,
  WorkItemTransitionInputSchema,
} from "@cogni/ai-tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  DynamicStructuredTool,
  type StructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import { z } from "zod";
import type { ObservedItem, RunReceipts } from "./receipts";
import { MAX_CHANGED_ITEMS_PER_RUN } from "./tools";

const ROUTES = new Set([
  "needs_research",
  "needs_design",
  "needs_implement",
  "cancelled",
]);
const CLOSED = new Set(["done", "cancelled"]);
/** Triage routes only work that has not started delivery. */
const ROUTABLE_FROM = new Set([
  "needs_triage",
  "needs_research",
  "needs_design",
  "needs_implement",
]);
const EVIDENCE_FROM = 4;

type Scores = NonNullable<ObservedItem["scores"]>;

const reject = (code: string, hint: string) =>
  `guard_rejected: ${code}: ${hint}`;

/** Equal judgments: same value per axis (missing is 0); evidence counts only where it is required. */
function sameScores(a: Scores | undefined, b: Scores | undefined): boolean {
  const axes = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  return [...axes].every((axis) => {
    const x = a?.[axis];
    const y = b?.[axis];
    return (
      (x?.v ?? 0) === (y?.v ?? 0) &&
      ((x?.v ?? 0) < EVIDENCE_FROM || x?.ev === y?.ev)
    );
  });
}

const sameLabels = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((label) => b.includes(label));

export function createTransitionGuard(
  receipts: RunReceipts,
  writer: StructuredToolInterface,
  requiredGuidance: readonly string[],
) {
  const changed = new Set<string>();
  const pending = new Set<string>();

  function goalLabels(): Set<string> {
    const out = new Set<string>();
    for (const goal of receipts.goals.values()) {
      out.add(`goal:${goal.id}`);
      out.add(`goal:${goal.id.replace(/^goal-/, "")}`);
    }
    return out;
  }

  /** The reason to refuse this call, or undefined. Pure over the receipts; writes nothing. */
  function refuse(
    input: WorkItemTransitionInput,
    item: ObservedItem,
  ): string | undefined {
    if (input.action === "transition") {
      if (!ROUTABLE_FROM.has(item.status))
        return reject(
          "route_source",
          `${item.id} is ${item.status}; triage routes only from needs_triage, needs_research, needs_design or needs_implement`,
        );
      if (!input.toStatus || !ROUTES.has(input.toStatus))
        return reject(
          "route_not_allowed",
          "route to needs_research, needs_design, needs_implement or cancelled only",
        );
      if (input.toStatus === "cancelled" && !input.reason?.trim())
        return reject("cancel_needs_reason", "state why in reason");
      return undefined;
    }
    if (
      input.priority !== undefined ||
      input.rank !== undefined ||
      input.summary !== undefined
    )
      return reject(
        "field_not_allowed",
        "triage never changes priority, rank or summary",
      );
    if (input.expectedRevision !== item.revision)
      return reject(
        "expected_revision",
        `send expectedRevision ${item.revision}, the revision you read`,
      );
    if (input.labels !== undefined) {
      const allowed = goalLabels();
      const kept = item.labels.every((label) => input.labels?.includes(label));
      const added = input.labels.filter((label) => !item.labels.includes(label));
      if (!kept || added.some((label) => !allowed.has(label)))
        return reject(
          "labels",
          "keep every existing label; add only goal:<id> of a listed goal",
        );
    }
    for (const [axis, score] of Object.entries(input.scores ?? {})) {
      const stored = item.scores?.[axis];
      if (score.v < EVIDENCE_FROM) continue;
      if (stored?.v === score.v && stored.ev === score.ev) continue;
      let url: URL | undefined;
      try {
        url = score.ev ? new URL(score.ev) : undefined;
      } catch {
        url = undefined;
      }
      if (
        !score.ev ||
        !url ||
        !receipts.allowsEvidenceUrl(url) ||
        !receipts.sources.has(score.ev) ||
        score.ev === item.sourceUrl ||
        receipts.isItemPage(url, item.id)
      )
        return reject(
          "evidence",
          `${axis} ${score.v} needs a source you read this run in ev; never the item's own page`,
        );
    }
    return undefined;
  }

  /** One-line audit reason for a patch the model sent without one (task.0052). */
  function patchReason(input: WorkItemTransitionInput, item: ObservedItem) {
    const parts: string[] = [];
    const moved = Object.entries(input.scores ?? {})
      .filter(([axis, score]) => (item.scores?.[axis]?.v ?? 0) !== score.v)
      .map(([axis, score]) => `${axis} ${item.scores?.[axis]?.v ?? 0}→${score.v}`);
    if (moved.length) parts.push(`scores ${moved.join(", ")}`);
    const added = (input.labels ?? []).filter((l) => !item.labels.includes(l));
    if (added.length) parts.push(added.map((l) => `+${l}`).join(" "));
    return `triage: ${parts.join("; ") || "update"}`.slice(0, 512);
  }

  /** True when the call would leave the item as it is. */
  function noChange(
    input: WorkItemTransitionInput,
    item: ObservedItem,
  ): boolean {
    if (input.action === "transition") return input.toStatus === item.status;
    const scores = input.scores === undefined ||
      (input.scores !== null && sameScores(input.scores, item.scores)) ||
      (input.scores === null && !item.scores);
    const labels =
      input.labels === undefined || sameLabels(input.labels, item.labels);
    return scores && labels;
  }

  const run = async (
    input: WorkItemTransitionInput,
    _manager?: unknown,
    config?: RunnableConfig,
  ): Promise<string> => {
    const missing = requiredGuidance.filter((id) => !receipts.guidance.has(id));
    if (missing.length)
      return reject(
        "guidance",
        `read these exact ids with core__knowledge_read first: ${missing.join(", ")}`,
      );
    if (receipts.goals.size === 0)
      return reject("goals", "read the active goals with core__goal_list first");
    const item = receipts.items.get(input.id);
    if (!item)
      return reject(
        "item_not_read",
        "read this item with core__work_item_read first",
      );
    if (CLOSED.has(item.status))
      return reject("item_closed", `${item.id} is ${item.status}`);
    if (pending.has(item.id))
      return reject("write_in_flight", "wait for the earlier write");
    if (
      !changed.has(item.id) &&
      new Set([...changed, ...pending]).size >= MAX_CHANGED_ITEMS_PER_RUN
    )
      return reject(
        "write_budget",
        `at most ${MAX_CHANGED_ITEMS_PER_RUN} items change per run`,
      );
    const refused = refuse(input, item);
    if (refused) return refused;
    if (noChange(input, item)) return "no_change";

    pending.add(item.id);
    try {
      const sent =
        input.action === "patch" && !input.reason?.trim()
          ? { ...input, reason: patchReason(input, item) }
          : input;
      const result = await writer.invoke(sent, config);
      const text =
        typeof result === "string" ? result : JSON.stringify(result);
      let output: { success?: unknown; revision?: unknown } = {};
      try {
        output = z
          .object({ success: z.unknown(), revision: z.unknown() })
          .parse(JSON.parse(text));
      } catch {
        /* An unknown reply is not a success; the model reads the item again. */
      }
      if (output.success === true) {
        changed.add(item.id);
        // The write moved the revision. Keep the new one for a patch; force a re-read after a status move.
        if (input.action === "patch" && typeof output.revision === "number")
          receipts.items.set(item.id, {
            ...item,
            revision: output.revision,
            labels: input.labels ?? item.labels,
            ...(input.scores !== undefined && {
              scores: input.scores ?? undefined,
            }),
          });
        else receipts.items.delete(item.id);
      }
      return text;
    } catch {
      // An uncertain write may have landed: it counts toward the budget and needs a fresh read.
      changed.add(item.id);
      receipts.items.delete(item.id);
      return "write_result_uncertain: read the item again before proposing again";
    } finally {
      pending.delete(item.id);
    }
  };
  // The contract's own schema (zod 4) passes through; `any` quarantines TS2589 as in runtime/core/langchain-tools.
  // biome-ignore lint/suspicious/noExplicitAny: TS2589 workaround - breaks deep generic instantiation
  const ToolClass: any = DynamicStructuredTool;
  return new ToolClass({
    name: WORK_ITEM_TRANSITION_NAME,
    description: writer.description,
    schema: WorkItemTransitionInputSchema,
    func: run,
  }) as StructuredTool;
}
