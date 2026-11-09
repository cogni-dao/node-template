// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/ai/langgraph/inproc.provider.authority`
 * Purpose: Tool authority at the provider seam (task.5456, V4 V5 V6 V7): the catalog principal, the guard
 *   around every createToolRunner site, and the principal/subject binding the tools observe.
 * Scope: Real provider + real guard + real ai-core tool runner over an in-memory role store. The graph runner is
 *   stubbed: it only hands back `createToolExecFn`. No database, no LLM.
 * Invariants: SCOPED_TOOL_NEEDS_PRINCIPAL, SUBJECT_ONLY_NARROWS, GUARD_COVERS_EVERY_RUNNER_SITE.
 * Side-effects: none
 * Links: inproc.provider.ts, packages/agent-grants
 */

import type { AgentGrantsStore, GuardDeps } from "@cogni/agent-grants";
import type { AiEvent, ToolSourcePort } from "@cogni/ai-core";
import {
  CORE_TOOL_BUNDLE,
  type CatalogBoundTool,
  toBoundToolRuntime,
} from "@cogni/ai-tools";
import { describe, expect, it, vi } from "vitest";

import {
  getExecutionScope,
  runInScope,
} from "@/adapters/server/ai/execution-scope";
import { runGraphWithScope } from "@/bootstrap/graph-executor.factory";
import {
  LangGraphInProcProvider,
  type ProviderAgentAuthority,
} from "@/adapters/server/ai/langgraph/inproc.provider";

const captured = vi.hoisted(() => ({
  /** "abort": the stub graph waits for the run's abort signal, then reports it as the real runner does (error + done). */
  mode: "finish" as "finish" | "abort",
  options: [] as Array<{
    request: { abortSignal?: AbortSignal; messages: Array<{ role: string; content: string }>; configurable: { toolIds: string[] } };
    toolContracts: Array<{ name: string }>;
    completionFn: (params: { model: string; messages: unknown[] }) => { final: Promise<unknown> };
    createToolExecFn: (
      emit: (e: AiEvent) => void,
    ) => (
      name: string,
      args: unknown,
      id?: string,
    ) => Promise<{ ok: boolean; [k: string]: unknown }>;
  }>,
}));
vi.mock("@cogni/langgraph-graphs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cogni/langgraph-graphs")>();
  return {
    ...actual,
    createInProcGraphRunner: (options: (typeof captured.options)[number]) => {
      captured.options.push(options);
      if (captured.mode === "abort") {
        const signal = options.request.abortSignal;
        const aborted = new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          stream: (async function* () {
            await aborted;
            // The real graph needs a moment to unwind after the abort; a looping graph may call the model in that window.
            await new Promise((r) => setTimeout(r, 25));
            yield { type: "error" as const, error: "aborted" };
            yield { type: "done" as const };
          })(),
          final: aborted.then(() => new Promise((r) => setTimeout(r, 25))).then(() => ({ ok: false as const, error: "aborted" })),
        };
      }
      return {
        stream: (async function* () {
          yield { type: "done" as const };
        })(),
        final: Promise.resolve({ ok: true as const }),
      };
    },
  };
});

const REACHED = "stub_tool_reached";
const reached = (r: { ok: boolean; safeMessage?: unknown }) =>
  !r.ok && r.safeMessage === REACHED;

const PRIORITIZER_USER = "user-prioritizer";
const NODE_AI_USER = "user-node-ai";
const ADMIN = "human-admin";
const MEMBER = "human-member";
const AGENT = "bearer-agent"; // an authenticated machine caller: a subject like any other, with no wallet

function store(roles: Array<[string, string]>): AgentGrantsStore {
  return {
    hasLiveRole: async (p, s) => roles.some(([rp, rs]) => rp === p && rs === s),
    liveScopes: async (p, scopes) => scopes.filter((s) => roles.some(([rp, rs]) => rp === p && rs === s)),
    listLiveRoles: async () => [],
    findInternalPrincipal: async () => null,
    insertRole: async () => true,
    revokeRole: async () => true,
  };
}

