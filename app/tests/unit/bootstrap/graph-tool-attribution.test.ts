// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/graph-tool-attribution`
 * Purpose: A graph tool's write is attributed through the real binding path (task.0133): the real launcher, the real in-process provider and tool guard,
 *   the real tool bindings and bound tool source, and the capabilities the container builds, not a hand-wired capability.
 * Scope: `runGraphWithScope` -> `LangGraphInProcProvider` -> `guardTools` -> `createBoundToolSource(createToolBindings(...))` -> `createWorkItemCapability`
 *   built from `createWorkItemWriters` (the function the container uses) and the EDO capability bound by `bindEdoToolCapability`. Only the stores are stubbed.
 *   A source check pins the container's own wiring to those same functions.
 * Invariants:
 *   - ACTOR_IS_THE_PRINCIPAL: the actor a tool write records is the catalog principal the guard authorized, never the run's subject.
 *   - REQUESTER_AND_RUN: the subject is the requester and the run record's id and kind are the run.
 *   - NO_SECOND_PATH: the container hands the tools only the attributed capabilities.
 * Side-effects: IO (reads the container source)
 * @internal
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import type { AgentGrantsStore, GuardDeps } from "@cogni/agent-grants";
import type { AiEvent } from "@cogni/ai-core";
import { CORE_TOOL_BUNDLE } from "@cogni/ai-tools";
import { bindEdoToolCapability, createEdoCapability } from "@cogni/knowledge-store";
import {
  FakeEdoResolverAdapter,
  FakeKnowledgeStoreAdapter,
} from "@cogni/knowledge-store/adapters/fake";
import {
  createWorkItemWriters,
  type WorkItemCommandPort,
  type WorkItemQueryPort,
} from "@cogni/work-items";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  options: [] as Array<{
    createToolExecFn: (
      emit: (e: AiEvent) => void
    ) => (name: string, args: unknown, id?: string) => Promise<{ ok: boolean; [k: string]: unknown }>;
  }>,
}));
vi.mock("@cogni/langgraph-graphs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cogni/langgraph-graphs")>();
  const noopFactory = actual.NODE_LANGGRAPH_CATALOG.cogni.graphFactory;
  return {
    ...actual,
    LANGGRAPH_CATALOG: {
      ...actual.LANGGRAPH_CATALOG,
      // Synthetic graphs carrying exactly the write tools under test, with real catalog principals.
      "test-item-writer": {
        displayName: "Test item writer",
        description: "prioritizer principal with the work-item write tools",
        principal: "prioritizer",
        toolIds: ["core__work_item_update", "core__work_item_artifact_record"],
        graphFactory: noopFactory,
      },
      "test-edo-writer": {
        displayName: "Test EDO writer",
        description: "node-ai principal with the EDO write tools",
        principal: "node-ai",
        toolIds: ["core__edo_hypothesize", "core__edo_decide", "core__edo_record_outcome"],
        graphFactory: noopFactory,
      },
    },
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
vi.mock("@/bootstrap/otel", () => ({ getCurrentTraceId: () => "trace-1" }));

import { getExecutionScope } from "@/adapters/server/ai/execution-scope";
import { LangGraphInProcProvider } from "@/adapters/server/ai/langgraph/inproc.provider";
import { createToolBindings } from "@/bootstrap/ai/tool-bindings";
import { NODE_LOCAL_TOOL_BINDINGS, NODE_LOCAL_TOOL_BUNDLE } from "@/bootstrap/ai/secret-probe";
import { createBoundToolSource } from "@/bootstrap/ai/tool-source.factory";
import { createGoalMetricTools } from "@/bootstrap/capabilities/goal-metric-tools";
import { createWorkItemCapability } from "@/bootstrap/capabilities/work-item";
import { runGraphWithScope } from "@/bootstrap/graph-executor.factory";
import { runAttribution } from "@/bootstrap/run-attribution";

const PRIORITIZER = "user-prioritizer";
const NODE_AI = "user-node-ai";
const SUBJECT = "schedule-owner";
const RUN_ID = "run-e52ebb8a";

const store = (roles: Array<[string, string]>): AgentGrantsStore => ({
  hasLiveRole: async (p, s) => roles.some(([rp, rs]) => rp === p && rs === s),
  liveScopes: async (p, scopes) => scopes.filter((s) => roles.some(([rp, rs]) => rp === p && rs === s)),
  listLiveRoles: async () => [],
  findInternalPrincipal: async () => null,
  insertRole: async () => true,
  revokeRole: async () => true,
});
const grants = store([
  [PRIORITIZER, "work_item:transition"],
  [NODE_AI, "edo:write"],
]);
const decisions: Array<{ principal: string | null; subject: string | null; tool: string; decision: string }> = [];
const authority = {
  resolvePrincipal: async (slug: string) => ({ prioritizer: PRIORITIZER, "node-ai": NODE_AI })[slug] ?? null,
  guardDeps: {
    withStore: (fn) => fn(grants),
    adminCheck: async () => "denied",
    onDecision: (e) => decisions.push(e as never),
  } as Omit<GuardDeps, "runAs">,
};

// The stores under the capabilities: the only stubs on the path.
const patchStore = vi.fn();
const artifactInsert = vi.fn();
const toolLog = vi.fn();
const item = {
  id: "task.0001",
  type: "task",
  title: "t",
  status: "needs_implement",
  node: "shared",
  actor: "either",
  labels: [],
  assignees: [],
  externalRefs: [],
  specRefs: [],
  revision: 4,
  deployVerified: false,
  createdAt: "2026-11-18T00:00:00.000Z",
  updatedAt: "2026-11-18T00:00:00.000Z",
};

const writers = createWorkItemWriters({
  log: { info: toolLog, warn: vi.fn() },
  scope: getExecutionScope,
  traceId: () => "trace-1",
  store: () => ({ patch: patchStore }),
  artifacts: () =>
    ({
      items: { get: async () => ({ revision: 3 }) },
      artifacts: { insert: artifactInsert, list: vi.fn(), latest: vi.fn() },
    }) as never,
});
const workItemCapability = createWorkItemCapability({
  workItemQuery: { list: vi.fn(), get: vi.fn() } as unknown as WorkItemQueryPort,
  workItemCommand: {} as unknown as WorkItemCommandPort,
  backlogWriter: writers.backlogWriter,
  artifacts: writers.artifacts,
});

async function edoWorld() {
  const knowledge = new FakeKnowledgeStoreAdapter();
  await knowledge.registerDomain({ id: "meta", name: "Meta" });
  const edoWrite = createEdoCapability(knowledge, new FakeEdoResolverAdapter(knowledge));
  return { knowledge, edoWrite };
}

function sourceFor(edoWrite: ReturnType<typeof createEdoCapability>) {
  const bindings = createToolBindings({
    knowledgeCapability: {} as never,
    edoCapability: bindEdoToolCapability(edoWrite, runAttribution),
    metricsCapability: {} as never,
    webSearchCapability: {} as never,
    repoCapability: {} as never,
    scheduleCapability: {} as never,
    vcsCapability: {} as never,
    workItemCapability,
    accountCreditsCapability: {} as never,
  });
  // The container's own composition: core bundle, node-local bundle, and the three binding sources it spreads.
  const metricTools = createGoalMetricTools({ metrics: () => undefined, goalProgress: async () => ({}) as never });
  return createBoundToolSource([...CORE_TOOL_BUNDLE, ...NODE_LOCAL_TOOL_BUNDLE], {
    ...bindings,
    ...metricTools.bindings,
    ...NODE_LOCAL_TOOL_BINDINGS,
  });
}

/** One tool call exactly as a run makes it: the real launcher sets the scope, the provider's guard authorizes and binds the principal, the bound tool runs. */
async function callTool(
  graph: string,
  tool: string,
  args: unknown,
  edoWrite: ReturnType<typeof createEdoCapability>,
  runKind?: "user_immediate" | "system_scheduled" | "system_webhook"
) {
  captured.options.length = 0;
  const provider = new LangGraphInProcProvider(
    { executeCompletionUnit: vi.fn() } as never,
    sourceFor(edoWrite),
    undefined,
    [...CORE_TOOL_BUNDLE, ...NODE_LOCAL_TOOL_BUNDLE],
    async () => ({ nodeId: "node", origin: "https://node.example" }),
    async () => ({}) as never,
    authority
  );
  let outcome: Promise<{ ok: boolean; [k: string]: unknown }> | undefined;
  runGraphWithScope({
    executor: {
      runGraph: (req: never, ctx: never) => {
        const result = provider.runGraph(req, ctx);
        outcome = (async () => {
          for await (const _event of result.stream) void _event;
          return captured.options[0]!.createToolExecFn(() => {})(tool, args, "call-1");
        })();
        return result;
      },
    } as never,
    req: {
      runId: RUN_ID,
      graphId: `langgraph:${graph}`,
      messages: [{ role: "user", content: "go" }],
      modelRef: { providerKey: "platform", modelId: "m" },
    } as never,
    ctx: { actorUserId: SUBJECT },
    billing: { billingAccountId: "payer-1", virtualKeyId: "vk" },
    llmService: {} as never,
    usageSource: "litellm",
    ...(runKind ? { runKind } : {}),
  });
  return outcome as Promise<{ ok: boolean; [k: string]: unknown }>;
}

const RUN = { id: RUN_ID, kind: "system_scheduled" } as const;

beforeEach(() => {
  vi.clearAllMocks();
  decisions.length = 0;
  patchStore.mockResolvedValue(item);
  artifactInsert.mockImplementation(async (row: Record<string, unknown>) => ({
    id: "wia-1",
    seq: 1,
    itemRevision: 3,
    createdAt: "2026-11-18T00:00:00.000Z",
    ...row,
    author: (row.attribution as { actor: string }).actor,
  }));
});

describe("a graph tool write through the real binding path (task.0133)", () => {
  it("core__work_item_update: the guard authorizes the principal, the store receives the principal as actor, the subject as requester, and the run", async () => {
    const { edoWrite } = await edoWorld();
    const result = await callTool(
      "test-item-writer",
      "core__work_item_update",
      { id: "task.0001", reason: "scheduled triage", set: { summary: "s" } },
      edoWrite,
      RUN.kind
    );
    expect(decisions.find((d) => d.tool === "core__work_item_update" && d.decision === "allow")).toMatchObject({
      principal: PRIORITIZER,
      subject: SUBJECT,
    });
    expect(result.ok).toBe(true);
    expect(patchStore).toHaveBeenCalledOnce();
    expect(patchStore.mock.calls[0]?.[1]).toEqual({ actor: PRIORITIZER, requestedBy: SUBJECT, run: RUN });
    // The tool path's terminal event carries the same three facts.
    expect(toolLog.mock.calls.find(([f]) => f.event === "work.items.patch_success")?.[0]).toMatchObject({
      via: "tool",
      workItemId: "task.0001",
      actor: PRIORITIZER,
      requestedBy: SUBJECT,
      runId: RUN_ID,
      runKind: RUN.kind,
    });
  });

  it("core__work_item_artifact_record: the artifact's attribution is the principal, the subject and the run", async () => {
    const { edoWrite } = await edoWorld();
    const result = await callTool(
      "test-item-writer",
      "core__work_item_artifact_record",
      { id: "task.0001", artifact: { kind: "triage", subject: "work:task.0001", verdict: "design", note: "no KPI measures this yet" } },
      edoWrite,
      RUN.kind
    );
    expect(result.ok).toBe(true);
    expect(artifactInsert.mock.calls[0]?.[0]).toMatchObject({
      itemId: "task.0001",
      attribution: { actor: PRIORITIZER, requestedBy: SUBJECT, run: RUN },
    });
    expect(toolLog.mock.calls.find(([f]) => f.event === "work.items.artifact_recorded")?.[0]).toMatchObject({
      via: "tool",
      actor: PRIORITIZER,
      requestedBy: SUBJECT,
      runId: RUN_ID,
    });
  });

  it("a run whose record names no kind still writes as the principal with its requester, and carries no run", async () => {
    const { edoWrite } = await edoWorld();
    await callTool("test-item-writer", "core__work_item_update", { id: "task.0001", reason: "r", set: { summary: "s" } }, edoWrite);
    expect(patchStore.mock.calls[0]?.[1]).toEqual({ actor: PRIORITIZER, requestedBy: SUBJECT });
  });

  it.each([
    ["core__edo_hypothesize", { id: "h1", domain: "meta", title: "Prediction", content: "Will be tested", evaluateAt: "2026-12-01T00:00:00.000Z", sourceType: "agent" }, "edo: hypothesize 'h1'"],
  ])("%s: the commit names the principal first, then the requester and the run", async (tool, args, first) => {
    const { knowledge, edoWrite } = await edoWorld();
    const result = await callTool("test-edo-writer", tool, args, edoWrite, RUN.kind);
    expect(result.ok).toBe(true);
    expect(knowledge.commitLog.at(-1)?.message.split("\n")).toEqual([
      `${first} by actor:${NODE_AI}`,
      `Requested-by: ${SUBJECT}`,
      `Run: ${RUN_ID} ${RUN.kind}`,
    ]);
  });

  it("core__edo_decide and core__edo_record_outcome are attributed the same way", async () => {
    const { knowledge, edoWrite } = await edoWorld();
    const run = (tool: string, args: unknown) => callTool("test-edo-writer", tool, args, edoWrite, RUN.kind);
    await run("core__edo_hypothesize", { id: "h1", domain: "meta", title: "P", content: "c", evaluateAt: "2026-12-01T00:00:00.000Z", sourceType: "agent" });
    await run("core__edo_decide", { id: "d1", domain: "meta", title: "D", content: "c", derivesFromHypothesisId: "h1", sourceType: "agent" });
    expect(knowledge.commitLog.at(-1)?.message.split("\n")[0]).toBe(`edo: decide 'd1' by actor:${NODE_AI}`);
    await run("core__edo_record_outcome", { id: "o1", domain: "meta", title: "O", content: "c", hypothesisId: "h1", edge: "validates", sourceType: "agent" });
    expect(knowledge.commitLog.at(-1)?.message.split("\n")).toEqual([
      `edo: resolve hypothesis h1 by actor:${NODE_AI}`,
      `Requested-by: ${SUBJECT}`,
      `Run: ${RUN_ID} ${RUN.kind}`,
    ]);
  });
});

describe("the container hands the tools only the attributed capabilities (task.0133)", () => {
  const container = readFileSync(path.resolve(__dirname, "../../../src/bootstrap/container.ts"), "utf8");
  const code = container.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("builds the work-item capability from createWorkItemWriters and nothing else", () => {
    expect(code).toContain("createWorkItemWriters({");
    expect(code).toContain("backlogWriter: workItemWriters.backlogWriter");
    expect(code).toContain("artifacts: workItemWriters.artifacts");
    expect(code).not.toMatch(/backlogWriter:\s*\{/);
  });

  it("binds the EDO tools to the run's attribution and hands that, not the route capability, to the tool bindings", () => {
    expect(code).toMatch(/bindEdoToolCapability\(\s*edoCapability,\s*runAttribution/);
    const bindings = code.slice(code.indexOf("createToolBindings({"), code.indexOf("createToolBindings({") + 400);
    expect(bindings).toContain("edoCapability: edoToolCapability");
  });
});
