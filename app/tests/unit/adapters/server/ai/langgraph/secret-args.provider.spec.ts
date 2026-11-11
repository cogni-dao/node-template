// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/ai/langgraph/secret-args.provider`
 * Purpose: Secret tool arguments at the provider seam (task.0093): a run that offers a `secretArgs` tool masks every model
 *   call; a run that does not is unchanged; the `ai.tool_call.error` line omits the error text for a secret tool; the
 *   dev provider never offers such a tool.
 * Scope: Real provider over the node-local probe tool and graph. The graph runner is stubbed: it hands back the
 *   completion function and `createToolExecFn`. No database, no LLM.
 * Invariants: SECRET_ARGS_MASK_MODEL_CALLS, SECRET_ARGS_NOT_ON_DEV_SERVER.
 * Side-effects: none
 * Links: inproc.provider.ts, dev/provider.ts, bootstrap/ai/secret-probe.ts
 */

import type { AiEvent, ToolSourcePort } from "@cogni/ai-core";
import {
  CORE_TOOL_BUNDLE,
  type CatalogBoundTool,
  toBoundToolRuntime,
} from "@cogni/ai-tools";
import { describe, expect, it, vi } from "vitest";

import { runInScope } from "@/adapters/server/ai/execution-scope";
import { LangGraphDevProvider } from "@/adapters/server/ai/langgraph/dev/provider";
import { LangGraphInProcProvider } from "@/adapters/server/ai/langgraph/inproc.provider";
import {
  NODE_LOCAL_CATALOG,
  NODE_LOCAL_TOOL_BUNDLE,
  SECRET_PROBE_GRAPH_NAME,
  SECRET_PROBE_NAME,
} from "@/bootstrap/ai/secret-probe";

const captured = vi.hoisted(() => ({
  options: [] as Array<{
    completionFn: (params: { model: string; messages: unknown[] }) => unknown;
    createToolExecFn: (
      emit: (e: AiEvent) => void,
    ) => (name: string, args: unknown, id?: string) => Promise<{ ok: boolean; [k: string]: unknown }>;
  }>,
}));
vi.mock("@cogni/langgraph-graphs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cogni/langgraph-graphs")>();
  return {
    ...actual,
    createInProcGraphRunner: (options: (typeof captured.options)[number]) => {
      captured.options.push(options);
      return {
        stream: (async function* () {
          yield { type: "done" as const };
        })(),
        final: Promise.resolve({ ok: true as const }),
      };
    },
  };
});

const CANARY = "zq9-canary-7f3k-banana-plum";
const CONTROL_GRAPH = "test-control";
const CONTROL_TOOL = "core__get_current_time";

const noopFactory = NODE_LOCAL_CATALOG[SECRET_PROBE_GRAPH_NAME].graphFactory;
const catalog = {
  ...NODE_LOCAL_CATALOG,
  [CONTROL_GRAPH]: {
    displayName: "Control",
    description: "a graph with no secret tool",
    toolIds: [CONTROL_TOOL],
    graphFactory: noopFactory,
    systemPrompt: "control",
  },
};

/** Real contracts and runtimes; every implementation throws an error that carries the canary. */
function source(): { source: ToolSourcePort; bundle: CatalogBoundTool[] } {
  const bundle = [...CORE_TOOL_BUNDLE, ...NODE_LOCAL_TOOL_BUNDLE].map((tool) => ({
    contract: tool.contract,
    implementation: {
      execute: async () => {
        throw new Error(`tool failed with ${CANARY}`);
      },
    },
  })) as CatalogBoundTool[];
  const runtimes = new Map(bundle.map((t) => [t.contract.name, toBoundToolRuntime(t)]));
  return {
    bundle,
    source: {
      getBoundTool: (id) => runtimes.get(id),
      listToolSpecs: () => [...runtimes.values()].map((r) => r.spec),
      hasToolId: (id) => runtimes.has(id),
    },
  };
}

const scope = {
  billing: { billingAccountId: "payer-1", virtualKeyId: "vk" },
  usageSource: "litellm" as const,
  llmService: {} as never,
  subjectUserId: "human-1",
};

