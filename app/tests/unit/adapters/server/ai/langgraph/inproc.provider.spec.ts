// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/ai/langgraph/inproc.provider`
 * Purpose: Wiring tests for LangGraphInProcProvider - adapter integration and error handling.
 * Scope: Verifies adapter.executeCompletionUnit is called correctly and events reflect adapter stream. Does NOT test actual graph execution or LLM calls.
 * Invariants:
 *   - Valid graphId: events reflect adapter stream
 *   - Invalid graphId: emits client error (not_found), done is last
 * Side-effects: none (all mocked)
 * Links: inproc.provider.ts, GRAPH_EXECUTION.md
 * @internal
 */

import { CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
import type { AiEvent, ToolSourcePort } from "@cogni/ai-core";
import { TOOL_CATALOG, toBoundToolRuntime } from "@cogni/ai-tools";
import { LANGGRAPH_CATALOG } from "@cogni/langgraph-graphs";
import { describe, expect, it, vi } from "vitest";

import { runInScope } from "@/adapters/server/ai/execution-scope";
import type { CompletionUnitAdapter } from "@/adapters/server/ai/langgraph/inproc.provider";
import { LangGraphInProcProvider, resolveNodeSourceContext } from "@/adapters/server/ai/langgraph/inproc.provider";
import type { GraphRunRequest } from "@/ports";
import { EVENT_NAMES } from "@/shared/observability";

const runnerSpy = vi.hoisted(() => vi.fn());
vi.mock("@cogni/langgraph-graphs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cogni/langgraph-graphs")>();
  // A plain harness graph (no program, no principal): the published graphs both carry a program and
  // principal, so provider wiring that needs neither runs on this test-only entry.
  return { ...actual, LANGGRAPH_CATALOG: { ...actual.LANGGRAPH_CATALOG, "test-plain": {
    displayName: "Test plain",
    description: "plain harness graph without program or principal",
    toolIds: [],
    graphFactory: actual.NODE_LANGGRAPH_CATALOG.cogni.graphFactory,
  } }, createInProcGraphRunner: (...args: Parameters<typeof actual.createInProcGraphRunner>) => {
    runnerSpy(args[0]);
    return actual.createInProcGraphRunner(...args);
  } };
});

