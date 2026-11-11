// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/vcs-read`
 * Purpose: Unit tests for core__vcs_pr_read and core__vcs_commit_contains contracts + implementations.
 * Scope: Contract shape, schema validation, and delegation against a fake VcsCapability; does not make network calls.
 * Invariants: BUILD_SHA_INJECTED — default ref comes from deps, never from ambient state.
 * Side-effects: none
 * Links: src/tools/vcs-pr-read.ts, src/tools/vcs-commit-contains.ts
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import type {
  CommitCompareResult,
  PrFacts,
  VcsCapability,
} from "../src/capabilities/vcs";
import { CORE_TOOL_BUNDLE } from "../src/catalog";
import {
  createVcsCommitContainsImplementation,
  VCS_COMMIT_CONTAINS_NAME,
  VcsCommitContainsInputSchema,
  VcsCommitContainsOutputSchema,
  vcsCommitContainsBoundTool,
  vcsCommitContainsContract,
} from "../src/tools/vcs-commit-contains";
import {
  createVcsPrReadImplementation,
  VCS_PR_READ_NAME,
  VcsPrReadInputSchema,
  VcsPrReadOutputSchema,
  vcsPrReadBoundTool,
  vcsPrReadContract,
} from "../src/tools/vcs-pr-read";

const PR: PrFacts = {
  number: 42,
  title: "feat: a thing",
  url: "https://github.com/Cogni-DAO/node-template/pull/42",
  state: "closed",
  merged: true,
  mergedAt: "2026-11-01T10:00:00Z",
  mergeCommitSha: "a".repeat(40),
  headSha: "b".repeat(40),
  baseBranch: "main",
};

function makeVcs(overrides: Partial<VcsCapability> = {}): VcsCapability {
  const unused = async () => {
    throw new Error("not used");
  };
  return {
    listPrs: unused,
    getCiStatus: unused,
    getPr: async () => PR,
    compareCommits: async () => ({ status: "ahead", contains: true }),
    mergePr: unused,
    createBranch: unused,
    dispatchCandidateFlight: unused,
    ...overrides,
  };
}

describe("vcs_pr_read", () => {
  it("has namespaced id, read_only effect and is in the core bundle", () => {
    expect(vcsPrReadContract.name).toBe("core__vcs_pr_read");
    expect(VCS_PR_READ_NAME).toBe("core__vcs_pr_read");
    expect(vcsPrReadContract.effect).toBe("read_only");
    expect(CORE_TOOL_BUNDLE.map((t) => t.contract.name)).toContain(
      VCS_PR_READ_NAME
    );
  });

  it("validates input", () => {
    expect(
      VcsPrReadInputSchema.safeParse({ owner: "o", repo: "r", prNumber: 1 })
        .success
    ).toBe(true);
    expect(
      VcsPrReadInputSchema.safeParse({ owner: "o", repo: "r", prNumber: 0 })
        .success
    ).toBe(false);
    expect(
      VcsPrReadInputSchema.safeParse({ owner: "", repo: "r", prNumber: 1 })
        .success
    ).toBe(false);
  });

  it("allowlist matches the output schema keys", () => {
    expect([...vcsPrReadContract.allowlist].sort()).toEqual(
      Object.keys(VcsPrReadOutputSchema.shape).sort()
    );
  });

  it("delegates to getPr and returns a schema-valid result", async () => {
    const getPr = vi.fn(async () => PR);
    const impl = createVcsPrReadImplementation({
      vcsCapability: makeVcs({ getPr }),
    });
    const out = await impl.execute({
      owner: "Cogni-DAO",
      repo: "node-template",
      prNumber: 42,
    });
    expect(getPr).toHaveBeenCalledWith({
      owner: "Cogni-DAO",
      repo: "node-template",
      prNumber: 42,
    });
    expect(out).toEqual(PR);
    expect(VcsPrReadOutputSchema.safeParse(out).success).toBe(true);
  });

  it("surfaces capability errors", async () => {
    const impl = createVcsPrReadImplementation({
      vcsCapability: makeVcs({
        getPr: async () => {
          throw new Error("GitHub API 404 for GET /repos/o/r/pulls/9");
        },
      }),
    });
    await expect(
      impl.execute({ owner: "o", repo: "r", prNumber: 9 })
    ).rejects.toThrow("404");
  });

  it("bound tool ships the stub implementation", async () => {
    await expect(
      vcsPrReadBoundTool.implementation.execute({
        owner: "o",
        repo: "r",
        prNumber: 1,
      })
    ).rejects.toThrow("not configured");
  });
});

