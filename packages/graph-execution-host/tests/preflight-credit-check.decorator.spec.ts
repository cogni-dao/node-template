// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/graph-execution-host/tests/preflight-credit-check.decorator.spec`
 * Purpose: Unit tests for PreflightCreditCheckDecorator credit validation.
 * Scope: Tests credit check pass-through, BYO skip, and insufficient-credits rejection. Does not test actual credit balance queries.
 * Invariants: Tests use in-memory mock checkers only.
 * Side-effects: none
 * Links: src/decorators/preflight-credit-check.decorator.ts
 * @internal
 */

import type { AiEvent } from "@cogni/ai-core";
import type {
  GraphExecutorPort,
  GraphRunRequest
} from "@cogni/graph-execution-core";
import { describe, expect, it, vi } from "vitest";

import { PreflightCreditCheckDecorator } from "../src/decorators/preflight-credit-check.decorator";
import { createMockLogger } from "./_helpers/mock-logger";

function makeRequest(overrides?: Partial<GraphRunRequest>): GraphRunRequest {
  return {
    runId: "run-1",
    graphId: "langgraph:test",
    messages: [{ role: "user", content: "hello" }],
    modelRef: { providerKey: "platform", modelId: "gpt-4o" },
    ...overrides
  };
}

function makeInnerExecutor(events: AiEvent[]): GraphExecutorPort {
  return {
    runGraph: () => ({
      stream: (async function* () {
        for (const e of events) yield e;
      })(),
      final: Promise.resolve({ ok: true, runId: "run-1", requestId: "run-1" })
    })
  };
}

describe("PreflightCreditCheckDecorator", () => {
  it("waits for policy and credit approval before starting one shared run", async () => {
    let approvePolicy!: (value: boolean) => void;
    let approveCredit!: () => void;
    const policy = new Promise<boolean>((resolve) => {
      approvePolicy = resolve;
    });
    const credit = new Promise<void>((resolve) => {
      approveCredit = resolve;
    });
    const checkFn = vi.fn(() => credit);
    const inner = makeInnerExecutor([{ type: "done" }]);
    const run = vi.spyOn(inner, "runGraph");
    const req = makeRequest();
    const ctx = { actorUserId: "actor" };
    const decorator = new PreflightCreditCheckDecorator(
      inner,
      checkFn,
      "ba-1",
      {
        resolve: () => ({ requiresPlatformCredits: () => policy })
      },
      createMockLogger()
    );
    const result = decorator.runGraph(req, ctx);
    const events = (async () => {
      const found: AiEvent[] = [];
      for await (const event of result.stream) found.push(event);
      return found;
    })();
    const final = result.final;
    expect(run).not.toHaveBeenCalled();
    approvePolicy(true);
    await Promise.resolve();
    expect(checkFn).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    approveCredit();
    expect(await events).toEqual([{ type: "done" }]);
    expect((await final).ok).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(req, ctx);
  });

  it.each(["policy", "credit"] as const)(
    "never starts the executor on %s denial, even for stream-only consumption",
    async (denied) => {
      const error = new Error(`${denied} denied`);
      const inner = makeInnerExecutor([{ type: "done" }]);
      const run = vi.spyOn(inner, "runGraph");
      const checkFn = vi.fn().mockRejectedValue(error);
      const decorator = new PreflightCreditCheckDecorator(
        inner,
        checkFn,
        "ba-1",
        {
          resolve: () => ({
            requiresPlatformCredits: () =>
              denied === "policy"
                ? Promise.reject(error)
                : Promise.resolve(true)
          })
        },
        createMockLogger()
      );
      const result = decorator.runGraph(makeRequest());
      await expect(async () => {
        for await (const _event of result.stream) {
          /* drain */
        }
      }).rejects.toBe(error);
      expect(run).not.toHaveBeenCalled();
      if (denied === "policy") expect(checkFn).not.toHaveBeenCalled();
    }
  );

  it("starts exactly once for a final-only consumer", async () => {
    const inner = makeInnerExecutor([{ type: "done" }]);
    const run = vi.spyOn(inner, "runGraph");
    const decorator = new PreflightCreditCheckDecorator(
      inner,
      vi.fn(),
      "ba-1",
      makeChecker(false),
      createMockLogger()
    );
    expect((await decorator.runGraph(makeRequest()).final).ok).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it("propagates stream cancellation to the inner iterator", async () => {
    const close = vi.fn();
    const inner: GraphExecutorPort = {
      runGraph: () => ({
        stream: (async function* () {
          try {
            yield { type: "done" } as AiEvent;
          } finally {
            close();
          }
        })(),
        final: Promise.resolve({
          ok: true,
          runId: "run-1",
          requestId: "run-1"
        })
      })
    };
    const decorator = new PreflightCreditCheckDecorator(
      inner,
      vi.fn(),
      "ba-1",
      makeChecker(false),
      createMockLogger()
    );
    for await (const _event of decorator.runGraph(makeRequest()).stream) break;
    expect(close).toHaveBeenCalledOnce();
  });
  const makeChecker = (requiresCredits: boolean) => ({
    resolve: () => ({
      requiresPlatformCredits: vi.fn().mockResolvedValue(requiresCredits)
    })
  });

  it("passes through when credits are sufficient", async () => {
    const checkFn = vi.fn().mockResolvedValue(undefined);
    const inner = makeInnerExecutor([
      { type: "text_delta", delta: "hi" },
      { type: "done" }
    ]);

    const decorator = new PreflightCreditCheckDecorator(
      inner,
      checkFn,
      "ba-1",
      makeChecker(true),
      createMockLogger()
    );

    const result = decorator.runGraph(makeRequest());
    const events: AiEvent[] = [];
    for await (const e of result.stream) events.push(e);

    expect(events.map((e) => e.type)).toEqual(["text_delta", "done"]);
    expect(checkFn).toHaveBeenCalledWith("ba-1", "gpt-4o", expect.anything());
  });

  it("skips credit check for BYO providers", async () => {
    const checkFn = vi.fn().mockResolvedValue(undefined);
    const inner = makeInnerExecutor([{ type: "done" }]);

    const decorator = new PreflightCreditCheckDecorator(
      inner,
      checkFn,
      "ba-1",
      makeChecker(false),
      createMockLogger()
    );

    const result = decorator.runGraph(
      makeRequest({
        modelRef: { providerKey: "codex", modelId: "codex-mini" }
      })
    );
    const events: AiEvent[] = [];
    for await (const e of result.stream) events.push(e);

    expect(checkFn).not.toHaveBeenCalled();
  });

  it("rejects run when credits insufficient", async () => {
    const checkFn = vi
      .fn()
      .mockRejectedValue(new Error("Insufficient credits"));
    const inner = makeInnerExecutor([{ type: "done" }]);

    const decorator = new PreflightCreditCheckDecorator(
      inner,
      checkFn,
      "ba-1",
      makeChecker(true),
      createMockLogger()
    );

    const result = decorator.runGraph(makeRequest());

    await expect(async () => {
      for await (const _ of result.stream) {
        /* drain */
      }
    }).rejects.toThrow("Insufficient credits");

    // Also catch the final promise to avoid unhandled rejection
    await expect(result.final).rejects.toThrow("Insufficient credits");
  });
});
