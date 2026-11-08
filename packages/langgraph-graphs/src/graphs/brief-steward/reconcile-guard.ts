// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * The model's only write tool: it proposes text, the code decides. Domain authority stays with the
 * host-bound `core__work_item_reconcile` writer and the store behind it.
 */
import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from "@langchain/core/tools";
import { z } from "zod";
import type { StewardReceipts } from "./receipts";
import {
  type HistoryVersion,
  type RunState,
  reconcileCheck,
} from "./reconcile-check";

export const BRIEF_RECONCILE_WRITE_NAME = "brief_reconcile_write";
/** Default `maxLongShare` when no reading carries one; the KPI definition's own value. */
const DEFAULT_MAX_LONG_SHARE = 0.1;

/** A model reason, title or any other key is stripped here and never reaches the host. */
const proposal = z.object({
  id: z.string().min(1),
  expectedRevision: z.number().int().min(0),
  summary: z.string(),
  outcome: z.string(),
});

const text = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value);

/** The host's history read; any failure or an absent port is `undefined`, which fails `recent` closed. */
async function readHistory(
  reader: StructuredToolInterface | undefined,
  id: string,
  config: unknown,
): Promise<readonly HistoryVersion[] | undefined> {
  if (!reader) return undefined;
  try {
    const result = await reader.invoke({ id }, config as never);
    const parsed = z
      .object({
        available: z.literal(true),
        versions: z.array(
          z.object({ at: z.string(), reason: z.string().nullable() }),
        ),
      })
      .safeParse(JSON.parse(text(result)));
    return parsed.success ? parsed.data.versions : undefined;
  } catch {
    return undefined;
  }
}

export function createReconcileGuard(deps: {
  readonly receipts: StewardReceipts;
  /** Host-bound `core__work_item_reconcile`, never offered to the model. */
  readonly writer: StructuredToolInterface;
  /** Host-bound `core__work_item_history`, never offered to the model. */
  readonly history: StructuredToolInterface | undefined;
  readonly requiredGuidance: readonly string[];
  readonly origin: string;
  readonly now?: () => number;
}) {
  const { receipts, writer } = deps;
  const now = deps.now ?? Date.now;
  // One proposal at a time: a parallel tool batch cannot spend the same budget twice.
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task, task);
    tail = next.catch(() => undefined);
    return next;
  };
  const reject = (code: Parameters<StewardReceipts["reject"]>[0]) => {
    receipts.reject(code);
    return `guard_rejected: ${code}`;
  };
  return new DynamicStructuredTool({
    name: BRIEF_RECONCILE_WRITE_NAME,
    description:
      "Propose new summary and outcome text for one open work item named in the KPI's worst rows, read this run at expectedRevision. " +
      "Keep the Goal = and Done when = lines, every link, id and fact; split long sentences and move dated log lines into undated prose. " +
      "Code checks every guard before the host writes; a rejection names the guard.",
    schema: proposal,
    func: async (input, _manager, config) =>
      serial(async () => {
        receipts.attempts++;
        if (
          receipts.denied ||
          deps.requiredGuidance.some((id) => !receipts.guidance.has(id))
        )
          return reject("guidance");
        const read = receipts.items.get(input.id);
        const history = read
          ? await readHistory(deps.history, input.id, config)
          : undefined;
        const run: RunState = {
          kpi: receipts.kpi,
          writes: receipts.written.size,
          written: receipts.written,
          origin: deps.origin,
        };
        const verdict = reconcileCheck(
          read && {
            id: read.id,
            title: read.title ?? "",
            status: read.status,
            revision: read.revision,
            summary: read.summary ?? "",
            outcome: read.outcome ?? "",
          },
          input,
          receipts.kpi?.maxLongShare ?? DEFAULT_MAX_LONG_SHARE,
          history,
          now(),
          run,
        );
        if (!verdict.ok) return reject(verdict.code);
        try {
          const result = await writer.invoke(
            {
              id: input.id,
              expectedRevision: input.expectedRevision,
              summary: input.summary,
              outcome: input.outcome,
              // The guard, not the model, states why.
              reason: verdict.reason,
            },
            config,
          );
          const out = text(result);
          const parsed = z
            .object({ success: z.boolean() })
            .safeParse(JSON.parse(out));
          if (parsed.success && parsed.data.success) receipts.written.add(input.id);
          else receipts.hostRefusals++;
          // Any outcome but success needs a fresh read before this item is proposed again.
          receipts.items.delete(input.id);
          return out;
        } catch {
          receipts.hostRefusals++;
          receipts.items.delete(input.id);
          return "write_result_uncertain: reread before proposing again";
        }
      }),
  });
}
