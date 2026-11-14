// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * The prioritizer's `core__work_item_update`: the tool that mirrors PATCH /api/v1/work/items/{id}, behind a thin guard.
 * One call carries status, scores and labels together with `expectedRevision`. The guard states only what the triage
 * guide requires. The host ToolRunner still authorizes `work_item:transition`, the same grant and door an outside agent uses.
 *   - the triage guide was read this run, and the item was read this run;
 *   - the call carries the exact revision read, and `set` holds only status, scores, labels and moves;
 *   - a score of 4-5 cites a source read this run, never the item's own page;
 *   - at most MAX_CHANGED_ITEMS_PER_RUN distinct items change per run;
 *   - labels keep every existing label and add only a listed goal;
 *   - status routes only from needs_triage, to needs_research, needs_design, needs_implement or cancelled (task.0122), and only
 *     after this run recorded the matching triage artifact (core__work_item_artifact_record, guarded beside this tool); the
 *     store checks the rest of the exit (six scores, a goal label, moves or a gap). Triage may also move a
 *     later item back to needs_triage, or cancel it; every other move out of a later stage is its own review's;
 *   - a write with no `reason` is refused (`reason_required`); the guard never writes a reason for the model (task.0086);
 *   - a write that changes nothing writes nothing (a repeat run is quiet).
 * A failed read records nothing; it never blocks a write to a different item.
 */
