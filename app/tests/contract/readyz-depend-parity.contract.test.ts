// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/readyz-depend-parity.contract`
 * Purpose: Drift guard — the deep-readyz registry must cover every substrate dependency the env schema declares.
 * Scope: Enumerates `serverSchema.shape` keys matching the substrate pattern and asserts each is owned by a `SUBSTRATE_DEPENDENCIES` entry or allowlisted. Does not perform IO.
 * Invariants: A new `*_URL`/`*_ADDRESS` env key added without a readyz decision fails this test.
 * Side-effects: none
 * Links: src/app/(infra)/readyz/readyz-probes.ts, src/shared/env/server-env.ts
 * @internal
 */

import { describe, expect, it } from "vitest";
import {
  findUnclassifiedSubstrateKeys,
  NON_SUBSTRATE_ALLOWLIST,
  SUBSTRATE_DEPENDENCIES,
  SUBSTRATE_ENV_KEY_PATTERN,
} from "@/app/(infra)/readyz/readyz-probes";
import { serverSchema } from "@/shared/env/server-env";

describe("deep readyz ⇄ env-schema parity", () => {
  const schemaKeys = Object.keys(serverSchema.shape);

  it("classifies every substrate env key as a probe, N/A, or allowlisted", () => {
    const unclassified = findUnclassifiedSubstrateKeys(schemaKeys);
    expect(unclassified).toEqual([]);
  });

  it("fails when a new substrate-looking key is wired without a decision", () => {
    expect(
      findUnclassifiedSubstrateKeys([...schemaKeys, "NEW_SERVICE_URL"])
    ).toEqual(["NEW_SERVICE_URL"]);
  });

  it("ignores keys that are not substrate-shaped", () => {
    expect(findUnclassifiedSubstrateKeys(["SOME_FEATURE_FLAG"])).toEqual([]);
  });

  it("does not allowlist a key that a dependency already owns", () => {
    const owned = new Set<string>();
    for (const dep of SUBSTRATE_DEPENDENCIES) {
      for (const key of dep.envKeys) owned.add(key);
    }
    for (const key of NON_SUBSTRATE_ALLOWLIST) {
      expect(owned.has(key)).toBe(false);
      expect(SUBSTRATE_ENV_KEY_PATTERN.test(key)).toBe(true);
    }
  });
});
