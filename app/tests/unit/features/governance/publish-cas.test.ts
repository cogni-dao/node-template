// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/governance/publish-cas`
 * Purpose: Prove the client encodes CAS V2 permission probes and rejects legacy/unscoped grants.
 * Scope: Pure calldata/classification tests; no wallet, RPC, or chain.
 * Invariants: EXPECTED_ROOT_IS_CALL_ID, ZERO_FAILURE_MAP, LEGACY_FAILS_CLOSED.
 * Side-effects: none
 * @public
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import {
  buildPublishProbeData,
  classifyPublishPermission,
} from "@/features/governance/lib/distribution-publish-cas";
import { DAO_ABI } from "@/features/governance/lib/proposal-abis";

const TOKEN = "0x1111111111111111111111111111111111111111";
const DISTRIBUTOR = "0x2222222222222222222222222222222222222222";
const EXPECTED_ROOT =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONDITION_DIR = new URL(
  "../../../../../packages/cogni-contracts/src/distribution-publish-condition/",
  import.meta.url
);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("publish CAS V2 probes", () => {
  it("encodes the expected previous root as callId with zero allowFailureMap", () => {
    const data = buildPublishProbeData(TOKEN, DISTRIBUTOR, EXPECTED_ROOT, 0n);
    const decoded = decodeFunctionData({ abi: DAO_ABI, data });

    expect(decoded.functionName).toBe("execute");
    expect(decoded.args?.[0]).toBe(EXPECTED_ROOT);
    expect(decoded.args?.[2]).toBe(0n);
  });

  it("builds the negative allowFailureMap probe that distinguishes legacy authority", () => {
    const data = buildPublishProbeData(TOKEN, DISTRIBUTOR, EXPECTED_ROOT, 1n);
    const decoded = decodeFunctionData({ abi: DAO_ABI, data });

    expect(decoded.args?.[0]).toBe(EXPECTED_ROOT);
    expect(decoded.args?.[2]).toBe(1n);
    expect(classifyPublishPermission(true, false)).toBe("cas_v2");
    expect(classifyPublishPermission(true, true)).toBe("legacy_or_unscoped");
    expect(classifyPublishPermission(false, false)).toBe("none");
  });
});

describe("publish CAS V2 artifact integrity", () => {
  it("pins the audited Solidity source and its compiled creation bytecode", () => {
    const source = readFileSync(
      fileURLToPath(new URL("DistributionPublishCondition.sol", CONDITION_DIR)),
      "utf8"
    );
    const bytecodeModule = readFileSync(
      fileURLToPath(new URL("bytecode.ts", CONDITION_DIR)),
      "utf8"
    );
    const bytecode = bytecodeModule.match(/"(0x[0-9a-f]+)" as const;/)?.[1];

    expect(bytecode).toBeDefined();
    expect(sha256(source)).toBe(
      "33142129ffe9d6b4010180e13195ce5b0135234ce3d16c4699183216b9802229"
    );
    expect(sha256(bytecode!)).toBe(
      "4dba8e4e069b6ffd23c294ad59e658f6dece4b3504ac1af53d9a76d500334762"
    );
  });
});
