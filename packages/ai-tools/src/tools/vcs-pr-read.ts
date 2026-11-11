// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/vcs-pr-read`
 * Purpose: AI tool that reads the facts of one pull request (state, merged, merge commit, head SHA).
 * Scope: Read-only PR facts. Does not mutate PRs or import LangChain.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__vcs_pr_read`
 *   - EFFECT_TYPED: effect is `read_only`
 * Side-effects: IO (reads one PR via VcsCapability)
 * Links: story.0035
 * @public
 */

import { z } from "zod";

import type { VcsCapability } from "../capabilities/vcs";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const VcsPrReadInputSchema = z.object({
  owner: z.string().min(1).describe("Repository owner (e.g., 'Cogni-DAO')"),
  repo: z.string().min(1).describe("Repository name (e.g., 'node-template')"),
  prNumber: z.number().int().min(1).describe("Pull request number"),
});
export type VcsPrReadInput = z.infer<typeof VcsPrReadInputSchema>;

export const VcsPrReadOutputSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  mergedAt: z.string().nullable(),
  mergeCommitSha: z.string().nullable(),
  headSha: z.string(),
  baseBranch: z.string(),
});
export type VcsPrReadOutput = z.infer<typeof VcsPrReadOutputSchema>;

export type VcsPrReadRedacted = VcsPrReadOutput;

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

export const VCS_PR_READ_NAME = "core__vcs_pr_read" as const;

export const vcsPrReadContract: ToolContract<
  typeof VCS_PR_READ_NAME,
  VcsPrReadInput,
  VcsPrReadOutput,
  VcsPrReadRedacted
> = {
  name: VCS_PR_READ_NAME,
  description:
    "Read the facts of one pull request in a public GitHub repository: " +
    "title, url, open/closed state, whether it merged, when it merged, " +
    "the merge commit SHA, the head SHA and the base branch. " +
    "Use the merge commit SHA with core__vcs_commit_contains to learn whether " +
    "a merged change is live.",
  effect: "read_only",
  inputSchema: VcsPrReadInputSchema,
  outputSchema: VcsPrReadOutputSchema,
  redact: (output: VcsPrReadOutput): VcsPrReadRedacted => output,
  allowlist: [
    "number",
    "title",
    "url",
    "state",
    "merged",
    "mergedAt",
    "mergeCommitSha",
    "headSha",
    "baseBranch",
  ] as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export interface VcsPrReadDeps {
  readonly vcsCapability: VcsCapability;
}

export function createVcsPrReadImplementation(
  deps: VcsPrReadDeps
): ToolImplementation<VcsPrReadInput, VcsPrReadOutput> {
  return {
    execute: async (input: VcsPrReadInput): Promise<VcsPrReadOutput> => {
      const result = await deps.vcsCapability.getPr({
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber,
      });
      return result as VcsPrReadOutput;
    },
  };
}

export const vcsPrReadStubImplementation: ToolImplementation<
  VcsPrReadInput,
  VcsPrReadOutput
> = {
  execute: async (): Promise<VcsPrReadOutput> => {
    throw new Error("VcsCapability not configured.");
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Bound Tool
// ─────────────────────────────────────────────────────────────────────────────

export const vcsPrReadBoundTool: BoundTool<
  typeof VCS_PR_READ_NAME,
  VcsPrReadInput,
  VcsPrReadOutput,
  VcsPrReadRedacted
> = {
  contract: vcsPrReadContract,
  implementation: vcsPrReadStubImplementation,
};
