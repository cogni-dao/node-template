// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/tests/inproc/provider-audience`
 * Purpose: The sandbox shell audience at the package provider seam (shell-caller-run-claim): withhold, identity mismatch, start denial and the exec-time recheck. Also the injected-ports wiring of `createLangGraphInProcProvider` with no node.
 * Scope: Real provider and guard over an in-memory role store and real `@cogni/ai-tools` contracts. The graph runner is the injected stub; no LLM, no database, no app.
 * Invariants: SHELL_NEEDS_AUDIENCE_AND_RUN_CLAIM, DENIAL_IS_TERMINAL, WITHHOLD_DO_NOT_FAIL
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/shell-caller-run-claim
 */

import type { AgentGrantsStore } from "@cogni/agent-grants";
import type { AiEvent } from "@cogni/ai-core";
import {
  CORE_TOOL_BUNDLE,
  type CatalogBoundTool,
  SANDBOX_SHELL_NAME,
  toBoundToolRuntime,
} from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../../src/catalog";
import { LANGGRAPH_CATALOG } from "../../src/catalog";
import { INPROC_EVENTS } from "../../src/inproc/provider/events";
import { createLangGraphInProcProvider } from "../../src/inproc/provider/provider";
import type {
  CodingCallerPolicy,
  InProcProviderDeps,
} from "../../src/inproc/provider/types";
import type { InProcRunnerOptions } from "../../src/inproc/types";

const AUDIENCE = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const NODE_AI = "00000000-0000-4000-8000-0000000000aa";
const SHELL_REACHED = "shell_reached";

const GRAPH: CatalogEntry = {
  displayName: "Shell graph",
  description: "a graph that lists the shell and a read tool",
  principal: "node-ai",
  toolIds: ["core__get_current_time", SANDBOX_SHELL_NAME],
  stepBudget: 250,
  graphFactory: LANGGRAPH_CATALOG.cogni?.graphFactory as CatalogEntry["graphFactory"],
};

function setup(opts: {
  subject?: string | undefined;
  roles?: string[];
  ready?: boolean;
  audience?: () => string[];
}) {
  const logged: Array<Record<string, unknown>> = [];
  const runnerOptions: InProcRunnerOptions[] = [];
  let shellCalls = 0;
  let audience = opts.audience ?? (() => [AUDIENCE]);
  const roles = opts.roles ?? ["sandbox:exec"];
  const store: AgentGrantsStore = {
    hasLiveRole: async (_p, s) => roles.includes(s),
    liveScopes: async (_p, scopes) => scopes.filter((s) => roles.includes(s)),
    listLiveRoles: async () => [],
    findInternalPrincipal: async () => null,
    insertRole: async () => true,
    revokeRole: async () => true,
  };
  const bundle = CORE_TOOL_BUNDLE.map((tool) => ({
    contract: tool.contract,
    implementation: {
      execute: async () => {
        if (tool.contract.name === SANDBOX_SHELL_NAME) shellCalls += 1;
        throw new Error(SHELL_REACHED);
      },
    },
  })) as CatalogBoundTool[];
  const runtimes = new Map(bundle.map((t) => [t.contract.name, toBoundToolRuntime(t)]));
  const abort = new AbortController();
  const coding: CodingCallerPolicy = {
    isCodingActor: (id) => audience().includes(id),
    prerequisitesReady: () => opts.ready ?? true,
  };
  let completionCalls = 0;
  const deps: InProcProviderDeps = {
    catalog: { shell: GRAPH },
    completion: {
      executeCompletionUnit: () => {
        completionCalls += 1;
        throw new Error("no model call expected");
      },
    },
    tools: {
      getBoundTool: (id) => runtimes.get(id),
      listToolSpecs: () => [...runtimes.values()].map((r) => r.spec),
      hasToolId: (id) => runtimes.has(id),
    },
    toolBundle: bundle,
    scope: {
      current: () => ({
        subjectUserId: opts.subject,
        accountId: "payer",
        abortSignal: abort.signal,
        runAs: (_identity, fn) => fn(),
      }),
    },
    authority: {
      resolvePrincipal: async () => NODE_AI,
      guardDeps: {
        withStore: (fn) => fn(store),
        adminCheck: async () => "denied",
      },
    },
    log: {
      debug: () => {},
      info: () => {},
      warn: (f) => logged.push(f as Record<string, unknown>),
      error: (f) => logged.push(f as Record<string, unknown>),
    },
    coding,
    createRunner: (options) => {
      runnerOptions.push(options);
      return {
        stream: (async function* () {
          yield { type: "done" as const };
        })(),
        final: Promise.resolve({ ok: true as const }),
      };
    },
  };
  async function run(ctx: { actorUserId?: string; runClaimVerified?: true; unattended?: boolean }, withCoding = true) {
    const provider = createLangGraphInProcProvider(withCoding ? deps : { ...deps, coding: undefined });
    const result = provider.runGraph(
      {
        runId: "run-1",
        graphId: "langgraph:shell",
        messages: [{ role: "user", content: "go" }],
        modelRef: { providerKey: "platform", modelId: "m" },
      },
      ctx,
    );
    const events: AiEvent[] = [];
    for await (const event of result.stream) events.push(event);
    return { events, final: await result.final };
  }
  return {
    run,
    logged,
    runnerOptions,
    abort,
    shellCalls: () => shellCalls,
    completionCalls: () => completionCalls,
    setAudience: (ids: string[]) => {
      audience = () => ids;
    },
  };
}