const TEST_SCOPE = {
  billing: {
    billingAccountId: "test-billing",
    virtualKeyId: "test-vkey",
  },
  usageSource: "litellm" as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collect all events from stream into array.
 */
async function collectEvents(
  stream: AsyncIterable<AiEvent>
): Promise<AiEvent[]> {
  return runInScope(TEST_SCOPE, async () => {
    const events: AiEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    return events;
  });
}

/**
 * Create a mock CompletionUnitAdapter with controlled event stream.
 */
function createMockAdapter(options?: {
  events?: AiEvent[];
  finalResult?: {
    ok: boolean;
    requestId?: string;
    content?: string;
    usage?: { promptTokens: number; completionTokens: number };
    finishReason?: string;
    error?: string;
  };
}): CompletionUnitAdapter {
  const events = options?.events ?? [
    { type: "text_delta" as const, delta: "Test" },
  ];

  const finalResult = options?.finalResult ?? {
    ok: true,
    requestId: "test-req",
    content: events
      .filter((event) => event.type === "text_delta")
      .map((event) => event.delta)
      .join(""),
    usage: { promptTokens: 10, completionTokens: 5 },
    finishReason: "stop",
  };

  return {
    executeCompletionUnit: vi.fn().mockReturnValue({
      stream: (async function* () {
        for (const event of events) {
          yield event;
        }
      })(),
      final: Promise.resolve(finalResult),
    }),
  };
}

/**
 * Create a mock ToolSourcePort that wraps TOOL_CATALOG with stub implementations.
 *
 * NOTE: This uses TOOL_CATALOG stubs intentionally for unit test isolation.
 * The stack test (tests/stack/ai/metrics-tool.stack.test.ts) validates real
 * capability bindings via container.toolSource with injected MetricsCapability.
 */
function createMockToolSource(): ToolSourcePort {
  // Build runtime map from catalog
  const runtimeMap = new Map(
    Object.entries(TOOL_CATALOG).map(([id, tool]) => [
      id,
      toBoundToolRuntime(tool),
    ])
  );

  return {
    getBoundTool: (toolId: string) => runtimeMap.get(toolId),
    listToolSpecs: () => Array.from(runtimeMap.values()).map((t) => t.spec),
    hasToolId: (toolId: string) => runtimeMap.has(toolId),
  };
}

/**
 * Create a minimal GraphRunRequest for testing.
 */
function createTestRequest(
  overrides?: Partial<GraphRunRequest>
): GraphRunRequest {
  return {
    runId: "test-run-id",
    messages: [{ role: "user", content: "Hello" }],
    modelRef: { providerKey: "platform", modelId: "test-model" },
    graphId: "langgraph:test-plain",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("LangGraphInProcProvider", () => {
  it("runs a plain graph without hub context, while a program graph fails closed without it", async () => {
    const adapter = createMockAdapter();
    const source = vi.fn((required: boolean) => resolveNodeSourceContext(required, "real-node", undefined, undefined, undefined, undefined));
    const provider = new LangGraphInProcProvider(adapter, createMockToolSource(), undefined, [], source);
    runnerSpy.mockClear();
    const plain = runInScope(TEST_SCOPE, () => provider.runGraph(createTestRequest()));
    await collectEvents(plain.stream);
    expect((await plain.final).ok).toBe(true);
    expect(adapter.executeCompletionUnit).toHaveBeenCalled();
    expect(source).not.toHaveBeenCalled();
    runnerSpy.mockClear();
    // The program graph's principal resolves; only its hub context is missing.
    const authority = {
      resolvePrincipal: async () => "principal-user",
      guardDeps: { withStore: async () => { throw new Error("unused"); }, adminCheck: async () => "denied" },
    } as never;
    const programProvider = new LangGraphInProcProvider(adapter, createMockToolSource(), undefined, [], source, undefined, authority);
    const mission = runInScope(TEST_SCOPE, () => programProvider.runGraph(createTestRequest({ graphId: "langgraph:work-prioritizer" })));
    await collectEvents(mission.stream);
    expect((await mission.final).ok).toBe(false);
    expect(runnerSpy).not.toHaveBeenCalled();
    expect(source).toHaveBeenCalledWith(true);
  });

  it("only disables unavailable hub grounding and propagates unexpected hub failures", async () => {
    const knowledge = { listGoverningIndex: vi.fn().mockRejectedValue(new Error("hub failed")) };
    await expect(resolveNodeSourceContext(false, "real-node", undefined, undefined, undefined, knowledge)).resolves.toMatchObject({ nodeId: "real-node", governingIndex: [] });
    expect(knowledge.listGoverningIndex).not.toHaveBeenCalled();
    await expect(resolveNodeSourceContext(false, "real-node", "https://node.example", undefined, undefined, undefined)).resolves.toMatchObject({ nodeId: "real-node", origin: "https://node.example", governingIndex: [] });
    await expect(resolveNodeSourceContext(false, "real-node", "https://node.example", undefined, undefined, knowledge)).rejects.toThrow("hub failed");
  });
  describe("valid graphId", () => {
    it("calls adapter.executeCompletionUnit and emits events reflecting adapter stream", async () => {
      await runInScope(TEST_SCOPE, async () => {
        const adapterEvents: AiEvent[] = [
          { type: "text_delta", delta: "Hello " },
          { type: "text_delta", delta: "World" },
        ];
        const mockAdapter = createMockAdapter({ events: adapterEvents });
        const mockToolSource = createMockToolSource();
        const provider = new LangGraphInProcProvider(
          mockAdapter,
          mockToolSource
        );

        const request = createTestRequest({ graphId: "langgraph:test-plain" });
        const { stream, final } = provider.runGraph(request);

        const events = await collectEvents(stream);
        const result = await final;

        // Adapter should be called
        expect(mockAdapter.executeCompletionUnit).toHaveBeenCalled();

        // The harness emits only the final parent answer as public text.
        const textDeltas = events.filter((e) => e.type === "text_delta");
        expect(textDeltas.map((event) => event.delta).join("")).toBe(
          "Hello World"
        );

        // Terminal events present
        const assistantFinals = events.filter(
          (e) => e.type === "assistant_final"
        );
        const dones = events.filter((e) => e.type === "done");
        expect(assistantFinals).toHaveLength(1);
        expect(dones).toHaveLength(1);

        // done is last
        expect(events[events.length - 1]).toEqual({ type: "done" });

        // Result reflects success
        expect(result.ok).toBe(true);
      });
    });
  });

  describe("catalog report seam (CatalogEntry.report)", () => {
    it("every catalog-declared report names a registered event", () => {
      const registered = new Set<string>(Object.values(EVENT_NAMES));
      const declared = Object.values(LANGGRAPH_CATALOG).flatMap((e) => {
        const r = (e as { report?: { event: string } }).report;
        return r ? [r.event] : [];
      });
      expect(declared.length).toBeGreaterThan(0);
      for (const name of declared) expect(registered.has(name)).toBe(true);
    });
  });

  describe("invalid graphId", () => {
    it("emits not_found error then done for unknown graph (REQ1)", async () => {
      await runInScope(TEST_SCOPE, async () => {
        const mockAdapter = createMockAdapter();
        const mockToolSource = createMockToolSource();
        const provider = new LangGraphInProcProvider(
          mockAdapter,
          mockToolSource
        );

        // Request with graph not in catalog
        const request = createTestRequest({
          graphId: "langgraph:nonexistent_graph",
        });
        const { stream, final } = provider.runGraph(request);

        const events = await collectEvents(stream);
        const result = await final;

        // Should NOT call adapter
        expect(mockAdapter.executeCompletionUnit).not.toHaveBeenCalled();

        // Should emit error (client error, not 'internal')
        const errors = events.filter((e) => e.type === "error");
        expect(errors).toHaveLength(1);
        // Per REQ1: assert client error code, not 'internal'
        expect(errors[0]).toEqual({ type: "error", error: "not_found" });

        // done must be last
        const dones = events.filter((e) => e.type === "done");
        expect(dones).toHaveLength(1);
        expect(events[events.length - 1]).toEqual({ type: "done" });

        // Result reflects failure
        expect(result.ok).toBe(false);
        expect(result.error).toBe("not_found");
      });
    });

    it("emits invalid_request error for malformed graphId", async () => {
      await runInScope(TEST_SCOPE, async () => {
        const mockAdapter = createMockAdapter();
        const mockToolSource = createMockToolSource();
        const provider = new LangGraphInProcProvider(
          mockAdapter,
          mockToolSource
        );

        // Request with wrong provider prefix
        const request = createTestRequest({
          graphId: "wrong_provider:cogni",
        });
        const { stream, final } = provider.runGraph(request);

        const events = await collectEvents(stream);
        const result = await final;

        // Should NOT call adapter
        expect(mockAdapter.executeCompletionUnit).not.toHaveBeenCalled();

        // Should emit error
        const errors = events.filter((e) => e.type === "error");
        expect(errors).toHaveLength(1);
        // Per REQ1: client error for malformed input
        expect(errors[0]).toEqual({ type: "error", error: "invalid_request" });

        // done must be last
        expect(events[events.length - 1]).toEqual({ type: "done" });

        // Result reflects failure
        expect(result.ok).toBe(false);
      });
    });
  });
});
