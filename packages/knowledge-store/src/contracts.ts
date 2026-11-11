// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/contracts`
 * Purpose: Canonical knowledge wire schema and pure knowledge/EDO capability contracts.
 * Scope: Pure schemas and types; no adapters, I/O or environment access.
 * Invariants: HTTP and tool read envelopes derive from this domain owner.
 * Side-effects: none
 * @public
 */

import { z } from "zod";

export const KnowledgeRowSchema = z.object({
	id: z.string(),
	domain: z.string(),
	entityId: z.string().nullable(),
	title: z.string(),
	content: z.string(),
	useWhen: z.string().nullable().optional(),
	entryType: z.string(),
  metricSpec: z.record(z.string(), z.unknown()).nullable().optional(),
  kpiBindings: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
	confidencePct: z.number().int().nullable(),
	sourceType: z.string(),
	sourceRef: z.string().nullable(),
	tags: z.array(z.string()).nullable(),
	/** ISO timestamp — a hypothesis's resolution date or a goal's `By:` deadline. */
	evaluateAt: z.string().nullable(),
	/** Namespaced resolver id on hypothesis/goal rows (`manual`, `agent`, `metric:<kpi>`). */
	resolutionStrategy: z.string().nullable(),
	createdAt: z.string().nullable(),
});
export type KnowledgeRow = z.infer<typeof KnowledgeRowSchema>;

/**
 * Confidence score defaults for knowledge entries.
 *
 * - DRAFT (30%): Agent-produced, unverified. Default for all new writes.
 * - VERIFIED (80%): Human-reviewed OR agent-confirmed with fresh sources.
 * - HARDENED (95%): Outcome-validated, statistically significant, or repeatedly confirmed.
 */
export const CONFIDENCE = {
  DRAFT: 30,
  VERIFIED: 80,
  HARDENED: 95,
} as const;

export type KnowledgeEntry = KnowledgeRow;

export interface KnowledgeSearchParams {
  domain: string;
  query: string;
  limit?: number;
}

export interface KnowledgeListParams {
  domain: string;
  tags?: string[];
  limit?: number;
}

export interface KnowledgeWriteParams {
  id: string;
  domain: string;
  title: string;
  content: string;
  sourceType: "human" | "analysis_signal" | "external" | "derived";
  entityId?: string;
  confidencePct?: number;
  sourceRef?: string;
  tags?: string[];
}

/**
 * Knowledge capability — injected into tool implementations at runtime.
 * Backed by KnowledgeStorePort + auto-commit on writes.
 */
export interface KnowledgeCapability {
  /** Search knowledge by domain + text query */
  search(params: KnowledgeSearchParams): Promise<KnowledgeEntry[]>;
  /** List knowledge by domain, optionally filtered by tags */
  list(params: KnowledgeListParams): Promise<KnowledgeEntry[]>;
  /** Get a single knowledge entry by ID */
  get(id: string): Promise<KnowledgeEntry | null>;
  /** Write a knowledge entry + auto-commit. Returns the entry with defaults applied. */
  write(params: KnowledgeWriteParams): Promise<KnowledgeEntry>;
  /**
   * The approved DAO goals (ONE_GOAL_LIST, dao-goals-design): merged `goal-*` atoms, not deprecated.
   * Optional: a node whose store has no goal reader omits it and `core__goal_list` reports goals
   * unavailable.
   */
  listActiveGoals?(): Promise<readonly ActiveGoalInfo[]>;
}

/** One approved DAO goal as tools see it. */
export interface ActiveGoalInfo {
  readonly id: string;
  readonly title: string;
  /** The goal statement (KPI, baseline, target, by, serves-mission). */
  readonly content: string;
  /** ISO `By:` deadline, when set. */
  readonly evaluateAt: string | null;
  /** Optional node-composed measurements. The storage package does not compute them. */
  readonly kpis?: readonly Record<string, unknown>[];
}

/**
 * Source type for EDO writes. Mirrors the domain SourceType enum.
 */
