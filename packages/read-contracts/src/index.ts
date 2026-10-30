// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Canonical public knowledge read envelope. Dates on the wire are strings. */
import { z } from "zod";

export const KnowledgeRowSchema = z.object({
  id: z.string(),
  domain: z.string(),
  entityId: z.string().nullable(),
  title: z.string(),
  content: z.string(),
  useWhen: z.string().nullable().optional(),
  entryType: z.string(),
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

export const SubjectRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: z.string() }),
  z.object({ kind: z.literal("agent"), agentId: z.string() }),
  z.object({ kind: z.literal("system"), serviceId: z.string() })
]);

export const ExternalRefSchema = z.object({
  system: z.string(),
  kind: z.string(),
  externalId: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional()
});

const WorkItemScoresDtoSchema = z.record(
  z.string(),
  z.object({ v: z.number(), ev: z.string().optional() })
);

export const WorkItemDtoSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  status: z.string(),
  priority: z.number().optional(),
  rank: z.number().optional(),
  rankScore: z.number().optional(),
  estimate: z.number().optional(),
  scores: WorkItemScoresDtoSchema.optional(),
  summary: z.string().optional(),
  outcome: z.string().optional(),
  projectId: z.string().optional(),
  parentId: z.string().optional(),
  node: z.string().optional(),
  assignees: z.array(SubjectRefSchema),
  externalRefs: z.array(ExternalRefSchema),
  actor: z.string().optional(),
  labels: z.array(z.string()),
  specRefs: z.array(z.string()),
  branch: z.string().optional(),
  pr: z.string().optional(),
  reviewer: z.string().optional(),
  revision: z.number(),
  blockedBy: z.string().optional(),
  deployVerified: z.boolean(),
  claimedByRun: z.string().optional(),
  claimedAt: z.string().optional(),
  lastCommand: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type WorkItemDto = z.infer<typeof WorkItemDtoSchema>;
