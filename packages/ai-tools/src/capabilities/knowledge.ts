// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/capabilities/knowledge`
 * Purpose: Capability interface for knowledge store access. Tools receive this, not raw DB connections.
 * Scope: Interface + confidence defaults only. Does not contain I/O or implementations.
 * Invariants:
 *   - AUTH_VIA_CAPABILITY_INTERFACE: Tools receive knowledge access via this capability, not DSNs.
 *   - CONFIDENCE_DEFAULTS: draft=30, verified=80, hardened=95.
 * Side-effects: none
 * Links: docs/spec/knowledge-data-plane.md
 * @public
 */

import { z } from "zod";

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

/**
 * The ONE knowledge-entry envelope. `KnowledgeEntry` is DERIVED from it, and the
 * read/search tool item schemas are built from it, so a field exists in exactly one
 * place (agent-tool-context-envelope, rule 1). It mirrors the wire DTO
 * (`KnowledgeRowSchema` in @cogni/node-contracts): dates are ISO strings, nullable
 * columns are `null` (never omitted). Packages cannot share a zod instance with
 * node-contracts (zod3 vs zod4), so the repo-wide envelope audit in the app tier
 * (`tool-envelope.conformance.test.ts`) enforces key-set parity with the wire DTO.
 */
export const KnowledgeEntrySchema = z.object({
  id: z.string(),
  domain: z.string(),
  entityId: z.string().nullable(),
  title: z.string(),
  content: z.string(),
  /** Trigger sentence — when to read this entry (the governing index is keyed on it). */
  useWhen: z.string().nullable(),
  entryType: z.string(),
  confidencePct: z.number().nullable(),
  sourceType: z.string(),
  sourceRef: z.string().nullable(),
  tags: z.array(z.string()).nullable(),
  /** ISO timestamp — a hypothesis's resolution date or a goal's `By:` deadline. */
  evaluateAt: z.string().nullable(),
  /** Namespaced resolver id on hypothesis/goal rows (`manual`, `agent`, `metric:<kpi>`). */
  resolutionStrategy: z.string().nullable(),
  /** ISO timestamp. */
  createdAt: z.string().nullable(),
});

export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

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
}