import {
  WORK_ITEM_UPDATE_NAME,
  type WorkItemUpdateInput,
  workItemUpdateContract,
} from "@cogni/ai-tools";
import { ToolMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  DynamicStructuredTool,
  type StructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import { z } from "zod";
import { type ObservedItem, ObservedMoves, type RunReceipts } from "./receipts";
import {
  EVIDENCE_ISSUE_MAX_CHARS,
  EVIDENCE_ISSUES_MAX,
  MAX_CHANGED_ITEMS_PER_RUN,
  RECEIPT_ERROR_MAX_CHARS,
} from "./tools";

/** Where triage routes an item out of needs_triage. */
const ROUTES = new Set([
  "needs_research",
  "needs_design",
  "needs_implement",
  "cancelled",
]);
/** The triage artifact verdict each route needs recorded before the status moves. */
const ROUTE_VERDICT: Readonly<Record<string, string>> = {
  needs_research: "research",
  needs_design: "design",
  needs_implement: "implement",
};
const CLOSED = new Set(["done", "cancelled"]);
/** The only fields a triage write may set. */
const TRIAGE_FIELDS = new Set(["status", "scores", "labels", "moves"]);
const EVIDENCE_FROM = 4;

type Scores = NonNullable<ObservedItem["scores"]>;
const ObservedScores = z.record(
  z.string(),
  z.object({ v: z.number().int(), ev: z.string().optional() }),
);

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

type Moves = NonNullable<ObservedItem["moves"]>;
/** Same metrics with the same directions; the server-owned baseline never counts. */
const sameMoves = (a: Moves, b: Moves) =>
  a.length === b.length &&
  a.every((m) =>
    b.some((n) => n.metricId === m.metricId && n.direction === m.direction),
  );

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
        "triage sets only status, scores, labels and moves; never priority, rank, summary, outcome or title",
      );
    if (input.expectedRevision !== item.revision)
      return reject(
        "expected_revision",
        `send expectedRevision ${item.revision}, the revision you read`,
      );
    if (set.status !== undefined && set.status !== item.status) {
      if (item.status === "needs_triage") {
        if (!ROUTES.has(set.status))
          return reject(
            "route_not_allowed",
            "route to needs_research, needs_design, needs_implement or cancelled only",
          );
        const verdict = ROUTE_VERDICT[set.status];
        if (verdict && receipts.triageRecorded.get(item.id) !== verdict)
          return reject(
            "triage_artifact",
            `record the triage artifact first: core__work_item_artifact_record with { id: "${item.id}", artifact: { kind: "triage", subject: "work:${item.id}", verdict: "${verdict}" } } (add a one-line note naming the measurement gap when the item declares no moves), then patch the status`,
          );
      } else if (set.status !== "needs_triage" && set.status !== "cancelled")
        return reject(
          "route_source",
          `${item.id} is ${item.status}; triage routes only from needs_triage (a later status moves on its own review artifact); it may send the item back to needs_triage or cancel it`,
        );
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
    if (!input.reason?.trim())
      return reject(
        "reason_required",
        "state why in reason: one line that says why this change happens",
      );
    // Report independent evidence defects together so one repair does not cost one model turn per axis.
    const evidenceIssues: string[] = [];
    let omittedIssues = 0;
    const addEvidenceIssue = (issue: string) => {
      if (evidenceIssues.length < EVIDENCE_ISSUES_MAX)
        evidenceIssues.push(issue.slice(0, EVIDENCE_ISSUE_MAX_CHARS));
      else omittedIssues++;
    };
    if (
      set.moves !== undefined &&
      (item.moves === undefined || !sameMoves(set.moves, item.moves))
    ) {
      if (!receipts.metricCatalogRead)
        addEvidenceIssue(
          "metric_catalog: read core__goal_progress or core__metric_list before declaring what metrics this work moves",
        );
      if (!set.moves.length && !receipts.metricCatalogComplete)
        addEvidenceIssue(
          "metric_catalog_incomplete: an unavailable or partial catalog cannot establish that no metric fits; read complete discovery before declaring []",
        );
      for (const move of set.moves) {
        if (
          item.moves?.some(
            (stored) =>
              stored.metricId === move.metricId &&
              stored.direction === move.direction,
          )
        )
          continue;
        if (
          !receipts.metricIds.has(move.metricId) ||
          !receipts.guidance.has(move.metricId)
        )
          addEvidenceIssue(
            `metric_not_read: discover ${move.metricId} in core__goal_progress or core__metric_list, then read its full body with core__knowledge_read`,
          );
      }
      const goalScore =
        set.scores === null
          ? undefined
          : (set.scores?.goal ?? item.scores?.goal);
      if (
        goalScore &&
        goalScore.v >= EVIDENCE_FROM &&
        set.moves.length &&
        !set.moves.some(
          (move) =>
            receipts.sources.get(goalScore.ev ?? "")?.sourceId ===
            move.metricId,
        )
      )
        addEvidenceIssue(
          "metric_goal_evidence: a goal score of 4 or 5 for a new metric declaration cites the metric body you read in ev",
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
        addEvidenceIssue(
          `evidence: ${axis} ${score.v} needs a source you read this run in ev; never the item's own page`,
        );
    }
    return evidenceIssues.length
      ? `guard_rejected: ${evidenceIssues.join("; ")}${omittedIssues ? `; ${omittedIssues} additional evidence defects omitted` : ""}`
      : undefined;
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
    // An item with no declaration (`moves` absent) is not the same as one that declared `[]`.
    const moves =
      set.moves === undefined ||
      (item.moves !== undefined && sameMoves(set.moves, item.moves));
    return status && scores && labels && moves;
  }

  const run = async (
    raw: WorkItemUpdateInput,
    _manager?: unknown,
    config?: RunnableConfig,
  ): Promise<string> => {
    // `scores` replaces the whole object on the store. The guard merges a partial patch over the stored axes
    // so an unsent axis is kept, and every later check and the write use the merged object.
    const stored = receipts.items.get(raw.id);
    const input: WorkItemUpdateInput =
      stored && raw.set.scores
        ? {
            ...raw,
            set: {
              ...raw.set,
              scores: { ...stored.scores, ...raw.set.scores },
            },
          }
        : raw;
    const missing = requiredGuidance.filter((id) => !receipts.guidance.has(id));
    if (missing.length)
      return reject(
        "guidance",
        `read these exact ids with core__knowledge_read first: ${missing.join(", ")}`,
      );
    if (receipts.goals.size === 0)
      return reject(
        "goals",
        "read the active goals with core__goal_list first",
      );
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
      const result = await writer.invoke(input, config);
      // Called as a tool call, the writer returns a ToolMessage; its content is the route's reply.
      const text =
        typeof result === "string"
          ? result
          : result instanceof ToolMessage && typeof result.content === "string"
            ? result.content
            : JSON.stringify(result);
      // Success is the item the PATCH route returns; a failure is { success:false } or { error }.
      let output: {
        id?: unknown;
        success?: unknown;
        error?: unknown;
        revision?: unknown;
      } = {};
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
        // Rebuild the receipt from the item the route returned, never from the input. Without a full item, force a re-read.
        const dto = z
          .object({
            revision: z.number().int(),
            status: z.string(),
            labels: z.array(z.string()),
            scores: ObservedScores.optional(),
            moves: ObservedMoves.optional(),
          })
          .safeParse(JSON.parse(text));
        if (dto.success)
          receipts.items.set(item.id, {
            ...item,
            revision: dto.data.revision,
            status: dto.data.status,
            labels: dto.data.labels,
            scores: dto.data.scores,
            moves: dto.data.moves,
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
    func: async (
      input: WorkItemUpdateInput,
      manager: unknown,
      config: RunnableConfig,
    ) => {
      const result = await run(input, manager, config);
      // Refusals happen before the host writer runs. Keep their facts in the same report receipts.
      if (
        result.startsWith("guard_rejected:") ||
        result.startsWith("write_result_uncertain:")
      )
        receipts.recordTool(WORK_ITEM_UPDATE_NAME, input, {
          error: result.slice(0, RECEIPT_ERROR_MAX_CHARS),
        });
      return result;
    },
  }) as StructuredTool;
}
