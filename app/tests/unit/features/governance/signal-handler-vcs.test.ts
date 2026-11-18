// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/governance/signal-handler-vcs`
 * Purpose: A VCS signal on a node with no GitHub App answers a typed vcs_unavailable at warn; it must not throw into the RPC-error path.
 * Scope: handleSignal with a fake RPC client. No network.
 * Side-effects: none
 * Links: src/features/governance/services/signal-handler.ts
 * @public
 */

import type { Logger } from "pino";
import { type Address, encodeAbiParameters, encodeEventTopics, type Hex, type PublicClient, zeroAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleSignal, resetTxDedup } from "@/features/governance/services/signal-handler";
import { cogniActionAbi } from "@/features/governance/signal-parser";

const DAO = "0x00000000000000000000000000000000000000d0" as Address;
const SIGNAL = "0x00000000000000000000000000000000000000a1" as Address;

function mergeLog(): { address: Address; topics: Hex[]; data: Hex } {
  const topics = encodeEventTopics({
    abi: cogniActionAbi,
    eventName: "CogniAction",
    args: { dao: DAO, chainId: 8453n, executor: zeroAddress },
  }) as Hex[];
  const extra = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint64" }, { type: "string" }],
    [1n, 0n, "{}"]
  );
  const data = encodeAbiParameters(
    [{ type: "string" }, { type: "string" }, { type: "string" }, { type: "string" }, { type: "string" }, { type: "bytes" }],
    ["github", "https://github.com/cogni-dao/node-template", "merge", "change", "12", extra]
  );
  return { address: SIGNAL, topics, data };
}

describe("signal-handler without a GitHub App", () => {
  afterEach(() => resetTxDedup());

  it("returns vcs_unavailable at warn and never reaches the RPC-error path", async () => {
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => log } as unknown as Logger;
    const rpcClient = {
      getTransactionReceipt: async () => ({ status: "success", logs: [mergeLog()] }),
    } as unknown as PublicClient;
    const result = await handleSignal("0xtx", {
      rpcClient,
      daoConfig: { signal_contract: SIGNAL, dao_contract: DAO, chain_id: "8453" },
      log,
    });
    expect(result).toMatchObject({ success: false, action: "vcs_unavailable" });
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });
});
