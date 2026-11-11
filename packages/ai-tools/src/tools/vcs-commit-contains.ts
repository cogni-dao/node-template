// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/vcs-commit-contains`
 * Purpose: AI tool that answers "does this ref contain that commit", defaulting the ref to the running build SHA.
 * Scope: Read-only commit ancestry check. Does not mutate repos or import LangChain.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__vcs_commit_contains`
 *   - EFFECT_TYPED: effect is `read_only`
 *   - BUILD_SHA_INJECTED: the running build SHA arrives through implementation deps, never ALS
 * Side-effects: IO (compares two commits via VcsCapability)
 * Links: story.0035
 * @public
 */

import { z } from "zod";

import type { VcsCapability } from "../capabilities/vcs";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const VcsCommitContainsInputSchema = z.object({
  owner: z.string().min(1).describe("Repository owner (e.g., 'Cogni-DAO')"),
  repo: z.string().min(1).describe("Repository name (e.g., 'node-template')"),
  commit: z
    .string()
    .min(1)
    .describe("Commit SHA to look for (e.g., a PR's merge commit SHA)"),
  ref: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Ref or SHA that should contain the commit. Omit to use the build SHA of the app running this tool."
    ),
});
export type VcsCommitContainsInput = z.infer<
  typeof VcsCommitContainsInputSchema
>;

export const VcsCommitContainsOutputSchema = z.object({
  commit: z.string(),
  ref: z.string(),
  refIsRunningBuild: z.boolean(),
  contains: z.boolean(),
  status: z.enum(["ahead", "behind", "identical", "diverged"]),
});
export type VcsCommitContainsOutput = z.infer<
  typeof VcsCommitContainsOutputSchema
>;

export type VcsCommitContainsRedacted = VcsCommitContainsOutput;

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

export const VCS_COMMIT_CONTAINS_NAME = "core__vcs_commit_contains" as const;

export const vcsCommitContainsContract: ToolContract<
  typeof VCS_COMMIT_CONTAINS_NAME,
  VcsCommitContainsInput,
  VcsCommitContainsOutput,
  VcsCommitContainsRedacted
> = {
  name: VCS_COMMIT_CONTAINS_NAME,
  description:
    "Check whether a ref contains a commit in a public GitHub repository. " +
    "When ref is omitted it is the build SHA of the app running this tool, " +
    "so omitting it answers 'is this commit live here'. " +
    "Returns the commit, the ref compared, whether that ref is the running build, " +
    "contains (true when the ref has the commit) and the ancestry status " +
    "(ahead, behind, identical or diverged).",
  effect: "read_only",
  inputSchema: VcsCommitContainsInputSchema,
  outputSchema: VcsCommitContainsOutputSchema,
  redact: (output: VcsCommitContainsOutput): VcsCommitContainsRedacted =>
    output,
  allowlist: [
    "commit",
    "ref",
    "refIsRunningBuild",
    "contains",
    "status",
  ] as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export interface VcsCommitContainsDeps {
  readonly vcsCapability: VcsCapability;
  /** Build SHA of the running app (the value its /version route reports). */
  readonly runningBuildSha: string | undefined;
}

export function createVcsCommitContainsImplementation(
  deps: VcsCommitContainsDeps
): ToolImplementation<VcsCommitContainsInput, VcsCommitContainsOutput> {
  return {
    execute: async (
      input: VcsCommitContainsInput
    ): Promise<VcsCommitContainsOutput> => {
      const ref = input.ref ?? deps.runningBuildSha;
      if (!ref) {
        throw new Error(
          "No ref given and the running build SHA is unknown (APP_BUILD_SHA unset)."
        );
      }
      const result = await deps.vcsCapability.compareCommits({
        owner: input.owner,
        repo: input.repo,
        base: input.commit,
        head: ref,
      });
      return {
        commit: input.commit,
        ref,
        refIsRunningBuild:
          deps.runningBuildSha !== undefined &&
          ref.toLowerCase() === deps.runningBuildSha.toLowerCase(),
        contains: result.contains,
        status: result.status,
      };
    },
  };
}

export const vcsCommitContainsStubImplementation: ToolImplementation<
  VcsCommitContainsInput,
  VcsCommitContainsOutput
> = {
  execute: async (): Promise<VcsCommitContainsOutput> => {
    throw new Error("VcsCapability not configured.");
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Bound Tool
// ─────────────────────────────────────────────────────────────────────────────

export const vcsCommitContainsBoundTool: BoundTool<
  typeof VCS_COMMIT_CONTAINS_NAME,
  VcsCommitContainsInput,
  VcsCommitContainsOutput,
  VcsCommitContainsRedacted
> = {
  contract: vcsCommitContainsContract,
  implementation: vcsCommitContainsStubImplementation,
};
