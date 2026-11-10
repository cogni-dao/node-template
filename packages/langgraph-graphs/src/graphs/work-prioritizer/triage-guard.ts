// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * The prioritizer's `core__work_item_update`: the tool that mirrors PATCH /api/v1/work/items/{id}, behind a thin guard.
 * One call carries status, scores and labels together with `expectedRevision`. The guard states only what the triage
 * guide requires. The host ToolRunner still authorizes `work_item:transition`, the same grant and door an outside agent uses.
 *   - the triage guide was read this run, and the item was read this run;
 *   - the call carries the exact revision read, and `set` holds only status, scores and labels;
 *   - a score of 4-5 cites a source read this run, never the item's own page;
 *   - at most MAX_CHANGED_ITEMS_PER_RUN distinct items change per run;
 *   - labels keep every existing label and add only a listed goal;
 *   - status routes from needs_triage/research/design/implement to research, design, implement or cancelled; a cancel states its reason;
 *   - a write with no `reason` gets a one-line reason from the guard (task.0052);
 *   - a write that changes nothing writes nothing (a repeat run is quiet).
 * A failed read records nothing; it never blocks a write to a different item.
 */
import {
  WORK_ITEM_UPDATE_NAME,
  type WorkItemUpdateInput,
  workItemUpdateContract,
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
/** The only fields a triage write may set. */
const TRIAGE_FIELDS = new Set(["status", "scores", "labels"]);
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

export function createTriageGuard(
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
    input: WorkItemUpdateInput,
    item: ObservedItem,
  ): string | undefined {
    const { set } = input;
    if (Object.keys(set).some((key) => !TRIAGE_FIELDS.has(key)))
      return reject(
        "field_not_allowed",
        "triage sets only status, scores and labels; never priority, rank, summary, outcome or title",
      );
    if (input.expectedRevision !== item.revision)
      return reject(
        "expected_revision",
        `send expectedRevision ${item.revision}, the revision you read`,
      );
    if (set.status !== undefined && set.status !== item.status) {
      if (!ROUTABLE_FROM.has(item.status))
        return reject(
          "route_source",
          `${item.id} is ${item.status}; triage routes only from needs_triage, needs_research, needs_design or needs_implement`,
        );
      if (!ROUTES.has(set.status))
        return reject(
          "route_not_allowed",
          "route to needs_research, needs_design, needs_implement or cancelled only",
        );
      if (set.status === "cancelled" && !input.reason?.trim())
        return reject("cancel_needs_reason", "state why in reason");
    }
    if (set.labels !== undefined) {
      const allowed = goalLabels();
      const kept = item.labels.every((label) => set.labels?.includes(label));
      const added = set.labels.filter((label) => !item.labels.includes(label));
      if (!kept || added.some((label) => !allowed.has(label)))
        return reject(
          "labels",
          "keep every existing label; add only goal:<id> of a listed goal",
        );
    }
    for (const [axis, score] of Object.entries(set.scores ?? {})) {
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

  /** One-line audit reason for a write the model sent without one (task.0052). */
  function autoReason(input: WorkItemUpdateInput, item: ObservedItem) {
    const { set } = input;
    const parts: string[] = [];
    if (set.status !== undefined && set.status !== item.status)
      parts.push(`status ${item.status}→${set.status}`);
    const moved = Object.entries(set.scores ?? {})
      .filter(([axis, score]) => (item.scores?.[axis]?.v ?? 0) !== score.v)
      .map(
        ([axis, score]) => `${axis} ${item.scores?.[axis]?.v ?? 0}→${score.v}`,
      );
    if (moved.length) parts.push(`scores ${moved.join(", ")}`);
    const added = (set.labels ?? []).filter((l) => !item.labels.includes(l));
    if (added.length) parts.push(added.map((l) => `+${l}`).join(" "));
    return `triage: ${parts.join("; ") || "update"}`.slice(0, 512);
  }

  /** True when the call would leave the item as it is. */
  function noChange(input: WorkItemUpdateInput, item: ObservedItem): boolean {
    const { set } = input;
    const status = set.status === undefined || set.status === item.status;
    const scores =
      set.scores === undefined ||
      (set.scores !== null && sameScores(set.scores, item.scores)) ||
      (set.scores === null && !item.scores);
    const labels =
      set.labels === undefined || sameLabels(set.labels, item.labels);
    return status && scores && labels;
  }

  const run = async (
    input: WorkItemUpdateInput,
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
      const sent = input.reason?.trim()
        ? input
        : { ...input, reason: autoReason(input, item) };
      const result = await writer.invoke(sent, config);
      const text =
        typeof result === "string" ? result : JSON.stringify(result);
      // Success is the item the PATCH route returns; a failure is { success:false } or { error }.
      let output: { id?: unknown; success?: unknown; error?: unknown; revision?: unknown } = {};
      try {
        output = z
          .object({
            id: z.unknown(),
            success: z.unknown(),
            error: z.unknown(),
            revision: z.unknown(),
          })
          .parse(JSON.parse(text));
      } catch {
        /* An unknown reply is not a success; the model reads the item again. */
      }
      if (
        typeof output.id === "string" &&
        output.success !== false &&
        output.error === undefined
      ) {
        changed.add(item.id);
        // The write moved the revision. Keep the new one; without it, force a re-read.
        if (typeof output.revision === "number")
          receipts.items.set(item.id, {
            ...item,
            revision: output.revision,
            status: input.set.status ?? item.status,
            labels: input.set.labels ?? item.labels,
            ...(input.set.scores !== undefined && {
              scores: input.set.scores ?? undefined,
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
    name: WORK_ITEM_UPDATE_NAME,
    description: writer.description,
    schema: workItemUpdateContract.inputSchema,
    func: run,
  }) as StructuredTool;
}