describe("vcs_commit_contains", () => {
  const RUNNING = "c".repeat(40);

  it("has namespaced id, read_only effect and is in the core bundle", () => {
    expect(vcsCommitContainsContract.name).toBe("core__vcs_commit_contains");
    expect(VCS_COMMIT_CONTAINS_NAME).toBe("core__vcs_commit_contains");
    expect(vcsCommitContainsContract.effect).toBe("read_only");
    expect(CORE_TOOL_BUNDLE.map((t) => t.contract.name)).toContain(
      VCS_COMMIT_CONTAINS_NAME
    );
  });

  it("makes ref optional and allowlist matches the output schema keys", () => {
    expect(
      VcsCommitContainsInputSchema.safeParse({
        owner: "o",
        repo: "r",
        commit: "abc",
      }).success
    ).toBe(true);
    expect([...vcsCommitContainsContract.allowlist].sort()).toEqual(
      Object.keys(VcsCommitContainsOutputSchema.shape).sort()
    );
  });

  it("defaults ref to the injected running build SHA", async () => {
    const compareCommits = vi.fn(
      async (): Promise<CommitCompareResult> => ({
        status: "ahead",
        contains: true,
      })
    );
    const impl = createVcsCommitContainsImplementation({
      vcsCapability: makeVcs({ compareCommits }),
      runningBuildSha: RUNNING,
    });
    const out = await impl.execute({
      owner: "o",
      repo: "r",
      commit: "a".repeat(40),
    });
    expect(compareCommits).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      base: "a".repeat(40),
      head: RUNNING,
    });
    expect(out).toEqual({
      commit: "a".repeat(40),
      ref: RUNNING,
      refIsRunningBuild: true,
      contains: true,
      status: "ahead",
    });
    expect(VcsCommitContainsOutputSchema.safeParse(out).success).toBe(true);
  });

  it("uses an explicit ref and reports refIsRunningBuild false", async () => {
    const impl = createVcsCommitContainsImplementation({
      vcsCapability: makeVcs({
        compareCommits: async () => ({ status: "behind", contains: false }),
      }),
      runningBuildSha: RUNNING,
    });
    const out = await impl.execute({
      owner: "o",
      repo: "r",
      commit: "a".repeat(40),
      ref: "main",
    });
    expect(out).toMatchObject({
      ref: "main",
      refIsRunningBuild: false,
      contains: false,
      status: "behind",
    });
  });

  it("reports refIsRunningBuild true when the explicit ref is the running SHA", async () => {
    const impl = createVcsCommitContainsImplementation({
      vcsCapability: makeVcs(),
      runningBuildSha: RUNNING,
    });
    const out = await impl.execute({
      owner: "o",
      repo: "r",
      commit: "a".repeat(40),
      ref: RUNNING.toUpperCase(),
    });
    expect(out.refIsRunningBuild).toBe(true);
  });

  it("throws when ref is omitted and the running build SHA is unknown", async () => {
    const impl = createVcsCommitContainsImplementation({
      vcsCapability: makeVcs(),
      runningBuildSha: undefined,
    });
    await expect(
      impl.execute({ owner: "o", repo: "r", commit: "abc" })
    ).rejects.toThrow("APP_BUILD_SHA");
  });

  it("bound tool ships the stub implementation", async () => {
    await expect(
      vcsCommitContainsBoundTool.implementation.execute({
        owner: "o",
        repo: "r",
        commit: "abc",
      })
    ).rejects.toThrow("not configured");
  });
});