export type EdoSourceType =
  | "human"
  | "agent"
  | "analysis_signal"
  | "external"
  | "derived";

/**
 * Inputs to `hypothesize`. Files a `hypothesis` row + N `evidence_for`
 * citations + commits.
 */
export interface HypothesizeParams {
  id: string;
  domain: string;
  title: string;
  content: string;
  /** When the hypothesis should resolve. REQUIRED (HYPOTHESIS_HAS_EVALUATE_AT). */
  evaluateAt: Date;
  /**
   * Resolution strategy. NULL/undefined = manual (cron skips; row sits until
   * explicit `recordOutcome`). v0 non-null value: `'agent'`. Future kinds
   * (`market:<id>`, `metric:<query>`, `http:<url>`, `deadline`) add values.
   */
  resolutionStrategy?: string | null;
  /** IDs of event/observation/finding rows that motivate this prediction. */
  evidenceForIds?: string[];
  sourceType: EdoSourceType;
  sourceRef?: string;
  sourceNode?: string;
  tags?: string[];
  confidencePct?: number;
}

/**
 * Inputs to `decide`. Files a `decision` row + 1 `derives_from` citation +
 * commits. The decision MUST derive from a hypothesis or a DAO goal
 * (DECISION_CITES_HYPOTHESIS + EDGE_TYPE_MATCHES_CITED_ENTRY_TYPE).
 */
export interface DecideParams {
  id: string;
  domain: string;
  title: string;
  content: string;
  /** ID of the hypothesis or DAO goal being acted on. MUST refer to entry_type='hypothesis' or 'goal'. */
  derivesFromHypothesisId: string;
  sourceType: EdoSourceType;
  sourceRef?: string;
  sourceNode?: string;
  tags?: string[];
  confidencePct?: number;
}

/**
 * Inputs to `recordOutcome`. Files an `outcome` row + 1 validates/invalidates
 * citation + recomputes confidence on the hypothesis + commits.
 */
export interface RecordOutcomeParams {
  id: string;
  domain: string;
  title: string;
  content: string;
  /** ID of the hypothesis being resolved. */
  hypothesisId: string;
  /** Did the prediction hold? */
  edge: "validates" | "invalidates";
  sourceType: EdoSourceType;
  sourceRef?: string;
  sourceNode?: string;
  tags?: string[];
  confidencePct?: number;
}

/**
 * Output of `recordOutcome` — includes the recomputed confidence on the
 * hypothesis so the agent can see the loop close.
 */
export interface RecordOutcomeResult {
  outcome: KnowledgeEntry;
  hypothesisId: string;
  resolvedConfidence: number;
  citationId: string;
  /** True if the hypothesis was already resolved; this call was a no-op. */
  alreadyResolved: boolean;
}

/**
 * Citation-DAG walk direction. `out` follows citing→cited (what this row
 * cites), `in` follows cited→citing (what cites this row), `both` follows
 * both. The default for `getChain` is `both`.
 */
export type ChainDirection = "out" | "in" | "both";

/**
 * Options for `EdoCapability.getChain`.
 */
export interface GetChainParams {
  rootId: string;
  /** Default `both`. */
  direction?: ChainDirection;
  /** Default 5; capped at 10 by the underlying port adapter. */
  maxDepth?: number;
}

/**
 * One node in a walked chain. The root has `edgeFromParent: null` and
 * `depth: 0`. Deeper nodes carry the edge that connected them to their
 * BFS parent.
 */
export interface ChainNodeEntry {
  entry: KnowledgeEntry;
  /**
   * The citation type that brought this node into the walk. Mirrors the
   * domain `CitationType` enum (`supports`, `contradicts`, `extends`,
   * `supersedes`, `evidence_for`, `derives_from`, `validates`, `invalidates`).
   * `null` only on the root.
   */
  edgeFromParent: {
    citationType: string;
    /** `out` = parent cites this; `in` = this cites parent. */
    direction: "out" | "in";
  } | null;
  /** BFS depth, 0 at the root. */
  depth: number;
}

