// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/vcs-read-capability`
 * Purpose: Prove the node VCS read capability maps GitHub REST responses to PR facts and commit containment, and throws on non-2xx.
 * Scope: Unit — mocked fetch; no network.
 * Invariants: NO_NEW_SECRETS (no Authorization header), HTTP_ERRORS_THROW, writes stay stubs.
 * Side-effects: none
 * Links: src/bootstrap/capabilities/vcs.ts, story.0035
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import { createGithubReadVcsCapability } from "@/bootstrap/capabilities/vcs";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    jsonResponse(body, status)
  );
}

const MERGED_PR = {
  number: 7,
  title: "feat: x",
  html_url: "https://github.com/Cogni-DAO/node-template/pull/7",
  state: "closed",
  merged: true,
  merged_at: "2026-11-01T10:00:00Z",
  merge_commit_sha: "m".repeat(40),
  head: { sha: "h".repeat(40) },
  base: { ref: "main" },
};

/** Routes by URL path; the first matching key wins. Unmatched paths are 404. */
function routes(table: [RegExp, unknown, number?][]) {
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const path = String(url).replace("https://api.github.com", "");
    const hit = table.find(([re]) => re.test(path));
    return hit ? jsonResponse(hit[1], hit[2] ?? 200) : jsonResponse({ message: "Not Found" }, 404);
  });
}
const CLOSED_LIST = /\/pulls\?state=closed/;
const LISTED_PR = { ...MERGED_PR, merged: undefined };

describe("createGithubReadVcsCapability.getPr", () => {
  it("answers from one closed-PR list, unauthenticated, and reuses it", async () => {
    const f = routes([[CLOSED_LIST, [LISTED_PR]]]);
    const vcs = createGithubReadVcsCapability(f as unknown as typeof fetch);
    const pr = await vcs.getPr({ owner: "Cogni-DAO", repo: "node-template", prNumber: 7 });
    expect(pr).toEqual({
      number: 7,
      title: "feat: x",
      url: "https://github.com/Cogni-DAO/node-template/pull/7",
      state: "closed",
      merged: true,
      mergedAt: "2026-11-01T10:00:00Z",
      mergeCommitSha: "m".repeat(40),
      headSha: "h".repeat(40),
      baseBranch: "main",
    });
    await vcs.getPr({ owner: "Cogni-DAO", repo: "node-template", prNumber: 7 });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "https://api.github.com/repos/Cogni-DAO/node-template/pulls?state=closed&sort=updated&direction=desc&per_page=100"
    );
    expect(((init?.headers ?? {}) as Record<string, string>).Authorization).toBeUndefined();
  });

  it("refreshes the closed-PR list after 10 minutes", async () => {
    let t = 0;
    const f = routes([[CLOSED_LIST, [LISTED_PR]]]);
    const vcs = createGithubReadVcsCapability(f as unknown as typeof fetch, () => t);
    await vcs.getPr({ owner: "o", repo: "r", prNumber: 7 });
    t = 10 * 60_000 + 1;
    await vcs.getPr({ owner: "o", repo: "r", prNumber: 7 });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("reads an unlisted (open) PR on its own and drops GitHub's test-merge SHA", async () => {
    const f = routes([
      [CLOSED_LIST, []],
      [/\/pulls\/7$/, { ...MERGED_PR, state: "open", merged: false, merged_at: null, merge_commit_sha: "t".repeat(40) }],
    ]);
    const vcs = createGithubReadVcsCapability(f as unknown as typeof fetch);
    const pr = await vcs.getPr({ owner: "o", repo: "r", prNumber: 7 });
    expect(pr).toMatchObject({ state: "open", merged: false, mergedAt: null, mergeCommitSha: null });
  });

  it("throws with the status code on 404 and on 403 rate limit", async () => {
    const missing = createGithubReadVcsCapability(routes([[CLOSED_LIST, []]]) as unknown as typeof fetch);
    await expect(missing.getPr({ owner: "o", repo: "r", prNumber: 999 })).rejects.toThrow("404");
    const limited = createGithubReadVcsCapability(
      routes([[/./, { message: "rate limit exceeded" }, 403]]) as unknown as typeof fetch
    );
    await expect(limited.getPr({ owner: "o", repo: "r", prNumber: 1 })).rejects.toThrow("403");
  });
});

describe("createGithubReadVcsCapability.compareCommits", () => {
  const COMMITS = /\/commits\?sha=/;

  it("finds a recent merge in one lineage read of the head and reuses it", async () => {
    const f = routes([[COMMITS, [{ sha: "BBB" }, { sha: "AAA" }]]]);
    const vcs = createGithubReadVcsCapability(f as unknown as typeof fetch);
    const ref = { owner: "o", repo: "r", head: "bbb" };
    expect(await vcs.compareCommits({ ...ref, base: "aaa" })).toEqual({ status: "ahead", contains: true });
    expect(await vcs.compareCommits({ ...ref, base: "AAA" })).toEqual({ status: "ahead", contains: true });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("is identical without a request when base equals head", async () => {
    const f = routes([]);
    const vcs = createGithubReadVcsCapability(f as unknown as typeof fetch);
    expect(await vcs.compareCommits({ owner: "o", repo: "r", base: "abc", head: "ABC" })).toEqual({
      status: "identical",
      contains: true,
    });
    expect(f).not.toHaveBeenCalled();
  });

  const cases = [
    { status: "ahead", contains: true },
    { status: "behind", contains: false },
    { status: "diverged", contains: false },
  ] as const;
  for (const c of cases) {
    it(`falls back to compare for an older commit: ${c.status} → contains=${c.contains}`, async () => {
      const f = routes([[COMMITS, [{ sha: "bbb" }]], [/\/compare\//, { status: c.status }]]);
      const vcs = createGithubReadVcsCapability(f as unknown as typeof fetch);
      const out = await vcs.compareCommits({ owner: "Cogni-DAO", repo: "node-template", base: "aaa", head: "bbb" });
      expect(out).toEqual({ status: c.status, contains: c.contains });
      expect(String(f.mock.calls[1]?.[0])).toBe(
        "https://api.github.com/repos/Cogni-DAO/node-template/compare/aaa...bbb"
      );
    });
  }

  it("throws with the status code on 403", async () => {
    const vcs = createGithubReadVcsCapability(
      routes([[/./, { message: "rate limit" }, 403]]) as unknown as typeof fetch
    );
    await expect(vcs.compareCommits({ owner: "o", repo: "r", base: "a", head: "b" })).rejects.toThrow("403");
  });
});

describe("createGithubReadVcsCapability writes", () => {
  it("keeps write methods as not-configured stubs", async () => {
    const f = fakeFetch({});
    const vcs = createGithubReadVcsCapability(f as unknown as typeof fetch);
    await expect(
      vcs.mergePr({ owner: "o", repo: "r", prNumber: 1, method: "squash" })
    ).rejects.toThrow("not configured");
    await expect(
      vcs.createBranch({ owner: "o", repo: "r", branch: "b", fromRef: "main" })
    ).rejects.toThrow("not configured");
    await expect(
      vcs.dispatchCandidateFlight({ owner: "o", repo: "r", prNumber: 1 })
    ).rejects.toThrow("not configured");
    expect(f).not.toHaveBeenCalled();
  });
});