function authority(opts: {
  principals: Record<string, string>;
  roles: Array<[string, string]>;
}): ProviderAgentAuthority & { events: unknown[] } {
  const events: unknown[] = [];
  const s = store(opts.roles);
  const deps: Omit<GuardDeps, "runAs"> = {
    withStore: (fn) => fn(s),
    // Only the DAO admin's wallet passes; humans without one and agents (no wallet) are denied.
    adminCheck: async (id) => (id === ADMIN ? "allow" : "denied"),
    onDecision: (e) => events.push(e),
  };
  return {
    events,
    resolvePrincipal: async (slug) => opts.principals[slug] ?? null,
    guardDeps: deps,
  };
}

/** Real contracts and runtimes, with recording stub implementations that return schema-valid output. */
function toolSource(seen: Array<{ tool: string; scope: unknown }>): {
  source: ToolSourcePort;
  bundle: CatalogBoundTool[];
} {
  const bundle = CORE_TOOL_BUNDLE.map((tool) => ({
    contract: tool.contract,
    implementation: {
      execute: async () => {
        seen.push({ tool: tool.contract.name, scope: { ...getExecutionScope() } });
        // The tool body is out of scope here: reaching it is the "allowed" signal.
        throw new Error(REACHED);
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

const adapter = { executeCompletionUnit: vi.fn() };

async function start(
  graph: string,
  auth: ProviderAgentAuthority | undefined,
  subjectUserId: string | undefined,
  seen: Array<{ tool: string; scope: unknown }> = [],
  ctxExtra: { requestIntent?: "answer" | "decide" } = {},
  logged?: Array<Record<string, unknown>>,
) {
  captured.options.length = 0;
  const { source, bundle } = toolSource(seen);
  const provider = new LangGraphInProcProvider(
    adapter,
    source,
    undefined,
    bundle,
    async () => ({ nodeId: "node", origin: "https://node.example" }),
    async () => ({}) as never,
    auth,
  );
  if (logged)
    (provider as unknown as { log: unknown }).log = {
      debug: () => {}, info: () => {}, error: () => {},
      warn: (fields: Record<string, unknown>) => logged.push(fields),
    };
  const scope = {
    billing: { billingAccountId: "payer-1", virtualKeyId: "vk" },
    usageSource: "litellm" as const,
    llmService: {} as never,
    ...(subjectUserId ? { subjectUserId } : {}),
  };
  const events: AiEvent[] = [];
  const result = runInScope(scope, () =>
    provider.runGraph(
      {
        runId: `run-${graph}`,
        graphId: `langgraph:${graph}`,
        messages: [{ role: "user", content: "go" }],
        modelRef: { providerKey: "platform", modelId: "m" },
      },
      { actorUserId: subjectUserId ?? "unused-for-authority", ...ctxExtra },
    ),
  );
  for await (const event of result.stream) events.push(event);
  const options = captured.options[0];
  return {
    final: await result.final,
    events,
    options,
    exec: (name: string, args: unknown) =>
      runInScope(scope, () => options!.createToolExecFn(() => {})(name, args, "c1")),
  };
}

/** The `agent_tool.authz` events for one tool, so a test can ignore the run-start `not_offered` lines for other tools. */
const forTool = (events: unknown[], tool: string) =>
  (events as Array<{ tool: string }>).filter((e) => e.tool === tool);

const TRANSITION_ARGS = { action: "patch", id: "task.1", priority: 3 };

describe("V4: a graph whose principal has no seed row is denied before any tool runs", () => {
  it("fails the run and never builds a tool runner", async () => {
    const auth = authority({ principals: {}, roles: [] });
    const run = await start("work-prioritizer", auth, undefined);
    expect(run.events).toEqual([{ type: "error", error: "internal" }, { type: "done" }]);
    expect(run.options).toBeUndefined();
  });

  it("fails the run when no authority is wired at all", async () => {
    const run = await start("work-prioritizer", undefined, undefined);
    expect(run.options).toBeUndefined();
  });
});

describe("a principal-store outage is authz_unavailable and is logged", () => {
  it("logs agent_tool.authz (unavailable / principal_lookup_failed), fails the run closed and builds no runner", async () => {
    captured.options.length = 0;
    const { source, bundle } = toolSource([]);
    const down: ProviderAgentAuthority = {
      resolvePrincipal: async () => {
        throw new Error("connection refused");
      },
      guardDeps: authority({ principals: {}, roles: [] }).guardDeps,
    };
    const provider = new LangGraphInProcProvider(
      adapter, source, undefined, bundle,
      async () => ({ nodeId: "node", origin: "https://node.example" }),
      async () => ({}) as never,
      down,
    );
    const logged: Array<Record<string, unknown>> = [];
    (provider as unknown as { log: unknown }).log = {
      debug: () => {}, info: () => {}, warn: () => {},
      error: (fields: Record<string, unknown>) => logged.push(fields),
    };
    const scope = { billing: { billingAccountId: "payer-1", virtualKeyId: "vk" }, usageSource: "litellm" as const, llmService: {} as never };
    const result = runInScope(scope, () =>
      provider.runGraph(
        { runId: "run-down", graphId: "langgraph:brain", messages: [{ role: "user", content: "go" }], modelRef: { providerKey: "platform", modelId: "m" } },
        { actorUserId: MEMBER },
      ),
    );
    const events: AiEvent[] = [];
    for await (const e of result.stream) events.push(e);
    expect(events).toEqual([{ type: "error", error: "internal" }, { type: "done" }]);
    expect(captured.options).toHaveLength(0);
    expect(logged).toEqual([
      expect.objectContaining({
        event: "agent_tool.authz",
        runId: "run-down",
        principal: "node-ai",
        decision: "unavailable",
        code: "authz_unavailable",
        reason: "principal_lookup_failed",
      }),
    ]);
    expect(JSON.stringify(logged)).not.toContain("connection refused");
  });
});

describe("V6: work-prioritizer writes; cogni-decide, with the same tools and no principal, is denied", () => {
  const auth = () =>
    authority({
      principals: { prioritizer: PRIORITIZER_USER },
      roles: [[PRIORITIZER_USER, "work_item:transition"]],
    });

  it("allows work_item_transition for the prioritizer role", async () => {
    const seen: Array<{ tool: string; scope: unknown }> = [];
    const a = auth();
    const run = await start("work-prioritizer", a, undefined, seen);
    const result = await run.exec("core__work_item_transition", TRANSITION_ARGS);
    expect(reached(result)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(a.events).toEqual([
      expect.objectContaining({ principal: PRIORITIZER_USER, subject: null, payer: "payer-1", tool: "core__work_item_transition", decision: "allow" }),
    ]);
  });

  it("does not offer the same tool to cogni-decide (no principal), and a forced call never reaches the tool", async () => {
    const seen: Array<{ tool: string; scope: unknown }> = [];
    const a = auth();
    const run = await start("cogni-decide", a, MEMBER, seen);
    // DENIAL_IS_TERMINAL (1/2): the model is never offered the tool.
    expect(run.options!.toolContracts.map((c) => c.name)).not.toContain("core__work_item_transition");
    expect(run.options!.request.configurable.toolIds).not.toContain("core__work_item_transition");
    expect(forTool(a.events, "core__work_item_transition")).toEqual([
      expect.objectContaining({ principal: null, decision: "deny", code: "policy_denied", reason: "not_offered:no_principal" }),
    ]);
    const result = await run.exec("core__work_item_transition", TRANSITION_ARGS);
    expect(result.ok).toBe(false);
    expect(seen).toEqual([]);
  });
});

describe("V7: brain + node-ai with knowledge:write", () => {
  const KNOWLEDGE = { id: "k1", domain: "d", title: "t", content: "c", sourceType: "human" };
  const base = () =>
    authority({ principals: { "node-ai": NODE_AI_USER }, roles: [[NODE_AI_USER, "knowledge:write"]] });

  it("denies a non-admin subject", async () => {
    const run = await start("brain", base(), MEMBER);
    expect(await run.exec("core__knowledge_write", KNOWLEDGE)).toMatchObject({
      ok: false,
      receipt: { code: "policy_denied" },
    });
  });

  it("allows an admin subject", async () => {
    const seen: Array<{ tool: string; scope: unknown }> = [];
    const a = base();
    const run = await start("brain", a, ADMIN, seen);
    expect(reached(await run.exec("core__knowledge_write", KNOWLEDGE))).toBe(true);
    expect(forTool(a.events, "core__knowledge_write")).toEqual([
      expect.objectContaining({ principal: NODE_AI_USER, subject: ADMIN, payer: "payer-1", decision: "allow" }),
    ]);
  });

  it("does not offer the tool to an admin when the graph has no principal", async () => {
    // autoresearch has knowledge_write in its tools and no catalog principal.
    const run = await start("autoresearch-single-lane", base(), ADMIN);
    expect(run.options!.toolContracts.map((c) => c.name)).not.toContain("core__knowledge_write");
    expect((await run.exec("core__knowledge_write", KNOWLEDGE)).ok).toBe(false);
  });

  it("denies the next call after the role row is gone", async () => {
    const roles: Array<[string, string]> = [[NODE_AI_USER, "knowledge:write"]];
    const a = authority({ principals: { "node-ai": NODE_AI_USER }, roles });
    const run = await start("brain", a, ADMIN);
    expect(reached(await run.exec("core__knowledge_write", KNOWLEDGE))).toBe(true);
    roles.length = 0;
    expect(reached(await run.exec("core__knowledge_write", KNOWLEDGE))).toBe(false);
  });

  it("reports an admin outage as authz_unavailable", async () => {
    const a = base();
    const unavailable: ProviderAgentAuthority = {
      ...a,
      guardDeps: { ...a.guardDeps, adminCheck: async () => "unavailable" },
    };
    const run = await start("brain", unavailable, ADMIN);
    expect(await run.exec("core__knowledge_write", KNOWLEDGE)).toMatchObject({
      ok: false,
      receipt: { code: "authz_unavailable" },
    });
  });
});

describe("V5: principal and subject reach the tool; own scope needs a subject", () => {
  const SCHEDULE = { action: "delete", scheduleId: "s1" };
  const a = () =>
    authority({ principals: { "node-ai": NODE_AI_USER }, roles: [[NODE_AI_USER, "schedule:manage"]] });

  it("a human caller binds subject and principal for the tool call", async () => {
    const seen: Array<{ tool: string; scope: unknown }> = [];
    const run = await start("brain", a(), MEMBER, seen);
    expect(reached(await run.exec("core__schedule_manage", SCHEDULE))).toBe(true);
    expect(seen[0]?.scope).toMatchObject({ principalId: NODE_AI_USER, subjectUserId: MEMBER });
  });

  it("a bearer agent is the subject, so its schedule_manage runs as its own user id", async () => {
    const seen: Array<{ tool: string; scope: unknown }> = [];
    const run = await start("brain", a(), AGENT, seen);
    expect(reached(await run.exec("core__schedule_manage", SCHEDULE))).toBe(true);
    expect(seen[0]?.scope).toMatchObject({ principalId: NODE_AI_USER, subjectUserId: AGENT });
  });

  it("a run with no caller has no subject, so schedule_manage is withheld at run start (and a run with nothing left to do makes no model call)", async () => {
    const seen: Array<{ tool: string; scope: unknown }> = [];
    const logged: Array<Record<string, unknown>> = [];
    const x = a();
    const run = await start("brain", x, undefined, seen, {}, logged);
    expect(run.options).toBeUndefined();
    expect(forTool(x.events, "core__schedule_manage")).toEqual([
      expect.objectContaining({ decision: "deny", reason: "not_offered:no_subject", runId: "run-brain" }),
    ]);
    expect(seen).toEqual([]);
    expect(logged.filter((l) => l.event === "agent_run.denied")).toEqual([expect.objectContaining({ reason: "no_permission", modelCalls: 0 })]);
  });
});

describe("bearer agents (subject with no wallet): admin narrows, member passes", () => {
  it("brain + node-ai holding knowledge:write: a bearer agent is denied", async () => {
    const a = authority({ principals: { "node-ai": NODE_AI_USER }, roles: [[NODE_AI_USER, "knowledge:write"]] });
    const seen: Array<{ tool: string; scope: unknown }> = [];
    const run = await start("brain", a, AGENT, seen);
    expect(await run.exec("core__knowledge_write", { id: "k1", domain: "d", title: "t", content: "c", sourceType: "human" })).toMatchObject({
      ok: false,
      receipt: { code: "policy_denied", retryable: false },
    });
    expect(seen).toEqual([]);
    expect(forTool(a.events, "core__knowledge_write")).toEqual([expect.objectContaining({ principal: NODE_AI_USER, subject: AGENT, decision: "deny", reason: "subject_not_admin" })]);
  });

  it("a bearer agent calling a member-level tool is allowed", async () => {
    const a = authority({ principals: { prioritizer: PRIORITIZER_USER }, roles: [[PRIORITIZER_USER, "work_item:transition"]] });
    const seen: Array<{ tool: string; scope: unknown }> = [];
    const run = await start("work-prioritizer", a, AGENT, seen);
    expect(reached(await run.exec("core__work_item_transition", TRANSITION_ARGS))).toBe(true);
    expect(forTool(a.events, "core__work_item_transition")).toEqual([expect.objectContaining({ principal: PRIORITIZER_USER, subject: AGENT, decision: "allow" })]);
  });
});

describe("a scheduled run's subject is its execution-grant owner", () => {
  /** What the internal run route does: `actorUserId = grant.userId`, then the single launcher entry. */
  async function scheduledRun(graph: string, grantOwner: string, auth: ProviderAgentAuthority) {
    captured.options.length = 0;
    const { source, bundle } = toolSource([]);
    const provider = new LangGraphInProcProvider(
      adapter, source, undefined, bundle,
      async () => ({ nodeId: "node", origin: "https://node.example" }),
      async () => ({}) as never,
      auth,
    );
    const result = runGraphWithScope({
      executor: provider,
      req: { runId: `sched-${graph}`, graphId: `langgraph:${graph}`, messages: [{ role: "user", content: "go" }], modelRef: { providerKey: "platform", modelId: "m" } },
      ctx: { actorUserId: grantOwner, requestIntent: "decide" },
      billing: { billingAccountId: "payer-1", virtualKeyId: "vk" },
      llmService: {} as never,
      usageSource: "litellm",
    });
    for await (const _ of result.stream) void _;
    return (name: string, args: unknown) => captured.options[0]!.createToolExecFn(() => {})(name, args, "c1");
  }
  const KNOWLEDGE = { id: "k1", domain: "d", title: "t", content: "c", sourceType: "human" };

  it("an agent caller schedules brain to call knowledge_write: the run is denied (the agent owner fails the admin check)", async () => {
    const a = authority({ principals: { "node-ai": NODE_AI_USER }, roles: [[NODE_AI_USER, "knowledge:write"]] });
    const exec = await scheduledRun("brain", AGENT, a);
    expect(await exec("core__knowledge_write", KNOWLEDGE)).toMatchObject({ ok: false, receipt: { code: "policy_denied" } });
    expect(forTool(a.events, "core__knowledge_write")).toEqual([expect.objectContaining({ principal: NODE_AI_USER, subject: AGENT, decision: "deny", reason: "subject_not_admin" })]);
  });

  it("an admin owner's scheduled brain run may write", async () => {
    const a = authority({ principals: { "node-ai": NODE_AI_USER }, roles: [[NODE_AI_USER, "knowledge:write"]] });
    const exec = await scheduledRun("brain", ADMIN, a);
    expect(reached(await exec("core__knowledge_write", KNOWLEDGE))).toBe(true);
  });

  it("the system principal (governance and webhook runs) is no subject, so only the principal lock applies", async () => {
    const { COGNI_SYSTEM_PRINCIPAL_USER_ID } = await import("@cogni/node-shared");
    const a = authority({ principals: { prioritizer: PRIORITIZER_USER }, roles: [[PRIORITIZER_USER, "work_item:transition"]] });
    const exec = await scheduledRun("work-prioritizer", COGNI_SYSTEM_PRINCIPAL_USER_ID, a);
    expect(reached(await exec("core__work_item_transition", TRANSITION_ARGS))).toBe(true);
    expect(forTool(a.events, "core__work_item_transition")).toEqual([expect.objectContaining({ subject: null, decision: "allow" })]);
  });
});

describe("read_only tools need only the graph lock", () => {
  it("runs with no role, and logs no decision for the read tool", async () => {
    const a = authority({ principals: { "node-ai": NODE_AI_USER }, roles: [] });
    const seen: Array<{ tool: string; scope: unknown }> = [];
    const run = await start("brain", a, MEMBER, seen);
    expect(reached(await run.exec("core__knowledge_search", { domain: "d", query: "x" }))).toBe(true);
    expect(forTool(a.events, "core__knowledge_search")).toEqual([]);
  });
});

describe("DENIAL_IS_TERMINAL", () => {
  const KNOWLEDGE = { id: "k1", domain: "d", title: "t", content: "c", sourceType: "human" };

  it("offers the model only tools whose principal lock opens, and tells it what it lacks", async () => {
    const a = authority({ principals: { "node-ai": NODE_AI_USER }, roles: [[NODE_AI_USER, "schedule:manage"]] });
    const run = await start("brain", a, ADMIN);
    const offered = run.options!.toolContracts.map((c) => c.name);
    expect(offered).toContain("core__schedule_manage");
    expect(offered).toContain("core__knowledge_search");
    expect(offered).not.toContain("core__knowledge_write");
    expect(run.options!.request.configurable.toolIds).not.toContain("core__knowledge_write");
    const first = run.options!.request.messages[0];
    expect(first?.role).toBe("system");
    expect(first?.content).toContain("core__knowledge_write");
    expect(first?.content).not.toContain("core__schedule_manage");
  });

  it("adds no note when nothing was dropped", async () => {
    const a = authority({ principals: { "node-ai": NODE_AI_USER }, roles: [[NODE_AI_USER, "schedule:manage"], [NODE_AI_USER, "knowledge:write"]] });
    const run = await start("brain", a, ADMIN);
    expect(run.options!.request.messages.map((m) => m.role)).toEqual(["user"]);
  });

  async function terminalRun(roles: Array<[string, string]>, subject: string, adminCheck?: ProviderAgentAuthority["guardDeps"]["adminCheck"], modelCalls: { before: number; after: number } = { before: 0, after: 0 }) {
    captured.mode = "abort";
    try {
      captured.options.length = 0;
      const a = authority({ principals: { "node-ai": NODE_AI_USER }, roles });
      const auth: ProviderAgentAuthority = adminCheck ? { ...a, guardDeps: { ...a.guardDeps, adminCheck } } : a;
      const { source, bundle } = toolSource([]);
      const provider = new LangGraphInProcProvider(
        adapter, source, undefined, bundle,
        async () => ({ nodeId: "node", origin: "https://node.example" }),
        async () => ({}) as never,
        auth,
      );
      const logged: Array<Record<string, unknown>> = [];
      (provider as unknown as { log: unknown }).log = {
        debug: () => {}, info: () => {}, error: () => {},
        warn: (fields: Record<string, unknown>) => logged.push(fields),
      };
      const scope = { billing: { billingAccountId: "payer-1", virtualKeyId: "vk" }, usageSource: "litellm" as const, llmService: {} as never, subjectUserId: subject };
      const result = runInScope(scope, () =>
        provider.runGraph(
          { runId: "run-terminal", graphId: "langgraph:brain", messages: [{ role: "user", content: "go" }], modelRef: { providerKey: "platform", modelId: "m" } },
          { actorUserId: subject },
        ),
      );
      const events: AiEvent[] = [];
      const draining = (async () => { for await (const e of result.stream) events.push(e); })();
      while (captured.options.length === 0) await new Promise((r) => setTimeout(r, 1));
      // The real counting wrapper is `options.completionFn`: drive the model before and after the denial, as a looping graph would.
      const callModel = async () => {
        try {
          await captured.options[0]!.completionFn({ model: "m", messages: [] }).final;
        } catch {
          // the stub adapter returns nothing; only the count matters
        }
      };
      for (let i = 0; i < modelCalls.before; i++) await callModel();
      const exec = await runInScope(scope, () => captured.options[0]!.createToolExecFn(() => {})("core__knowledge_write", KNOWLEDGE, "c1"));
      for (let i = 0; i < modelCalls.after; i++) await callModel();
      await draining;
      return { exec, events, final: await result.final, logged, a };
    } finally {
      captured.mode = "finish";
    }
  }

  it("an exec-time denial ends the run cleanly: no error event, a fixed message, final.ok, one agent_run.denied", async () => {
    const run = await terminalRun([[NODE_AI_USER, "knowledge:write"]], MEMBER); // principal lock opens, subject lock fails
    expect(run.exec).toMatchObject({ ok: false, receipt: { code: "policy_denied", retryable: false } });
    expect(run.events.map((e) => e.type)).toEqual(["text_delta", "assistant_final", "done"]);
    expect(run.events.some((e) => e.type === "error")).toBe(false);
    expect(run.final).toMatchObject({ ok: true, finishReason: "stop" });
    expect(run.logged.filter((l) => l.event === "agent_run.denied")).toEqual([
      expect.objectContaining({ event: "agent_run.denied", tool: "core__knowledge_write", code: "policy_denied", reason: "subject_not_admin", modelCalls: 0, modelCallsAfterDenial: 0 }),
    ]);
  });

  it("counts model calls around the denial: modelCallsAfterDenial reads 1 when the model is called again after it", async () => {
    const run = await terminalRun([[NODE_AI_USER, "knowledge:write"]], MEMBER, undefined, { before: 1, after: 1 });
    expect(run.logged.filter((l) => l.event === "agent_run.denied")).toEqual([
      expect.objectContaining({ modelCalls: 2, modelCallsAfterDenial: 1 }),
    ]);
  });

  it("an outage during the call ends the run cleanly with the outage message and code", async () => {
    const run = await terminalRun([[NODE_AI_USER, "knowledge:write"]], ADMIN, async () => "unavailable");
    expect(run.exec).toMatchObject({ ok: false, receipt: { code: "authz_unavailable" } });
    expect(run.final).toMatchObject({ ok: true });
    const text = run.events.find((e) => e.type === "assistant_final") as { content: string } | undefined;
    expect(text?.content).toMatch(/can't check my permissions/);
    expect(run.logged.filter((l) => l.event === "agent_run.denied")).toEqual([expect.objectContaining({ event: "agent_run.denied", code: "authz_unavailable" })]);
  });
});

describe("DENIAL_IS_TERMINAL: a run with no interactive caller and nothing it may do makes no model call", () => {
  const denied = (logged: Array<Record<string, unknown>>) => logged.filter((l) => l.event === "agent_run.denied");

  it("a scheduled (decide) run whose every write tool is withheld ends at once: no runner, no model call, one agent_run.denied", async () => {
    const a = authority({ principals: { prioritizer: PRIORITIZER_USER }, roles: [] });
    const logged: Array<Record<string, unknown>> = [];
    const run = await start("work-prioritizer", a, ADMIN, [], { requestIntent: "decide" }, logged);
    expect(run.options).toBeUndefined(); // the graph runner (and so every model call) is never built
    expect(run.events.map((e) => e.type)).toEqual(["text_delta", "assistant_final", "done"]);
    expect(run.final).toMatchObject({ ok: true, finishReason: "stop" });
    expect(denied(logged)).toEqual([
      expect.objectContaining({ code: "policy_denied", reason: "no_permission", modelCalls: 0, modelCallsAfterDenial: 0, principal: "prioritizer" }),
    ]);
  });

  it("a run with no subject at all (webhook, governance) is treated the same way", async () => {
    const a = authority({ principals: { prioritizer: PRIORITIZER_USER }, roles: [] });
    const logged: Array<Record<string, unknown>> = [];
    const run = await start("work-prioritizer", a, undefined, [], {}, logged);
    expect(run.options).toBeUndefined();
    expect(denied(logged)).toEqual([expect.objectContaining({ reason: "no_permission", modelCalls: 0 })]);
  });

  it("an outage on the principal lock ends it the same way with the outage code", async () => {
    const a = authority({ principals: { prioritizer: PRIORITIZER_USER }, roles: [] });
    const down: ProviderAgentAuthority = {
      ...a,
      guardDeps: { ...a.guardDeps, withStore: async () => { throw new Error("db down"); } },
    };
    const logged: Array<Record<string, unknown>> = [];
    const run = await start("work-prioritizer", down, undefined, [], { requestIntent: "decide" }, logged);
    expect(run.options).toBeUndefined();
    expect(denied(logged)).toEqual([expect.objectContaining({ code: "authz_unavailable", reason: "no_permission" })]);
  });

  it("an interactive run in the same state still starts the model, with the system note, so it can say it lacks permission", async () => {
    const a = authority({ principals: { prioritizer: PRIORITIZER_USER }, roles: [] });
    const logged: Array<Record<string, unknown>> = [];
    const run = await start("work-prioritizer", a, MEMBER, [], {}, logged);
    expect(run.options).toBeDefined();
    expect(run.options!.request.messages[0]?.role).toBe("system");
    expect(denied(logged)).toEqual([]);
  });

  it("a scheduled run that may do at least one write still runs", async () => {
    const a = authority({ principals: { prioritizer: PRIORITIZER_USER }, roles: [[PRIORITIZER_USER, "work_item:transition"]] });
    const run = await start("work-prioritizer", a, ADMIN, [], { requestIntent: "decide" });
    expect(run.options).toBeDefined();
  });
});
