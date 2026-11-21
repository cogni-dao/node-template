// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/ai/inproc-completion-unit.cost.spec`
 * Purpose: The usage fact carries the cost the adapter reported, and a platform run with no cost stays unknown.
 * Scope: usage_report costUsd only. Does NOT test streaming or billing writes.
 * Invariants: COST_AUTHORITY_IS_LITELLM (a platform run never defaults its cost to 0; bug.0067), BYO_ZERO_PLATFORM_COST
 * Side-effects: none
 * Links: inproc-completion-unit.adapter.ts, app/src/features/ai/services/billing.ts
 * @internal
 */

import type { SourceSystem } from "@cogni/ai-core";
import type { AiEvent } from "@cogni/node-core";
import { describe, expect, it } from "vitest";
import { runInScope } from "@/adapters/server/ai/execution-scope";
import { InProcCompletionUnitAdapter } from "@/adapters/server/ai/inproc-completion-unit.adapter";
import type { ChatDeltaEvent } from "@/ports";

async function usageCost(
  usageSource: SourceSystem,
  providerCostUsd: number | undefined
): Promise<{ hasCost: boolean; costUsd: number | undefined }> {
  async function* stream(): AsyncGenerator<ChatDeltaEvent> {
    yield { type: "done" };
  }
  const final = Promise.resolve({
    ok: true as const,
    requestId: "req-1",
    content: "",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    finishReason: "stop" as const,
    litellmCallId: "call-1",
    ...(providerCostUsd !== undefined && { providerCostUsd }),
    model: "test-model",
  });
  return runInScope(
    {
      billing: { billingAccountId: "billing-1", virtualKeyId: "vk-1" },
      usageSource,
    },
    async () => {
      const adapter = new InProcCompletionUnitAdapter(
        {
          llmService: {} as never,
          accountService: {} as never,
          clock: {} as never,
          aiTelemetry: {} as never,
          langfuse: undefined,
        },
        async () => ({ stream: stream(), final })
      );
      const result = adapter.executeCompletionUnit({
        messages: [{ role: "user", content: "test" }],
        model: "test-model",
        runContext: {
          runId: "run-1",
          attempt: 0,
          graphId: "langgraph:test" as import("@cogni/ai-core").GraphId,
        },
      });
      const events: AiEvent[] = [];
      for await (const event of result.stream) events.push(event);
      const usage = events.find((e) => e.type === "usage_report");
      if (usage?.type !== "usage_report") throw new Error("no usage_report");
      return { hasCost: "costUsd" in usage.fact, costUsd: usage.fact.costUsd };
    }
  );
}

describe("InProcCompletionUnitAdapter usage cost", () => {
  it("a platform run with no reported cost leaves cost unknown, so billing waits for the LiteLLM callback (bug.0067)", async () => {
    expect(await usageCost("litellm", undefined)).toEqual({
      hasCost: false,
      costUsd: undefined,
    });
  });

  it("a platform run carries the reported cost", async () => {
    expect(await usageCost("litellm", 0.0042)).toEqual({
      hasCost: true,
      costUsd: 0.0042,
    });
  });

  it("a BYO run with no reported cost costs the platform 0", async () => {
    expect(await usageCost("ollama", undefined)).toEqual({
      hasCost: true,
      costUsd: 0,
    });
  });
});
