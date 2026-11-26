// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `tests/unit/bootstrap/org-identity`
 * Purpose: the org statement's version comes from the build's commit time; a malformed or future value must not become the version (a future one would pin every reader's floor above all honest builds).
 * Scope: pure; the repo-spec readers are never called (facts are lazy).
 * Side-effects: none
 * @internal
 */

import { describe, expect, it } from "vitest";
import { buildOrgIdentity } from "@/bootstrap/org-identity";

const base = { APP_BASE_URL: "https://node.example.com", APP_BUILD_SHA: "abcdef1" };

describe("buildOrgIdentity version", () => {
  it("uses the build commit time as the statement version", () => {
    expect(buildOrgIdentity({ ...base, APP_BUILD_COMMIT_TIME: "1790000000" })?.version).toBe(1_790_000_000);
  });

  it("leaves the version unset (the node then signs no statement) when the build time is missing, malformed or in the future", () => {
    expect(buildOrgIdentity(base)?.version).toBeUndefined();
    expect(buildOrgIdentity({ ...base, APP_BUILD_COMMIT_TIME: "" })?.version).toBeUndefined();
    expect(buildOrgIdentity({ ...base, APP_BUILD_COMMIT_TIME: "not-a-time" })?.version).toBeUndefined();
    expect(buildOrgIdentity({ ...base, APP_BUILD_COMMIT_TIME: String(Math.floor(Date.now() / 1000) + 86_400) })?.version).toBeUndefined();
  });
});
