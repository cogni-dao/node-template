// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Closeout receipts: the item reads of the shared RunReceipts, plus the pull request and live-build facts that
 * the authorized ToolRunner returned in this run. A failed read records nothing.
 */
import { z } from "zod";
import { RunReceipts } from "../work-prioritizer/receipts";

export const VCS_PR_READ = "core__vcs_pr_read";
export const VCS_COMMIT_CONTAINS = "core__vcs_commit_contains";

const PrArgs = z.object({
  owner: z.string(),
  repo: z.string(),
  prNumber: z.number().int(),
});
const Pr = z.object({
  number: z.number().int(),
  merged: z.boolean(),
  mergeCommitSha: z.string().nullable(),
});
const ContainsArgs = z.object({
  owner: z.string(),
  repo: z.string(),
  commit: z.string(),
});
const Contains = z.object({
  commit: z.string(),
  refIsRunningBuild: z.boolean(),
  contains: z.boolean(),
});

/** `owner/repo#n`, lowercased: GitHub owner and repository names are case-insensitive. */
export const prKey = (owner: string, repo: string, n: number) =>
  `${owner}/${repo}#${n}`.toLowerCase();
const commitKey = (owner: string, repo: string, commit: string) =>
  `${owner}/${repo}@${commit}`.toLowerCase();

export class CloseoutReceipts extends RunReceipts {
  /** Merged pull requests read this run, by prKey, with their merge commit. */
  readonly mergedPrs = new Map<string, string>();
  /** Merge commits that the running build contains, by owner/repo@sha. */
  readonly liveCommits = new Set<string>();
  readonly closed = new Set<string>();
  refused = 0;
  toolErrors = 0;

  override observe(name: string, args: unknown, value: unknown) {
    super.observe(name, args, value);
    if (name === VCS_PR_READ) {
      const input = PrArgs.safeParse(args);
      const output = Pr.safeParse(value);
      if (
        input.success &&
        output.success &&
        output.data.number === input.data.prNumber &&
        output.data.merged &&
        output.data.mergeCommitSha
      )
        this.mergedPrs.set(
          prKey(input.data.owner, input.data.repo, input.data.prNumber),
          output.data.mergeCommitSha.toLowerCase(),
        );
    }
    if (name === VCS_COMMIT_CONTAINS) {
      const input = ContainsArgs.safeParse(args);
      const output = Contains.safeParse(value);
      if (
        input.success &&
        output.success &&
        output.data.refIsRunningBuild &&
        output.data.contains &&
        output.data.commit.toLowerCase() === input.data.commit.toLowerCase()
      )
        this.liveCommits.add(
          commitKey(input.data.owner, input.data.repo, input.data.commit),
        );
    }
  }

  /** True when this run saw the pull request merged and its merge commit inside the running build. */
  isLive(owner: string, repo: string, n: number): boolean {
    const sha = this.mergedPrs.get(prKey(owner, repo, n));
    return sha !== undefined && this.liveCommits.has(commitKey(owner, repo, sha));
  }
}
