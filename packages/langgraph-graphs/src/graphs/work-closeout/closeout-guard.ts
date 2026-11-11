// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * The closeout program's `core__work_item_update`: the PATCH route's twin behind a thin guard. The host ToolRunner
 * still authorizes `work_item:transition`. The guard allows exactly one write shape, and only with live proof:
 *   - the item was read this run, and the call carries the exact revision read;
 *   - `set` is {status:"done", deployVerified:true, pr:<pull request URL>} and nothing else;
 *   - the item is open and past triage (needs_implement, needs_merge or needs_closeout);
 *   - the item's own text links that pull request;
 *   - this run read the pull request merged, and the running build contains its merge commit;
 *   - the write carries a reason, and at most MAX_CLOSED_ITEMS_PER_RUN items close per run.
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
import type { CloseoutReceipts } from "./receipts";

export const MAX_CLOSED_ITEMS_PER_RUN = 5;
const CLOSABLE_FROM = new Set([
  "needs_implement",
  "needs_merge",
  "needs_closeout",
]);
const CLOSEOUT_FIELDS = new Set(["status", "deployVerified", "pr"]);
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)$/;

const reject = (code: string, hint: string) =>
  `guard_rejected: ${code}: ${hint}`;

export function createCloseoutGuard(
  receipts: CloseoutReceipts,
  writer: StructuredToolInterface,
) {
  const pending = new Set<string>();

  function refuse(input: WorkItemUpdateInput): string | undefined {
    const item = receipts.items.get(input.id);
    if (!item)
      return reject("item_not_read", "read this item with core__work_item_read first");
    if (!CLOSABLE_FROM.has(item.status))
      return reject(
        "status_source",
        `${item.id} is ${item.status}; closeout closes only needs_implement, needs_merge or needs_closeout`,
      );
    if (input.expectedRevision !== item.revision)
      return reject(
        "expected_revision",
        `send expectedRevision ${item.revision}, the revision you read`,
      );
    const { set } = input;
    if (
      Object.keys(set).some((key) => !CLOSEOUT_FIELDS.has(key)) ||
      set.status !== "done" ||
      set.deployVerified !== true
    )
      return reject(
        "write_shape",
        'closeout sets exactly {"status":"done","deployVerified":true,"pr":"<pull request URL>"}',
      );
    const match = PR_URL.exec(set.pr ?? "");
    if (!match)
      return reject("pr", "set pr to the full https://github.com/<owner>/<repo>/pull/<n> URL");
    const [, owner, repo, n] = match as unknown as [string, string, string, string];
    const linked = new RegExp(
      `github\\.com/${owner}/${repo.replace(/\./g, "\\.")}/pull/${n}(?!\\d)`,
      "i",
    ).test([item.pr, item.summary, item.outcome].join("\n"));
    if (!linked)
      return reject("pr_not_linked", `${item.id} does not link ${set.pr}`);
    if (!receipts.isLive(owner, repo, Number(n)))
      return reject(
        "not_live",
        "read the pull request with core__vcs_pr_read; it must be merged, and core__vcs_commit_contains with its mergeCommitSha must return contains true for the running build",
      );
    if (!input.reason?.trim())
      return reject("reason_required", "name the pull request and merge commit in reason");
    if (
      !receipts.closed.has(item.id) &&
      receipts.closed.size + pending.size >= MAX_CLOSED_ITEMS_PER_RUN
    )
      return reject(
        "write_budget",
        `at most ${MAX_CLOSED_ITEMS_PER_RUN} items close per run`,
      );
    if (pending.has(item.id))
      return reject("write_in_flight", "wait for the earlier write");
    return undefined;
  }

  const run = async (
    input: WorkItemUpdateInput,
    _manager?: unknown,
    config?: RunnableConfig,
  ): Promise<string> => {
    const refused = refuse(input);
    if (refused) {
      receipts.refused += 1;
      return refused;
    }
    pending.add(input.id);
    try {
      const result = await writer.invoke(input, config);
      // Called as a tool call, the writer returns a ToolMessage; its content is the route's reply.
      const text =
        typeof result === "string"
          ? result
          : result instanceof ToolMessage && typeof result.content === "string"
            ? result.content
            : JSON.stringify(result);
      let output: { id?: unknown; success?: unknown; error?: unknown } = {};
      try {
        output = JSON.parse(text);
      } catch {
        /* An unknown reply is not a success. */
      }
      // The item is closed either way once the route returned it; a fresh read decides any retry.
      receipts.items.delete(input.id);
      if (
        typeof output.id === "string" &&
        output.success !== false &&
        output.error === undefined
      )
        receipts.closed.add(input.id);
      return text;
    } catch {
      receipts.items.delete(input.id);
      return "write_result_uncertain: read the item again before closing it";
    } finally {
      pending.delete(input.id);
    }
  };
  // biome-ignore lint/suspicious/noExplicitAny: TS2589 workaround - breaks deep generic instantiation
  const ToolClass: any = DynamicStructuredTool;
  return new ToolClass({
    name: WORK_ITEM_UPDATE_NAME,
    description: writer.description,
    schema: workItemUpdateContract.inputSchema,
    func: run,
  }) as StructuredTool;
}
