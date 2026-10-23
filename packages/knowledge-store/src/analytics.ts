// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/analytics`
 * Purpose: Deterministic, bounded knowledge activity projections with explicit source coverage.
 * Scope: Shared contracts and injected read orchestration; no credentials, routing or lifecycle.
 * Invariants: UNKNOWN_IS_NULL; ACTIVITY_IS_NOT_VALUE; EVENT_TIME_IDENTITY; BOUNDED_SERIAL_READS.
 * Side-effects: Reads only through injected sources; cancellation stops subsequent reads.
 * Links: https://cognidao.org/knowledge/inbox/contrib-flock-leader-conductor-1e912cd7
 * @public
 */
import { z } from "zod";

export const KNOWLEDGE_ANALYTICS_VERSION = "knowledge-analytics.v1";
export const DOLTGRES_ANALYTICS_VERSION = "doltgres-projection.v1";
export const ANALYTICS_BUDGET = {
  calls: 64,
  domains: 32,
  atoms: 500,
  contributions: 100,
  diffs: 20,
  changes: 1_000,
  lookupEvents: 50_000,
  deadlineMs: 12_000,
} as const;
const EventTimeSchema = z.iso.datetime({ offset: true });
export const KnowledgeAnalyticsQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(720).default(168),
  end: z.iso.datetime({ offset: true }).optional(),
});
const SourceProvenanceSchema = z.object({
  adapterVersion: z
    .string()
    .max(80)
    .regex(/^[a-zA-Z0-9_.:-]+$/)
    .nullable(),
  scanWindow: z
    .object({
      start: z.iso.datetime({ offset: true }),
      endExclusive: z.iso.datetime({ offset: true }),
    })
    .nullable(),
  caps: z.partialRecord(
    z.enum([
      "calls",
      "rowsPerCall",
      "chunkHours",
      "domains",
      "atoms",
      "contributions",
      "diffs",
      "changes",
      "events",
      "deadlineMs",
    ]),
    z.number().int().nonnegative()
  ),
});
const CollectionLimitsSchema = z.object({
  calls: z.number().int().positive(),
  domains: z.number().int().positive(),
  atoms: z.number().int().positive(),
  contributions: z.number().int().positive(),
  diffs: z.number().int().positive(),
  changes: z.number().int().positive(),
  lookupEvents: z.number().int().positive(),
  deadlineMs: z.number().int().min(1).max(40_000),
});
const CoverageSchema = z.object({
  status: z.enum(["complete", "partial", "unavailable"]),
  reason: z.string().nullable(),
  provenance: SourceProvenanceSchema,
});
const RowSchema = z.object({
  id: z.string(),
  title: z.string(),
  domain: z.string().nullable(),
  entryType: z.string().nullable(),
  current: z.boolean().nullable(),
  lookupEvents: z.number().int().nonnegative().nullable(),
  mergedChanges: z.number().int().nonnegative().nullable(),
  lastLookupAt: z.string().nullable(),
  policyConfidence: z.number().nullable(),
  sourceRef: z.string().nullable(),
  contributionIds: z.array(z.string()),
});
export const KnowledgeAnalyticsSchema = z.object({
  queryVersion: z.literal(KNOWLEDGE_ANALYTICS_VERSION),
  nodeId: z.string(),
  generatedAt: z.string(),
  inventoryAsOf: z.string(),
  window: z.object({ start: z.string(), endExclusive: z.string() }),
  collectionLimits: CollectionLimitsSchema,
  coverage: z.object({
    inventory: CoverageSchema,
    changes: CoverageSchema,
    backlog: CoverageSchema,
    lookups: CoverageSchema,
  }),
  summary: z.object({
    currentAtoms: z.number().nullable(),
    lookupEvents: z.number().nullable(),
    mergedChanges: z.number().nullable(),
    openInboxes: z.number().nullable(),
  }),
  rows: z.array(RowSchema),
  lookupNormalization: z.object({
    rawEvents: z.number(),
    duplicates: z.number(),
    invalidTimestamps: z.number(),
    outsideWindow: z.number(),
    cappedEvents: z.number(),
  }),
  missionImpact: z.null(),
  limitations: z.array(z.string()),
});
export type KnowledgeAnalytics = z.infer<typeof KnowledgeAnalyticsSchema>;
export type AnalyticsWindow = KnowledgeAnalytics["window"];
/** Adapter-owned provenance; scanWindow is the actual ingestion interval queried, not the event window. */
export interface AnalyticsSourceProvenance {
  adapterVersion: string | null;
  scanWindow: AnalyticsWindow | null;
  caps: Partial<
    Record<
      | "calls"
      | "rowsPerCall"
      | "chunkHours"
      | "domains"
      | "atoms"
      | "contributions"
      | "diffs"
      | "changes"
      | "events"
      | "deadlineMs",
      number
    >
  >;
}
export interface AnalyticsSource<T> {
  status: "complete" | "partial" | "unavailable";
  reason: string | null;
  value: T | null;
  provenance?: AnalyticsSourceProvenance;
}
export interface AnalyticsAtom {
  id: string;
  title: string;
  domain: string;
  entryType?: string | null | undefined;
  confidencePct?: number | null | undefined;
  sourceRef?: string | null | undefined;
}
export interface LookupEvent {
  requestId: string;
  atomId: string;
  eventAt: string;
}
export interface ContentChange {
  atomId: string;
  contributionId: string;
}
export interface SemanticDiff {
  rowId: string;
  changeType: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/** Normalize only source-scoped lookup events, not successful HTTP responses or consumption. */
export function normalizeLookupEvents(
  nodeId: string,
  window: AnalyticsWindow,
  rows: readonly LookupEvent[]
) {
  const events: LookupEvent[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let invalidTimestamps = 0;
  let outsideWindow = 0;
  for (const row of rows) {
    const valid = EventTimeSchema.safeParse(row.eventAt);
    if (!valid.success || !row.requestId || !row.atomId) {
      invalidTimestamps++;
      continue;
    }
    const time = Date.parse(row.eventAt);
    if (
      time < Date.parse(window.start) ||
      time >= Date.parse(window.endExclusive)
    ) {
      outsideWindow++;
      continue;
    }
    const eventAt = new Date(time).toISOString();
    const key = JSON.stringify([nodeId, row.requestId, row.atomId, eventAt]);
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    events.push({ ...row, eventAt });
  }
  return { events, duplicates, invalidTimestamps, outsideWindow };
}

/** Stable visible content semantics across contribution adapters; metadata-only deltas are excluded. */
export function semanticChangeIds(rows: readonly SemanticDiff[]): string[] {
  const fields = ["title", "content", "useWhen", "entryType", "domain"];
  return [
    ...new Set(
      rows
        .filter(
          (row) =>
            row.changeType === "added" ||
            row.changeType === "removed" ||
            (row.changeType === "modified" &&
              fields.some(
                (key) =>
                  (row.before?.[key] ?? null) !== (row.after?.[key] ?? null)
              ))
        )
        .map((row) => row.rowId)
    ),
  ].sort();
}

export function buildKnowledgeAnalytics(input: {
  nodeId: string;
  window: AnalyticsWindow;
  generatedAt: string;
  inventory: AnalyticsSource<readonly AnalyticsAtom[]>;
  changes: AnalyticsSource<readonly ContentChange[]>;
  backlog: AnalyticsSource<number>;
  lookups: AnalyticsSource<readonly LookupEvent[]>;
  deadlineMs?: number;
}): KnowledgeAnalytics {
  const atoms = new Map(
    (input.inventory.status === "unavailable"
      ? []
      : (input.inventory.value ?? [])
    ).map((atom) => [atom.id, atom])
  );
  const rawLookups =
    input.lookups.status === "unavailable" ? [] : (input.lookups.value ?? []);
  const cappedEvents = Math.max(
    0,
    rawLookups.length - ANALYTICS_BUDGET.lookupEvents
  );
  const normalized = normalizeLookupEvents(
    input.nodeId,
    input.window,
    rawLookups.slice(0, ANALYTICS_BUDGET.lookupEvents)
  );
  const lookups = new Map<string, { count: number; last: string }>();
  for (const event of normalized.events) {
    const previous = lookups.get(event.atomId);
    lookups.set(event.atomId, {
      count: (previous?.count ?? 0) + 1,
      last:
        previous && previous.last > event.eventAt
          ? previous.last
          : event.eventAt,
    });
  }
  const changes = new Map<string, Set<string>>();
  for (const change of input.changes.status === "unavailable"
    ? []
    : (input.changes.value ?? [])) {
    const refs = changes.get(change.atomId) ?? new Set<string>();
    refs.add(change.contributionId);
    changes.set(change.atomId, refs);
  }
  const coverage = (source: AnalyticsSource<unknown>) => ({
    status: source.status,
    reason: source.reason,
    provenance: source.provenance ?? {
      adapterVersion: null,
      scanWindow: null,
      caps: {},
    },
  });
  const lookupCoverage = coverage(input.lookups);
  if (normalized.invalidTimestamps && lookupCoverage.status !== "unavailable") {
    lookupCoverage.status = "partial";
    lookupCoverage.reason = "invalid_event_timestamps";
  }
  if (cappedEvents && lookupCoverage.status !== "unavailable") {
    lookupCoverage.status = "partial";
    lookupCoverage.reason = "lookup_event_limit";
  }
  const rows = [
    ...new Set([...atoms.keys(), ...lookups.keys(), ...changes.keys()]),
  ]
    .map((id) => {
      const atom = atoms.get(id);
      const events = lookups.get(id);
      return {
        id,
        title: atom?.title ?? id,
        domain: atom?.domain ?? null,
        entryType: atom?.entryType ?? null,
        current: atom
          ? true
          : input.inventory.status === "complete"
            ? false
            : null,
        lookupEvents:
          input.lookups.status === "unavailable" ? null : (events?.count ?? 0),
        mergedChanges:
          input.changes.status === "unavailable"
            ? null
            : (changes.get(id)?.size ?? 0),
        lastLookupAt: events?.last ?? null,
        policyConfidence:
          atom?.entryType === "goal" ? null : (atom?.confidencePct ?? null),
        sourceRef: atom?.sourceRef ?? null,
        contributionIds: [...(changes.get(id) ?? [])].sort(),
      };
    })
    .sort(
      (a, b) =>
        (b.lookupEvents ?? -1) - (a.lookupEvents ?? -1) ||
        (b.mergedChanges ?? -1) - (a.mergedChanges ?? -1) ||
        a.id.localeCompare(b.id)
    );
  return KnowledgeAnalyticsSchema.parse({
    queryVersion: KNOWLEDGE_ANALYTICS_VERSION,
    nodeId: input.nodeId,
    generatedAt: input.generatedAt,
    inventoryAsOf: input.generatedAt,
    collectionLimits: {
      ...ANALYTICS_BUDGET,
      deadlineMs: input.deadlineMs ?? ANALYTICS_BUDGET.deadlineMs,
    },
    window: input.window,
    coverage: {
      inventory: coverage(input.inventory),
      changes: coverage(input.changes),
      backlog: coverage(input.backlog),
      lookups: lookupCoverage,
    },
    summary: {
      currentAtoms:
        input.inventory.status === "unavailable" ? null : atoms.size,
      lookupEvents:
        input.lookups.status === "unavailable"
          ? null
          : normalized.events.length,
      mergedChanges:
        input.changes.status === "unavailable"
          ? null
          : rows.reduce((sum, row) => sum + (row.mergedChanges ?? 0), 0),
      openInboxes:
        input.backlog.status === "unavailable" ? null : input.backlog.value,
    },
    rows,
    lookupNormalization: {
      rawEvents: rawLookups.length,
      duplicates: normalized.duplicates,
      invalidTimestamps: normalized.invalidTimestamps,
      outsideWindow: normalized.outsideWindow,
      cappedEvents,
    },
    missionImpact: null,
    limitations: [
      "Activity directs scrutiny; mission impact, pivotal guidance recall and context efficiency are not measured.",
      "Lookup events precede response validation: HTTP 2xx and actual consumption are not proven. Caller IDs and finite timestamps can collide; counts are observed estimates.",
      "Lookup coverage excludes cognition, internal tools and cached use. Ingestion-window queries may miss late arrivals.",
      "Current metadata and policy confidence are not historical snapshots or calibrated probabilities. Domain filters use current metadata; reads are not one atomic snapshot.",
      "Source projections omit content bodies and cap returned rows. Metadata text bytes and Dolt diff computation are not hard-bounded; the deadline only stops subsequent reads.",
      "sourceRef is current provenance, not a content hash; fetch the current full body before proposing edits.",
      "Changes count visible content deltas once per merged contribution, not all writes, confidence-only changes, tags-only changes or improvements.",
      "Partial sources produce observed rankings and lower bounds, never population-wide top rankings.",
    ],
  });
}

export interface AnalyticsContribution {
  contributionId: string;
  resolvedAt: string | null;
  baseCommit?: string;
  headCommit?: string | null;
}

/** Sources return at most limit+1 metadata rows; the extra row signals incomplete coverage. */
export interface AnalyticsReadSources {
  /** Static source version/caps survive a failed read; actual scan bounds come from the adapter result. */
  provenance?: Partial<
    Record<
      "inventory" | "changes" | "backlog" | "lookups",
      AnalyticsSourceProvenance
    >
  >;
  domains(): Promise<string[]>;
  atoms(domain: string, limit: number): Promise<AnalyticsAtom[]>;
  contributions(
    state: "open" | "merged",
    limit: number
  ): Promise<AnalyticsContribution[]>;
  /** Project semantic changed IDs in the source, never hydrate full content diffs. */
  changeIds(receipt: AnalyticsContribution, limit: number): Promise<string[]>;
  /** Caller authorizes this node-scoped source on every request, before any cached read. */
  lookups?(
    window: AnalyticsWindow,
    signal: AbortSignal
  ): Promise<AnalyticsSource<readonly LookupEvent[]>>;
}

/** Serial, capped reads. Deadline/abort is cooperative: an existing port call must settle before returning. */
export async function collectKnowledgeAnalytics(input: {
  nodeId: string;
  hours: number;
  end?: string;
  now?: () => number;
  signal: AbortSignal;
  sources: AnalyticsReadSources;
  /** Cooperative collection deadline; host may choose up to40s for an authorized log source. */
  deadlineMs?: number;
}): Promise<KnowledgeAnalytics> {
  const now = input.now ?? Date.now;
  const begun = now();
  const deadlineMs = z
    .number()
    .int()
    .min(1)
    .max(40_000)
    .parse(input.deadlineMs ?? ANALYTICS_BUDGET.deadlineMs);
  const query = KnowledgeAnalyticsQuerySchema.parse({
    hours: input.hours,
    end: input.end,
  });
  const end = query.end ? Date.parse(query.end) : begun;
  if (end > begun) throw new Error("future_window");
  const window = {
    start: new Date(end - query.hours * 3_600_000).toISOString(),
    endExclusive: new Date(end).toISOString(),
  };
  let calls = 0;
  async function read<T>(fn: () => Promise<T>): Promise<T> {
    if (input.signal.aborted) throw new Error("cancelled");
    if (now() - begun >= deadlineMs) throw new Error("deadline");
    if (calls >= ANALYTICS_BUDGET.calls) throw new Error("call_budget");
    calls++;
    const result = await fn();
    // A provider may return completed partial evidence after cancellation. Preserve it;
    // the pre-call guard still prevents any subsequent IO.
    return result;
  }
  const failureReason = (error?: unknown) =>
    input.signal.aborted
      ? "cancelled"
      : now() - begun >= deadlineMs
        ? "deadline"
        : calls >= ANALYTICS_BUDGET.calls
          ? "call_budget"
          : error instanceof Error &&
              error.message === "invalid_contribution_receipt"
            ? "invalid_contribution_receipt"
            : "source_error";
  async function source<T>(
    fn: () => Promise<AnalyticsSource<T>>
  ): Promise<AnalyticsSource<T>> {
    try {
      return await fn();
    } catch (error) {
      return {
        status: "unavailable",
        reason: failureReason(error),
        value: null,
      };
    }
  }
  const inventory = await source(async () => {
    const domains = await read(() => input.sources.domains());
    const value: AnalyticsAtom[] = [];
    let partial = domains.length > ANALYTICS_BUDGET.domains;
    let scanned = 0;
    let reason: string | null = partial ? "inventory_limit" : null;
    for (const domain of domains.slice(0, ANALYTICS_BUDGET.domains)) {
      const remaining = ANALYTICS_BUDGET.atoms - value.length;
      if (remaining <= 0) {
        partial = true;
        reason = "inventory_limit";
        break;
      }
      try {
        const rows = await read(() => input.sources.atoms(domain, remaining));
        scanned++;
        value.push(...rows.slice(0, remaining));
        if (rows.length > remaining) {
          partial = true;
          reason = "inventory_limit";
        }
      } catch (error) {
        if (!scanned) throw error;
        partial = true;
        reason = failureReason(error);
        break;
      }
    }
    return {
      status: partial ? ("partial" as const) : ("complete" as const),
      reason,
      value,
    };
  });
  const backlog = await source(async () => {
    const rows = await read(() =>
      input.sources.contributions("open", ANALYTICS_BUDGET.contributions)
    );
    return {
      status:
        rows.length > ANALYTICS_BUDGET.contributions
          ? ("partial" as const)
          : ("complete" as const),
      reason:
        rows.length > ANALYTICS_BUDGET.contributions
          ? "contribution_limit"
          : null,
      value: Math.min(rows.length, ANALYTICS_BUDGET.contributions),
    };
  });
  const changes = await source(async () => {
    const rows = await read(() =>
      input.sources.contributions("merged", ANALYTICS_BUDGET.contributions)
    );
    const selected = rows
      .slice(0, ANALYTICS_BUDGET.contributions)
      .filter(
        (row) =>
          row.resolvedAt &&
          Date.parse(row.resolvedAt) >= Date.parse(window.start) &&
          Date.parse(row.resolvedAt) < end
      );
    const value: ContentChange[] = [];
    let scanned = 0;
    let interrupted: string | null = null;
    for (const row of selected.slice(0, ANALYTICS_BUDGET.diffs)) {
      try {
        const remaining = ANALYTICS_BUDGET.changes - value.length;
        const ids = await read(() => input.sources.changeIds(row, remaining));
        scanned++;
        value.push(
          ...Array.from(new Set(ids))
            .slice(0, remaining)
            .map((atomId) => ({
              atomId,
              contributionId: row.contributionId,
            }))
        );
        if (
          ids.length > remaining ||
          value.length >= ANALYTICS_BUDGET.changes
        ) {
          interrupted = "change_row_limit";
          break;
        }
      } catch (error) {
        if (!scanned) throw error;
        interrupted = failureReason(error);
        break;
      }
    }
    const partial =
      !!interrupted ||
      rows.length > ANALYTICS_BUDGET.contributions ||
      selected.length > ANALYTICS_BUDGET.diffs;
    return {
      status: partial ? ("partial" as const) : ("complete" as const),
      reason: interrupted ?? (partial ? "contribution_limit" : null),
      value,
    };
  });
  const lookupSource = input.sources.lookups;
  const lookups: AnalyticsSource<readonly LookupEvent[]> = lookupSource
    ? await source(() => read(() => lookupSource(window, input.signal)))
    : {
        status: "unavailable" as const,
        reason: "source_not_bound",
        value: null,
      };
  function withProvenance<T>(
    value: AnalyticsSource<T>,
    name: "inventory" | "backlog" | "changes" | "lookups"
  ): AnalyticsSource<T> {
    const provenance = value.provenance ?? input.sources.provenance?.[name];
    return provenance ? { ...value, provenance } : value;
  }
  return buildKnowledgeAnalytics({
    nodeId: input.nodeId,
    window,
    generatedAt: new Date(now()).toISOString(),
    inventory: withProvenance(inventory, "inventory"),
    backlog: withProvenance(backlog, "backlog"),
    changes: withProvenance(changes, "changes"),
    lookups: withProvenance(lookups, "lookups"),
    deadlineMs,
  });
}