/**
 * Output of `getChain`. Flat list, ordered by depth (root first). Cycle-safe:
 * each entry id appears at most once.
 */
export interface GetChainResult {
  root: KnowledgeEntry;
  chain: ChainNodeEntry[];
}

/**
 * EdoCapability — atomic four-beat operations on the hypothesis loop.
 *
 * Backed by `KnowledgeStorePort` + `EdoResolverPort` + auto-commit. Each call
 * is a single Doltgres commit: row + edges + (for outcomes) confidence
 * recompute.
 */
export interface EdoCapability {
  /** File a hypothesis row with evaluate_at + N evidence_for edges + commit. */
  hypothesize(params: HypothesizeParams): Promise<KnowledgeEntry>;
  /** File a decision row + 1 derives_from edge + commit. */
  decide(params: DecideParams): Promise<KnowledgeEntry>;
  /**
   * File an outcome row + 1 validates/invalidates edge + recompute confidence +
   * commit. Idempotent on already-resolved hypotheses.
   */
  recordOutcome(params: RecordOutcomeParams): Promise<RecordOutcomeResult>;
  /**
   * Walk the citation DAG from `rootId`. Read-only; surfaces the EDO chain
   * (hypothesis → decision → outcome + evidence/validates/invalidates edges)
   * for human and agent rendering. See `docs/spec/knowledge-syntropy.md` §
   * Chain Read API.
   */
  getChain(params: GetChainParams): Promise<GetChainResult>;
}

/**
 * Row history (task.0052, story.0023). ONE_HISTORY_SHAPE: `@cogni-dao/work-items`
 * declares the same item shape; the reason is the contribution commit message.
 */
export const HistoryEntrySchema = z.object({
  version: z.string(),
  commit: z.string(),
  at: z.string(),
  actor: z.string().nullable(),
  reason: z.string().nullable(),
  /** Always `[]` on knowledge: the shape is the work-items one so both planes serve one contract (task.0086). */
  cites: z.array(
    z.object({
      id: z.string(),
      commit: z.string(),
      contribution: z.string().optional(),
    })
  ),
  changed: z.array(z.string()),
  diff: z.record(
    z.string(),
    z.object({
      before: z.unknown(),
      after: z.unknown(),
      truncated: z.boolean(),
    })
  ),
});

export const HistoryOutputSchema = z.object({
  items: z.array(HistoryEntrySchema),
});

export type HistoryOutput = z.infer<typeof HistoryOutputSchema>;

export const knowledgeHistoryOperation = {
  id: "knowledge.history.v1",
  summary: "Read a knowledge entry's history",
  description:
    "Returns the entry's versions, newest first, each with its change reason (the contribution commit message), actor and changed fields. `cites` is always empty on knowledge.",
  input: z.object({ id: z.string() }),
  output: HistoryOutputSchema,
} as const;

/** Content-free row for browsing and overview. */
export const KnowledgeSummarySchema = KnowledgeRowSchema.pick({
  id: true,
  domain: true,
  entityId: true,
  title: true,
  useWhen: true,
  entryType: true,
  confidencePct: true,
  sourceType: true,
  createdAt: true,
});
export type KnowledgeSummary = z.infer<typeof KnowledgeSummarySchema>;
/** Rows in one browse or overview window. */
export const KNOWLEDGE_BROWSE_PAGE_SIZE = 20;
/** Exact values one browse filter (domains, entry types, source types) may hold. */
export const KNOWLEDGE_BROWSE_FILTER_VALUES_MAX = 50;
/** Longest exact browse filter value. */
export const KNOWLEDGE_BROWSE_FILTER_VALUE_MAX_LENGTH = 500;
/** Longest browse body search. */
export const KNOWLEDGE_BROWSE_SEARCH_MAX_LENGTH = 2000;
/** Longest browse continuation cursor. */
export const KNOWLEDGE_BROWSE_CURSOR_MAX_LENGTH = 16000;

