// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Per-run observations of the brief steward: what it read, what it wrote, what the guard refused. */
import { z } from "zod";
import { RunReceipts } from "../work-prioritizer/receipts";
import {
  GUARD_CODES,
  type GuardCode,
  type KpiReading,
} from "./reconcile-check";

export const BRIEF_KPI_ID = "brief-conformance-items";
/** One `worst:<id>:<codes>` evidence row of the KPI reading. */
const WORST_ROW = /^worst:([A-Za-z0-9._-]+):\S+$/;

const KpiView = z.object({
  definition: z.object({
    id: z.string(),
    spec: z.object({
      params: z.object({ maxLongShare: z.number().min(0).max(0.5) }),
    }),
  }),
  viewState: z.string(),
  latestAttempt: z
    .object({ status: z.string(), evidenceRefs: z.array(z.string()) })
    .nullable(),
});

export type RejectCounts = Partial<Record<GuardCode | "guidance", number>>;

export class StewardReceipts extends RunReceipts {
  /** The latest `brief-conformance-items` reading; undefined until the run reads it. */
  kpi: (KpiReading & { maxLongShare: number; viewState: string }) | undefined;
  /** Ids written this run. */
  readonly written = new Set<string>();
  readonly rejected: RejectCounts = {};
  /** Proposals that reached the guard. */
  attempts = 0;
  /** Writes the host refused, e.g. a lost compare-and-set. */
  hostRefusals = 0;

  override observe(name: string, args: unknown, value: unknown) {
    super.observe(name, args, value);
    if (name !== "core__metric_read") return;
    const requested = z.object({ id: z.string() }).safeParse(args);
    if (!requested.success || requested.data.id !== BRIEF_KPI_ID) return;
    const parsed = KpiView.safeParse(value);
    // An unreadable reading is a failed reading: no kpi, so every proposal fails `kpi`.
    if (!parsed.success || parsed.data.definition.id !== BRIEF_KPI_ID) {
      this.kpi = undefined;
      return;
    }
    const view = parsed.data;
    const worst = (view.latestAttempt?.evidenceRefs ?? []).flatMap((ref) => {
      const match = WORST_ROW.exec(ref);
      return match?.[1] ? [match[1]] : [];
    });
    this.kpi = {
      ok: view.viewState === "ok" && view.latestAttempt?.status === "ok",
      worst,
      maxLongShare: view.definition.spec.params.maxLongShare,
      viewState: view.viewState,
    };
  }

  reject(code: GuardCode | "guidance") {
    this.rejected[code] = (this.rejected[code] ?? 0) + 1;
  }

  /** The one terminal summary of the run: counts and ids only, never brief text. */
  telemetry() {
    const rejected = Object.fromEntries(
      [...GUARD_CODES, "guidance" as const]
        .filter((code) => this.rejected[code])
        .map((code) => [code, this.rejected[code]]),
    );
    const outcome = !this.kpi
      ? "kpi_unread"
      : !this.kpi.ok
        ? "kpi_not_ok"
        : this.written.size > 0
          ? "wrote"
          : "no_write";
    return {
      outcome,
      kpiViewState: this.kpi?.viewState ?? "unread",
      worstRows: this.kpi?.worst.length ?? 0,
      attempts: this.attempts,
      writeCount: this.written.size,
      changedItemIds: [...this.written],
      hostRefusals: this.hostRefusals,
      rejected,
      denied: this.denied,
    };
  }
}
