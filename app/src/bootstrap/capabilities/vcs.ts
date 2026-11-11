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
  /** Absent on the list endpoint. */
  merged?: boolean;
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

const CLOSED_PR_TTL_MS = 10 * 60_000;

function toPrFacts(pr: GithubPullResponse): PrFacts {
  // The list endpoint has no `merged` flag; merged_at is set exactly when the PR merged.
  const merged = pr.merged ?? pr.merged_at !== null;
  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    state: pr.state,
    merged,
    mergedAt: pr.merged_at,
    // GitHub fills merge_commit_sha with a test-merge SHA on unmerged PRs.
    mergeCommitSha: merged ? pr.merge_commit_sha : null,
    headSha: pr.head.sha,
    baseBranch: pr.base.ref,
  };
}

/**
 * VcsCapability with real read methods over unauthenticated GitHub REST.
 * Write methods stay the stubs above.
 *
 * Anonymous GitHub allows 60 requests per hour per IP, so reads are batched:
 * - One request lists the last 100 closed PRs. That list answers most PR reads and is reused for 10 minutes.
 * - One request lists the last 100 commits of a ref. The list is reused forever, because a SHA's history never changes.
 * A PR or commit outside those lists falls back to its own request.
 */
export function createGithubReadVcsCapability(
  fetchFn: FetchFn = fetch,
  now: () => number = Date.now
): VcsCapability {
  const repoPath = (owner: string, repo: string) =>
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const closedPrs = new Map<string, { at: number; byNumber: Map<number, GithubPullResponse> }>();
  const lineage = new Map<string, Set<string>>();

  async function recentClosedPr(owner: string, repo: string, n: number) {
    const key = `${owner}/${repo}`.toLowerCase();
    let entry = closedPrs.get(key);
    if (!entry || now() - entry.at > CLOSED_PR_TTL_MS) {
      const list = (await githubGet(
        fetchFn,
        `${repoPath(owner, repo)}/pulls?state=closed&sort=updated&direction=desc&per_page=100`
      )) as GithubPullResponse[];
      entry = { at: now(), byNumber: new Map(list.map((pr) => [pr.number, pr])) };
      closedPrs.set(key, entry);
    }
    return entry.byNumber.get(n);
  }

  async function recentLineage(owner: string, repo: string, head: string) {
    const key = `${owner}/${repo}@${head}`.toLowerCase();
    let shas = lineage.get(key);
    if (!shas) {
      const list = (await githubGet(
        fetchFn,
        `${repoPath(owner, repo)}/commits?sha=${encodeURIComponent(head)}&per_page=100`
      )) as { sha: string }[];
      shas = new Set(list.map((c) => c.sha.toLowerCase()));
      lineage.set(key, shas);
    }
    return shas;
  }

  return {
    ...stubVcsCapability,

    getPr: async ({ owner, repo, prNumber }): Promise<PrFacts> => {
      const listed = await recentClosedPr(owner, repo, prNumber);
      if (listed) return toPrFacts(listed);
      return toPrFacts(
        (await githubGet(
          fetchFn,
          `${repoPath(owner, repo)}/pulls/${prNumber}`
        )) as GithubPullResponse
      );
    },

    compareCommits: async ({
      owner,
      repo,
      base,
      head,
    }): Promise<CommitCompareResult> => {
      if (base.toLowerCase() === head.toLowerCase())
        return { status: "identical", contains: true };
      if ((await recentLineage(owner, repo, head)).has(base.toLowerCase()))
        return { status: "ahead", contains: true };
      const cmp = (await githubGet(
        fetchFn,
        `${repoPath(owner, repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
      )) as GithubCompareResponse;
      return {
        status: cmp.status,
        contains: cmp.status === "ahead" || cmp.status === "identical",
      };
    },
  };
}
