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

describe("createGithubReadVcsCapability.getPr", () => {
  it("maps a merged PR and calls the unauthenticated pulls endpoint", async () => {
    const f = fakeFetch(MERGED_PR);
    const vcs = createGithubReadVcsCapability(f as unknown as typeof fetch);
    const pr = await vcs.getPr({
      owner: "Cogni-DAO",
      repo: "node-template",
      prNumber: 7,
    });
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
    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://api.github.com/repos/Cogni-DAO/node-template/pulls/7"
    );
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("maps an open PR and drops GitHub's test-merge SHA", async () => {
    const f = fakeFetch({
      ...MERGED_PR,
      state: "open",
      merged: false,
      merged_at: null,
      merge_commit_sha: "t".repeat(40),
    });
    const vcs = createGithubReadVcsCapability(f as unknown as typeof fetch);
    const pr = await vcs.getPr({ owner: "o", repo: "r", prNumber: 7 });
    expect(pr).toMatchObject({
      state: "open",
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
    });
  });

  it("throws with the status code on 404", async () => {
    const vcs = createGithubReadVcsCapability(
      fakeFetch({ message: "Not Found" }, 404) as unknown as typeof fetch
    );
    await expect(
      vcs.getPr({ owner: "o", repo: "r", prNumber: 999 })
    ).rejects.toThrow("404");
  });

  it("throws with the status code on 403 rate limit", async () => {
    const vcs = createGithubReadVcsCapability(
      fakeFetch({ message: "rate limit exceeded" }, 403) as unknown as typeof fetch
    );
    await expect(
      vcs.getPr({ owner: "o", repo: "r", prNumber: 1 })
    ).rejects.toThrow("403");
  });
});

describe("createGithubReadVcsCapability.compareCommits", () => {
  const cases = [
    { status: "ahead", contains: true },
    { status: "identical", contains: true },
    { status: "behind", contains: false },
    { status: "diverged", contains: false },
  ] as const;

  for (const c of cases) {
    it(`maps ${c.status} to contains=${c.contains}`, async () => {
      const f = fakeFetch({ status: c.status });
      const vcs = createGithubReadVcsCapability(f as unknown as typeof fetch);
      const out = await vcs.compareCommits({
        owner: "Cogni-DAO",
        repo: "node-template",
        base: "aaa",
        head: "bbb",
      });
      expect(out).toEqual({ status: c.status, contains: c.contains });
      expect(f.mock.calls[0]?.[0]).toBe(
        "https://api.github.com/repos/Cogni-DAO/node-template/compare/aaa...bbb"
      );
    });
  }

  it("throws with the status code on 404", async () => {
    const vcs = createGithubReadVcsCapability(
      fakeFetch({ message: "Not Found" }, 404) as unknown as typeof fetch
    );
    await expect(
      vcs.compareCommits({ owner: "o", repo: "r", base: "a", head: "b" })
    ).rejects.toThrow("404");
  });

  it("throws with the status code on 403", async () => {
    const vcs = createGithubReadVcsCapability(
      fakeFetch({ message: "rate limit" }, 403) as unknown as typeof fetch
    );
    await expect(
      vcs.compareCommits({ owner: "o", repo: "r", base: "a", head: "b" })
    ).rejects.toThrow("403");
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
