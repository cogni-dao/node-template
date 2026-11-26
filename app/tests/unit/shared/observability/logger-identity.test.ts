// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/shared/observability/logger-identity`
 * Purpose: Verifies app log base fields carry buildSha / workload / host from existing env (bug.0040).
 * Scope: Pure unit — injected env for makeIdentityFields; makeLogger bindings read from process.env.
 * Invariants: absent env omits the field; APP_BUILD_SHA wins over COGNI_REPO_SHA; reserved keys stay app/service.
 * Side-effects: none
 * Links: src/shared/observability/server/logger.ts
 * @public
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  makeIdentityFields,
  makeLogger,
} from "@/shared/observability/server/logger";

describe("makeIdentityFields (bug.0040)", () => {
  it("prefers APP_BUILD_SHA and derives host from APP_BASE_URL", () => {
    expect(
      makeIdentityFields({
        APP_BUILD_SHA: "aaa",
        COGNI_REPO_SHA: "bbb",
        COGNI_WORKLOAD: "canary",
        APP_BASE_URL: "https://node-template-canary-test.cognidao.org",
      }),
    ).toEqual({
      buildSha: "aaa",
      workload: "canary",
      host: "node-template-canary-test.cognidao.org",
    });
  });

  it("falls back to COGNI_REPO_SHA and omits absent or invalid values", () => {
    expect(
      makeIdentityFields({ COGNI_REPO_SHA: "bbb", APP_BASE_URL: "not a url" }),
    ).toEqual({ buildSha: "bbb" });
    expect(makeIdentityFields({ APP_BUILD_SHA: "" })).toEqual({});
  });
});

describe("makeLogger base fields (bug.0040)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("stamps buildSha, workload and host on every logger", () => {
    vi.stubEnv("APP_BUILD_SHA", "deadbeef");
    vi.stubEnv("COGNI_WORKLOAD", "canary");
    vi.stubEnv("APP_BASE_URL", "https://node-template-canary-test.cognidao.org");
    const bindings = makeLogger({ component: "x" }).bindings();
    expect(bindings).toMatchObject({
      component: "x",
      app: "cogni-template",
      buildSha: "deadbeef",
      workload: "canary",
      host: "node-template-canary-test.cognidao.org",
    });
  });
});