const events = (logged: Array<Record<string, unknown>>, name: string) =>
  logged.filter((l) => l.event === name);
const offeredTools = (o: InProcRunnerOptions | undefined) => o?.toolContracts.map((c) => c.name);

describe("shell audience (shell-caller-run-claim)", () => {
  it("no coding policy: the shell is offered as before", async () => {
    const t = setup({ subject: AUDIENCE });
    await t.run({ actorUserId: AUDIENCE }, false);
    expect(offeredTools(t.runnerOptions[0])).toEqual(["core__get_current_time", SANDBOX_SHELL_NAME]);
  });

  it("withhold, do not fail: an unclaimed run keeps working without the shell", async () => {
    const t = setup({ subject: AUDIENCE });
    const r = await t.run({ actorUserId: AUDIENCE });
    expect(r.final.ok).toBe(true);
    expect(offeredTools(t.runnerOptions[0])).toEqual(["core__get_current_time"]);
    expect(t.runnerOptions[0]?.request.configurable.toolIds).toEqual(["core__get_current_time"]);
    expect(events(t.logged, INPROC_EVENTS.AGENT_CODING_SHELL_WITHHELD)).toEqual([
      expect.objectContaining({ reason: "unclaimed" }),
    ]);
    // A withheld shell is not named in the withheld-tool note.
    expect(t.runnerOptions[0]?.request.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("a claimed run by a caller outside the audience loses the shell and still runs", async () => {
    const t = setup({ subject: OTHER });
    const r = await t.run({ actorUserId: OTHER, runClaimVerified: true });
    expect(r.final.ok).toBe(true);
    expect(offeredTools(t.runnerOptions[0])).toEqual(["core__get_current_time"]);
    expect(events(t.logged, INPROC_EVENTS.AGENT_CODING_SHELL_WITHHELD)).toEqual([
      expect.objectContaining({ reason: "not_audience" }),
    ]);
  });

  it("a system run with no actor loses the shell and still runs", async () => {
    const t = setup({ subject: undefined });
    const r = await t.run({ runClaimVerified: true, unattended: true });
    expect(r.final.ok).toBe(true);
    expect(offeredTools(t.runnerOptions[0])).toEqual(["core__get_current_time"]);
  });

  it("a claimed audience actor gets the shell", async () => {
    const t = setup({ subject: AUDIENCE });
    const r = await t.run({ actorUserId: AUDIENCE, runClaimVerified: true });
    expect(r.final.ok).toBe(true);
    expect(offeredTools(t.runnerOptions[0])).toEqual(["core__get_current_time", SANDBOX_SHELL_NAME]);
    expect(events(t.logged, INPROC_EVENTS.AGENT_CODING_SHELL_WITHHELD)).toEqual([]);
  });

  it("an audience actor whose id differs from the subject fails before any effect with internal", async () => {
    const t = setup({ subject: OTHER });
    const r = await t.run({ actorUserId: AUDIENCE, runClaimVerified: true });
    expect(r.events).toEqual([{ type: "error", error: "internal" }, { type: "done" }]);
    expect(r.final).toMatchObject({ ok: false, error: "internal" });
    expect(t.runnerOptions).toEqual([]);
    expect(events(t.logged, INPROC_EVENTS.AGENT_RUN_START_DENIED)).toEqual([
      expect.objectContaining({ reason: "identity_mismatch" }),
    ]);
  });

  it("a claimed audience actor with the prerequisites missing ends cleanly before any model call", async () => {
    const t = setup({ subject: AUDIENCE, ready: false });
    const r = await t.run({ actorUserId: AUDIENCE, runClaimVerified: true });
    expect(r.final).toMatchObject({ ok: true, finishReason: "stop" });
    expect(r.events.map((e) => e.type)).toEqual(["text_delta", "assistant_final", "done"]);
    expect(t.runnerOptions).toEqual([]);
    expect(t.completionCalls()).toBe(0);
    expect(events(t.logged, INPROC_EVENTS.AGENT_RUN_START_DENIED)).toEqual([
      expect.objectContaining({ reason: "sandbox_unavailable" }),
    ]);
  });

  it("a claimed audience actor with sandbox:exec Off ends cleanly before any model call (policy_denied)", async () => {
    const t = setup({ subject: AUDIENCE, roles: [] });
    const r = await t.run({ actorUserId: AUDIENCE, runClaimVerified: true });
    expect(r.final).toMatchObject({ ok: true });
    expect(t.runnerOptions).toEqual([]);
    expect(events(t.logged, INPROC_EVENTS.AGENT_RUN_START_DENIED)).toEqual([
      expect.objectContaining({ reason: "policy_denied" }),
    ]);
  });

  it("the exec-time recheck passes while every condition still holds, and the tool body runs", async () => {
    const t = setup({ subject: AUDIENCE });
    await t.run({ actorUserId: AUDIENCE, runClaimVerified: true });
    const options = t.runnerOptions[0] as InProcRunnerOptions;
    await options.createToolExecFn(() => {})(SANDBOX_SHELL_NAME, { command: "echo hi" }, "c1");
    expect(t.shellCalls()).toBe(1);
    expect(options.request.abortSignal?.aborted).toBe(false);
  });

  it("the exec-time recheck: an audience change after run start denies the shell before the tool body runs", async () => {
    const t = setup({ subject: AUDIENCE });
    await t.run({ actorUserId: AUDIENCE, runClaimVerified: true });
    const options = t.runnerOptions[0] as InProcRunnerOptions;
    const exec = options.createToolExecFn(() => {});
    t.setAudience([]);
    const result = await exec(SANDBOX_SHELL_NAME, { command: "echo hi" }, "c1");
    expect(result.ok).toBe(false);
    expect(t.shellCalls()).toBe(0);
    expect(options.request.abortSignal?.aborted).toBe(true);
    expect(events(t.logged, INPROC_EVENTS.AGENT_TOOL_AUTHZ)).toEqual([
      expect.objectContaining({ reason: "coding_recheck_failed", tool: SANDBOX_SHELL_NAME }),
    ]);
  });
});

describe("the entry's step budget reaches the runner only for a run with a caller waiting", () => {
  it("an interactive run gets the entry's budget and tells the hooks it is interactive", async () => {
    const t = setup({ subject: AUDIENCE });
    await t.run({ actorUserId: AUDIENCE, runClaimVerified: true });
    expect(t.runnerOptions[0]).toMatchObject({ recursionLimit: 250, interactive: true });
  });

  it("a scheduled tick keeps the default budget", async () => {
    const t = setup({ subject: AUDIENCE });
    await t.run({ actorUserId: AUDIENCE, unattended: true });
    expect(t.runnerOptions[0]?.recursionLimit).toBeUndefined();
    expect(t.runnerOptions[0]?.interactive).toBe(false);
  });
});