async function start(graph: string, logged: Array<Record<string, unknown>> = []) {
  captured.options.length = 0;
  const adapter = {
    executeCompletionUnit: vi.fn(() => ({
      stream: (async function* () {})(),
      final: Promise.resolve({ ok: true as const, content: "" }),
    })),
  };
  const { source: src, bundle } = source();
  const provider = new LangGraphInProcProvider(
    adapter as never,
    src,
    undefined,
    bundle,
    undefined,
    undefined,
    undefined,
    catalog,
  );
  (provider as unknown as { log: unknown }).log = {
    debug: () => {},
    info: () => {},
    error: () => {},
    warn: (fields: Record<string, unknown>) => logged.push(fields),
  };
  const result = runInScope(scope, () =>
    provider.runGraph({
      runId: `run-${graph}`,
      graphId: `langgraph:${graph}`,
      messages: [{ role: "user", content: "go" }],
      modelRef: { providerKey: "platform", modelId: "m" },
    }),
  );
  for await (const _ of result.stream) void _;
  const options = captured.options[0];
  if (!options) throw new Error("graph runner was not built");
  return {
    adapter,
    callModel: () => options.completionFn({ model: "m", messages: [] }),
    exec: (name: string, args: unknown) =>
      runInScope(scope, () => options.createToolExecFn(() => {})(name, args, "c1")),
  };
}

describe("a run that offers a secret tool masks every model call", () => {
  it("passes maskContent: true on each model call of the probe graph", async () => {
    const run = await start(SECRET_PROBE_GRAPH_NAME);
    run.callModel();
    run.callModel();
    expect(run.adapter.executeCompletionUnit).toHaveBeenCalledTimes(2);
    for (const [params] of run.adapter.executeCompletionUnit.mock.calls as unknown as Array<[Record<string, unknown>]>) {
      expect(params.maskContent).toBe(true);
    }
  });

  it("leaves a run with no secret tool unchanged: no maskContent key at all", async () => {
    const run = await start(CONTROL_GRAPH);
    run.callModel();
    const [params] = run.adapter.executeCompletionUnit.mock.calls[0] as unknown as [Record<string, unknown>];
    expect("maskContent" in params).toBe(false);
  });
});

describe("ai.tool_call.error for a secret tool", () => {
  it("omits safeMessage, keeps the code, and carries no canary", async () => {
    const logged: Array<Record<string, unknown>> = [];
    const run = await start(SECRET_PROBE_GRAPH_NAME, logged);
    const result = await run.exec(SECRET_PROBE_NAME, { secret: CANARY });
    expect(result).toMatchObject({ ok: false, errorCode: "execution" });
    const line = logged.find((l) => l.event === "ai.tool_call.error");
    expect(line).toMatchObject({ tool: SECRET_PROBE_NAME, errorCode: "execution" });
    expect(line && "safeMessage" in line).toBe(false);
    expect(JSON.stringify({ logged, result })).not.toContain(CANARY);
  });

  it("keeps safeMessage for a tool with no secretArgs", async () => {
    const logged: Array<Record<string, unknown>> = [];
    const run = await start(CONTROL_GRAPH, logged);
    await run.exec(CONTROL_TOOL, {});
    const line = logged.find((l) => l.event === "ai.tool_call.error");
    expect(line?.safeMessage).toContain("tool failed with");
  });
});

describe("the dev provider never offers a secret tool", () => {
  it("drops the probe tool id from the dev server's configurable toolIds", async () => {
    const stream = vi.fn().mockReturnValue((async function* () {})());
    const client = {
      threads: { create: vi.fn().mockResolvedValue({}) },
      runs: { stream },
    };
    const provider = new LangGraphDevProvider(
      client as unknown as import("@langchain/langgraph-sdk").Client,
      { availableGraphs: ["cogni"], secretToolIds: [SECRET_PROBE_NAME] },
    );
    const result = runInScope(scope, () =>
      provider.runGraph({
        runId: "run-dev",
        graphId: "langgraph:cogni",
        stateKey: "state-1",
        messages: [{ role: "user", content: "hi" }],
        modelRef: { providerKey: "platform", modelId: "m" },
        toolIds: [CONTROL_TOOL, SECRET_PROBE_NAME],
      }),
    );
    for await (const _ of result.stream) void _;
    const config = stream.mock.calls[0]?.[2] as { config: { configurable: { toolIds: string[] } } };
    expect(config.config.configurable.toolIds).toEqual([CONTROL_TOOL]);
  });
});