const exactValues = z
  .array(z.string().min(1).max(KNOWLEDGE_BROWSE_FILTER_VALUE_MAX_LENGTH))
  .max(KNOWLEDGE_BROWSE_FILTER_VALUES_MAX)
  .default([])
  .transform((values) => [...new Set(values)].sort());
export const KnowledgeBrowseQuerySchema = z
  .object({
    sort: z
      .enum([
        "id",
        "domain",
        "entryType",
        "confidencePct",
        "sourceType",
        "createdAt",
      ])
      .default("createdAt"),
    direction: z.enum(["asc", "desc"]).default("desc"),
    domains: exactValues,
    entryTypes: exactValues,
    sourceTypes: exactValues,
    search: z.string().max(KNOWLEDGE_BROWSE_SEARCH_MAX_LENGTH).optional(),
    cursor: z.string().min(1).max(KNOWLEDGE_BROWSE_CURSOR_MAX_LENGTH).optional(),
  })
  .strict();
export type KnowledgeBrowseQuery = z.input<typeof KnowledgeBrowseQuerySchema>;
export const KnowledgeOverviewQuerySchema = KnowledgeBrowseQuerySchema.omit({
  search: true,
});
export type KnowledgeOverviewQuery = z.input<
  typeof KnowledgeOverviewQuerySchema
>;
export const KnowledgeBrowsePageSchema = z.object({
  /** Observed committed HEAD before this live window; not a snapshot token. */
  revision: z.string().min(1).max(200),
  items: z.array(KnowledgeSummarySchema).max(KNOWLEDGE_BROWSE_PAGE_SIZE),
  nextCursor: z.string().nullable(),
  scannedRows: z.number().int().min(0).max(KNOWLEDGE_BROWSE_PAGE_SIZE),
  /**
   * Exact number of entries matching the window's filters (domains, entry
   * types, source types) at `revision`. With `search`, it is the candidate set
   * the search walks; body matches are found per window, never pre-counted.
   */
  total: z.number().int().min(0),
});
export type KnowledgeBrowsePage = z.infer<typeof KnowledgeBrowsePageSchema>;
export const KnowledgeOverviewPageSchema = KnowledgeBrowsePageSchema;
export type KnowledgeOverviewPage = z.infer<typeof KnowledgeOverviewPageSchema>;

/** One entry in the whole-corpus graph projection (never `content`). */
export const KnowledgeGraphNodeSchema = z.object({
  id: z.string(),
  domain: z.string(),
  title: z.string(),
  entryType: z.string(),
  confidencePct: z.number().int().nullable(),
  sourceType: z.string(),
});
/** One citation between two entries in the graph projection. */
export const KnowledgeGraphEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  citationType: z.string(),
});
/**
 * The whole knowledge graph at one store revision: every entry (projected) and
 * every citation whose endpoints are both entries. Served once per revision;
 * `revision` is the HTTP ETag, so an unchanged graph revalidates with a 304.
 */
export const KnowledgeGraphResponseSchema = z.object({
  revision: z.string().min(1).max(200),
  nodes: z.array(KnowledgeGraphNodeSchema),
  edges: z.array(KnowledgeGraphEdgeSchema),
  domains: z.array(z.string()),
});
export type KnowledgeGraphResponse = z.infer<
  typeof KnowledgeGraphResponseSchema
>;

/**
 * Declared graph payload budget (task.0059): raw JSON bytes per projected node
 * and per edge, and the whole-response size above which a node should serve a
 * level-of-detail graph instead of one payload. The read handler logs
 * `budgetExceeded` against these on every 200.
 */
export const KNOWLEDGE_GRAPH_NODE_BYTES_BUDGET = 200;
/** Fixed allowance for the response envelope: revision and the domain list. */
export const KNOWLEDGE_GRAPH_ENVELOPE_BYTES_BUDGET = 16 * 1024;
export const KNOWLEDGE_GRAPH_EDGE_BYTES_BUDGET = 110;
export const KNOWLEDGE_GRAPH_RESPONSE_BYTES_BUDGET = 8 * 1024 * 1024;
