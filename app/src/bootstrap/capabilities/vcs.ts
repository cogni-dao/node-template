// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/vcs`
 * Purpose: VcsCapability for nodes without GitHub App credentials: real unauthenticated public-repo reads, stubbed writes.
 * Scope: Reads PR facts and commit comparisons over GitHub REST via fetch. Write methods stay stubs.
 * Invariants:
 *   - GRACEFUL_DEGRADATION: Write methods throw on use, not on bind
 *   - NO_NEW_SECRETS: Reads are unauthenticated; the repo is public
 *   - HTTP_ERRORS_THROW: Any non-2xx (403 rate limit, 404, ...) throws an Error carrying the status code
 * Side-effects: IO (GitHub REST reads, only when getPr/compareCommits are called)
 * Links: task.0242, story.0035
 * @internal
 */

import type {
  CommitCompareResult,
  PrFacts,
  VcsCapability,
} from "@cogni/ai-tools";

const GITHUB_API = "https://api.github.com";

type FetchFn = typeof fetch;

async function githubGet(fetchFn: FetchFn, path: string): Promise<unknown> {
  const res = await fetchFn(`${GITHUB_API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "cogni-node",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for GET ${path}`);
  }
  return res.json();
}

interface GithubPullResponse {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { sha: string };
  base: { ref: string };
}

interface GithubCompareResponse {
  status: CommitCompareResult["status"];
}

/**
 * Stub VcsCapability — satisfies tool binding requirement but throws if called.
 * Nodes that need real VCS writes should use the operator's createVcsCapability factory.
 */
export const stubVcsCapability: VcsCapability = {
  listPrs: async () => {
    throw new Error("VcsCapability not configured on this node.");
  },
  getCiStatus: async () => {
    throw new Error("VcsCapability not configured on this node.");
  },
  getPr: async () => {
    throw new Error("VcsCapability not configured on this node.");
  },
  compareCommits: async () => {
    throw new Error("VcsCapability not configured on this node.");
  },
  mergePr: async () => {
    throw new Error("VcsCapability not configured on this node.");
  },
  createBranch: async () => {
    throw new Error("VcsCapability not configured on this node.");
  },
  dispatchCandidateFlight: async () => {
    throw new Error("VcsCapability not configured on this node.");
  },
};

/**
 * VcsCapability with real read methods over unauthenticated GitHub REST.
 * Write methods stay the stubs above.
 */
export function createGithubReadVcsCapability(
  fetchFn: FetchFn = fetch
): VcsCapability {
  return {
    ...stubVcsCapability,

    getPr: async ({ owner, repo, prNumber }): Promise<PrFacts> => {
      const pr = (await githubGet(
        fetchFn,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`
      )) as GithubPullResponse;
      return {
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        state: pr.state,
        merged: pr.merged,
        mergedAt: pr.merged_at,
        // GitHub fills merge_commit_sha with a test-merge SHA on unmerged PRs.
        mergeCommitSha: pr.merged ? pr.merge_commit_sha : null,
        headSha: pr.head.sha,
        baseBranch: pr.base.ref,
      };
    },

    compareCommits: async ({
      owner,
      repo,
      base,
      head,
    }): Promise<CommitCompareResult> => {
      const cmp = (await githubGet(
        fetchFn,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
      )) as GithubCompareResponse;
      return {
        status: cmp.status,
        contains: cmp.status === "ahead" || cmp.status === "identical",
      };
    },
  };
}
