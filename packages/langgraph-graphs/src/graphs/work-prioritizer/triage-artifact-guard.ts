// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * The prioritizer's `core__work_item_artifact_record`: the POST artifacts route's twin behind a thin guard (task.0122).
 * Moving an item out of needs_triage needs a `triage` artifact (the route), so the program records it here and then patches the
 * status with the guarded `core__work_item_update`. The host ToolRunner still authorizes `work_item:transition`. The guard allows exactly one shape:
 *   - the triage guide and the active goals were read this run, and the item was read this run and is still in needs_triage;
 *   - `kind` is "triage", `subject` is `work:<this item>` and `verdict` is research, design or implement;
 *   - at most MAX_CHANGED_ITEMS_PER_RUN distinct items get a triage artifact per run (the same cap the writer has).
 * A success is remembered in the run's receipts: the update guard routes an item forward only for the verdict recorded here.
 * Recording never changes the item; the store stamps the author and the item revision.
 */
import {
  WORK_ITEM_ARTIFACT_RECORD_NAME,
  type WorkItemArtifactRecordInput,
  workItemArtifactRecordContract,
} from "@cogni/ai-tools";
import { ToolMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  DynamicStructuredTool,
  type StructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import { z } from "zod";
import type { RunReceipts } from "./receipts";
import { MAX_CHANGED_ITEMS_PER_RUN, RECEIPT_ERROR_MAX_CHARS } from "./tools";

const TRIAGE_VERDICTS = new Set(["research", "design", "implement"]);

const reject = (code: string, hint: string) =>
  `guard_rejected: ${code}: ${hint}`;

export function createTriageArtifactGuard(
  receipts: RunReceipts,
  writer: StructuredToolInterface,
  requiredGuidance: readonly string[],
) {
  const pending = new Set<string>();

  const run = async (
    input: WorkItemArtifactRecordInput,
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
    if (item.status !== "needs_triage")
      return reject(
        "artifact_source",
        `${item.id} is ${item.status}; the program records a triage artifact only for an item in needs_triage`,
      );
    const { artifact } = input;
    if (
      artifact.kind !== "triage" ||
      artifact.subject !== `work:${item.id}` ||
      !TRIAGE_VERDICTS.has(artifact.verdict)
    )
      return reject(
        "artifact_shape",
        `record exactly { kind: "triage", subject: "work:${item.id}", verdict: "research" | "design" | "implement" }, plus a one-line note naming the measurement gap when the item declares no moves`,
      );
    if (pending.has(item.id))
      return reject("write_in_flight", "wait for the earlier write");
    if (
      !receipts.triageRecorded.has(item.id) &&
      new Set([...receipts.triageRecorded.keys(), ...pending]).size >=
        MAX_CHANGED_ITEMS_PER_RUN
    )
      return reject(
        "write_budget",
        `at most ${MAX_CHANGED_ITEMS_PER_RUN} items are triaged per run`,
      );

    pending.add(item.id);
    try {
      const result = await writer.invoke(input, config);
      // Called as a tool call, the writer returns a ToolMessage; its content is the tool result.
      const text =
        typeof result === "string"
          ? result
          : result instanceof ToolMessage && typeof result.content === "string"
            ? result.content
            : JSON.stringify(result);
      const recorded = (() => {
        try {
          return z
            .object({
              artifact: z.object({ kind: z.literal("triage"), verdict: z.string() }),
            })
            .safeParse(JSON.parse(text));
        } catch {
          return undefined;
        }
      })();
      if (recorded?.success) {
        receipts.triageRecorded.set(item.id, recorded.data.artifact.verdict);
      }
      return text;
    } catch {
      // An uncertain write may have landed: read the artifacts before recording again.
      return "write_result_uncertain: read the item again before recording again";
    } finally {
      pending.delete(item.id);
    }
  };
  // biome-ignore lint/suspicious/noExplicitAny: TS2589 workaround - breaks deep generic instantiation
  const ToolClass: any = DynamicStructuredTool;
  return new ToolClass({
    name: WORK_ITEM_ARTIFACT_RECORD_NAME,
    description: writer.description,
    schema: workItemArtifactRecordContract.inputSchema,
    func: async (
      input: WorkItemArtifactRecordInput,
      manager: unknown,
      config: RunnableConfig,
    ) => {
      const result = await run(input, manager, config);
      if (
        result.startsWith("guard_rejected:") ||
        result.startsWith("write_result_uncertain:")
      )
        receipts.recordTool(WORK_ITEM_ARTIFACT_RECORD_NAME, input, {
          error: result.slice(0, RECEIPT_ERROR_MAX_CHARS),
        });
      return result;
    },
  }) as StructuredTool;
}
