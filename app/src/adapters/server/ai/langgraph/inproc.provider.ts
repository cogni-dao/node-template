// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/langgraph/inproc.provider`
 * Purpose: LangGraph in-process graph provider for Next.js runtime.
 * Scope: Routes graph execution to package runner. Does NOT import @langchain/* directly — all LangChain in package.
 * Invariants:
 *   - NO_LANGCHAIN_IN_SRC: No @langchain imports; delegates to package runner
 *   - GRAPH_ID_NAMESPACED: graphId format is "langgraph:${graphName}"
 *   - CATALOG_SINGLE_SOURCE_OF_TRUTH: Uses catalog from @cogni/langgraph-graphs
 *   - NODE_BUNDLE_IS_CANONICAL: Resolves BoundTool from injected node bundle (CORE_TOOL_BUNDLE [+ POLY_TOOL_BUNDLE for poly]); never iterates the global TOOL_CATALOG (which is per-package and can drift behind per-node bundles).
 *   - DENY_BY_DEFAULT: Tool policy explicitly provided per graph
 *   - MCP_VIA_ASYNC_SOURCE: MCP tools resolved via async getMcpToolSource() function (shared cache with reconnect-on-error)
 *   - SECRET_ARGS_MASK_MODEL_CALLS: a run that offers any tool whose contract declares `secretArgs` masks every model
 *     call of that run (`maskContent` on the LlmCaller), because the model's own tool call and the next call that resends
 *     it carry the raw argument to the gateway's Langfuse logger. The flag is run-scoped and set once the offered tools are known.
 *   - CATALOG_REPORT_SEAM: a catalog entry's `report` (not a graph name) decides whether the run's structured
 *     telemetry is logged as registered events and echoed onto the stream; graphs never touch the logger or ALS.
 * Side-effects: IO (executes graphs via package runner, MCP tool resolution via HTTP)
 * Notes: Discovery is in LangGraphInProcAgentCatalogProvider, not here.
 * Links: https://node-template.cognidao.org/knowledge/graph-execution-invariants, https://node-template.cognidao.org/knowledge/graph-execution-invariants
 * @internal
 */

import {
  type GuardDeps,
  guardTools,
  offeredToolIds,
  type RunIdentity,
  type TerminalDenial,
  type ToolRequires,
} from "@cogni/agent-grants";
import type { AiEvent, BoundToolRuntime, ToolSourcePort } from "@cogni/ai-core";
import {
  createStaticToolSourceFromRecord,
  createToolAllowlistPolicy,
  createToolRunner,
} from "@cogni/ai-core";
import { type CatalogBoundTool, declaresSecretArgs } from "@cogni/ai-tools";
import {
  type CompletionFn,
  type CreateGraphFn,
  createInProcGraphRunner,
  type GraphReportDecl,
  type GraphResult,
  graphReportDelta,
  graphReportLogFields,
  type InProcGraphRequest,
  LANGGRAPH_CATALOG,
  type ToolExecFn,
} from "@cogni/langgraph-graphs";
import { trace } from "@opentelemetry/api";
import type { Logger } from "pino";
import {
  getExecutionScope,
  runInScope,
} from "@/adapters/server/ai/execution-scope";
import type {
  AiExecutionErrorCode,
  CompletionFinalResult,
  ExecutionContext,
  GraphExecutorPort,
  GraphFinal,
  GraphRunRequest,
  GraphRunResult,
  LlmToolDefinition,
} from "@/ports";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";
import { isModelAllowed } from "@/shared/ai/model-catalog.server";

import type { CompletionUnitParams } from "../inproc-completion-unit.adapter";

import type { LangGraphCatalog } from "./catalog";

/**
 * Provider ID for LangGraph in-process execution.
 */
export const LANGGRAPH_PROVIDER_ID = "langgraph" as const;

/**
 * Adapter interface for executing completion units.
 * Matches InProcCompletionUnitAdapter.executeCompletionUnit signature.
 */
export interface CompletionUnitAdapter {
  executeCompletionUnit(params: CompletionUnitParams): {
    stream: AsyncIterable<AiEvent>;
    final: Promise<CompletionFinalResult>;
  };
}

/**
 * Catalog entry shape (matches LangGraphCatalogEntry<CreateGraphFn>).
 * Per NODE_BUNDLE_IS_CANONICAL: tools referenced by ID, resolved from the injected node bundle.
 */
interface ProviderCatalogEntry {
  readonly displayName: string;
  readonly description: string;
  readonly toolIds: readonly string[];
  readonly mcpServerIds?: readonly string[];
  /** Internal agent principal slug this graph acts as (catalog `principal`). */
  readonly principal?: string;
  readonly graphFactory: CreateGraphFn;
  readonly systemPrompt?: string;
  readonly program?: "cogni" | "work-review" | "work-closeout";
  /** Graph-owned run report to log + echo on the stream (CatalogEntry.report). */
  readonly report?: GraphReportDecl;
}

/**
 * The node's tool-authority wiring (bootstrap/agent-authority.ts), seen structurally so adapters do not
 * import bootstrap. Absent means no principal can be resolved and every scoped tool is denied.
 */
export interface ProviderAgentAuthority {
  /** The seeded user id for a catalog principal slug, or null when no row exists. */
  resolvePrincipal(slug: string): Promise<string | null>;
  readonly guardDeps: Omit<GuardDeps, "runAs">;
}

/** The one fixed outcome a denied run ends with (DENIAL_IS_TERMINAL). */
function denialMessage(code: "policy_denied" | "authz_unavailable"): string {
  return code === "authz_unavailable"
    ? "I can't check my permissions right now, so I stopped. Try again later."
    : "I don't have permission to do that on this node, so I stopped. Ask a node admin to allow it.";
}

/** With no authority wired, the guard can reach no store and no admin check: scoped tools deny. */
const DENY_ALL_GUARD_DEPS: Omit<GuardDeps, "runAs"> = {
  withStore: async () => {
    throw new Error("agent_authority_not_configured");
  },
  adminCheck: async () => "unavailable",
};

/**
 * LangGraph in-process provider.
 *
 * Routes graph execution to package runner (createInProcGraphRunner).
 * All LangChain logic is in the package — this provider is LangChain-free.
 *
 * Per GRAPH_LLM_VIA_COMPLETION: all LLM calls go through adapter.executeCompletionUnit
 * for billing/telemetry centralization.
 *
 * Note: Discovery (listAgents) is in LangGraphInProcAgentCatalogProvider.
 */
export async function resolveNodeSourceContext(
  required: boolean,
  nodeId: string,
  origin: string | undefined,
  mission: string | null | undefined,
  buildSha: string | undefined,
  knowledge: { listGoverningIndex: () => Promise<NonNullable<NonNullable<import("@cogni/langgraph-graphs/inproc").CreateGraphOptions["sourceContext"]>["governingIndex"]>> } | undefined,
) {
  if (required && (!mission || !origin || !knowledge)) {
    throw new Error("node_source_context_unavailable");
  }
  return {
    nodeId,
    ...(origin ? { origin } : {}),
    ...(mission ? { mission: { content: mission, sourceRef: ".cogni/repo-spec.yaml", buildSha: buildSha ?? null } } : {}),
    governingIndex: origin && knowledge ? await knowledge.listGoverningIndex() : [],
  };
}

export class LangGraphInProcProvider implements GraphExecutorPort {
  readonly providerId = LANGGRAPH_PROVIDER_ID;
  private readonly log: Logger;
  private readonly catalog: LangGraphCatalog<CreateGraphFn>;
  private readonly boundToolMap: ReadonlyMap<string, CatalogBoundTool>;
  /** Ids of node-bundle tools whose contract declares `secretArgs`. */
  private readonly secretToolIds: ReadonlySet<string>;

  constructor(
    private readonly adapter: CompletionUnitAdapter,
    private readonly toolSource: ToolSourcePort,
    private readonly getMcpToolSource: () => Promise<ToolSourcePort | null> = () =>
      Promise.resolve(null),
    nodeBundle: readonly CatalogBoundTool[] = [],
    private readonly sourceContext?: (required: boolean) => Promise<
      NonNullable<
        import("@cogni/langgraph-graphs/inproc").CreateGraphOptions["sourceContext"]
      >
    >,
    private readonly getPersistence?: () => Promise<
      NonNullable<
        import("@cogni/langgraph-graphs/inproc").InProcRunnerOptions["persistence"]
      >
    >,
    private readonly authority?: ProviderAgentAuthority,
    /** Graphs this node adds to the package catalog (never overrides a package entry). */
    nodeCatalog: LangGraphCatalog<CreateGraphFn> = {},
  ) {
    this.log = makeLogger({ component: "LangGraphInProcProvider" });
    this.boundToolMap = new Map(nodeBundle.map((bt) => [bt.contract.name, bt]));
    this.secretToolIds = new Set(
      nodeBundle
        .filter((bt) => declaresSecretArgs(bt.contract))
        .map((bt) => bt.contract.name),
    );

    // Use catalog from package (single source of truth), plus this node's own graphs
    this.catalog = {
      ...nodeCatalog,
      ...(LANGGRAPH_CATALOG as LangGraphCatalog<CreateGraphFn>),
    };

    this.log.debug(
      {
        graphCount: Object.keys(this.catalog).length,
        graphs: Object.keys(this.catalog),
      },
      "LangGraphInProcProvider initialized",
    );
  }

  runGraph(req: GraphRunRequest, ctx?: ExecutionContext): GraphRunResult {
    const { runId, messages, modelRef, graphId } = req;
    const model = modelRef.modelId;
    const scope = getExecutionScope();
    const requestId = ctx?.requestId ?? req.runId;

    // Extract graph name from graphId (e.g., "langgraph:cogni" → "cogni")
    const graphName = this.extractGraphName(graphId);
    if (!graphName) {
      this.log.error({ runId, graphId }, "Invalid graphId format");
      // Client error: malformed graphId
      return this.createErrorResult(runId, requestId, "invalid_request");
    }

    const entry = this.catalog[graphName] as ProviderCatalogEntry | undefined;
    if (!entry) {
      this.log.error({ runId, graphName }, "Graph not found in catalog");
      // Client error: graph doesn't exist
      return this.createErrorResult(runId, requestId, "not_found");
    }

    this.log.debug(
      { runId, graphName, model, messageCount: messages.length },
      "LangGraphInProcProvider.runGraph routing to package runner",
    );

    // Run-scoped mask flag: set once the offered tools are known (below), read on every model call.
    const modelCallMask = { on: false };

    // Create completion function wrapping adapter
    const completionFn = this.createCompletionFn(req, modelCallMask);

    // P0 Contract: undefined => catalog default, [] => deny-all, [...] => exact
    const catalogToolIds = entry.toolIds;
    const toolIds: readonly string[] = req.toolIds ?? catalogToolIds;
    if (req.toolIds === undefined) {
      this.log.debug(
        { runId, graphName, catalogToolIds },
        "toolIds undefined; using catalog default per P0 contract",
      );
    }

    // Resolve BoundToolRuntime from injected toolSource (per TOOL_SOURCE_RETURNS_BOUND_TOOL)
    // Per CAPABILITY_INJECTION: toolSource contains real implementations with I/O
    const runtimeTools: Record<string, BoundToolRuntime> = {};
    for (const toolId of catalogToolIds) {
      const runtime = this.toolSource.getBoundTool(toolId);
      if (runtime) {
        runtimeTools[toolId] = runtime;
      } else {
        this.log.error(
          { runId, graphName, toolId },
          "Tool not found in toolSource; graph misconfigured",
        );
      }
    }

    // Resolve MCP tools if this graph declares mcpServerIds.
    // getMcpToolSource() is async (shared cache with reconnect-on-error),
    // so we wrap the graph execution in a promise and stream from it.
    const mcpServerIds = entry.mcpServerIds ?? [];

    // Async helper: resolve MCP tools then execute graph
    const resolveMcpAndExecute = async (): Promise<{
      stream: AsyncIterable<AiEvent>;
      final: Promise<GraphResult>;
    }> => {
      // Principal lock: the catalog names the agent this graph acts as. No seed row denies the run
      // before any tool runs (SCOPED_TOOL_NEEDS_PRINCIPAL; fail closed).
      let principalId: string | undefined;
      if (entry.principal) {
        try {
          principalId =
            (await this.authority?.resolvePrincipal(entry.principal)) ??
            undefined;
        } catch (error) {
          // The principal store is down: fail closed, and say so as `authz_unavailable` (not a generic internal error).
          this.log.error(
            {
              event: EVENT_NAMES.AGENT_TOOL_AUTHZ,
              runId,
              graphName,
              principal: entry.principal,
              decision: "unavailable",
              code: "authz_unavailable",
              reason: "principal_lookup_failed",
              errorName: error instanceof Error ? error.name : "unknown",
            },
            "graph principal lookup failed; run denied",
          );
          throw error;
        }
        if (!principalId) {
          this.log.error(
            {
              event: EVENT_NAMES.AGENT_TOOL_AUTHZ,
              runId,
              graphName,
              principal: entry.principal,
              decision: "deny",
              code: "policy_denied",
              reason: "principal_not_seeded",
            },
            "graph principal has no seed row; run denied",
          );
          throw new Error("agent_principal_not_seeded");
        }
      }
      const mcpToolIds: string[] = [];
      if (mcpServerIds.length > 0) {
        const mcpToolSource = await this.getMcpToolSource();
        if (mcpToolSource) {
          for (const serverId of mcpServerIds) {
            for (const spec of mcpToolSource.listToolSpecs()) {
              if (spec.name.startsWith(`${serverId}__`)) {
                const runtime = mcpToolSource.getBoundTool(spec.name);
                if (runtime) {
                  runtimeTools[spec.name] = runtime;
                  mcpToolIds.push(spec.name);
                }
              }
            }
          }
          if (mcpToolIds.length > 0) {
            this.log.debug(
              {
                runId,
                graphName,
                mcpServerIds,
                mcpToolCount: mcpToolIds.length,
              },
              "Resolved MCP tools for graph",
            );
          }
        }
      }

      // The contracts' `requires` are the only input that names scopes. An MCP tool has none yet, so it is
      // denied (it is external_side_effect) until MCP server scopes merge into requiresById.
      const requiresById: Record<string, ToolRequires> = {};
      for (const [id, bound] of this.boundToolMap) {
        if (bound.contract.requires) requiresById[id] = bound.contract.requires;
      }
      const guardScope = {
        runId,
        principalId,
        subjectUserId: scope.subjectUserId,
        payer: scope.billing.billingAccountId,
      };
      const guardBase = this.authority?.guardDeps ?? DENY_ALL_GUARD_DEPS;

      // DENIAL_IS_TERMINAL (1/2): the model is never offered a tool whose principal lock already fails.
      const { offered, excluded } = await offeredToolIds(
        Object.entries(runtimeTools).map(([id, rt]) => ({
          id,
          effect: rt.spec.effect,
        })),
        requiresById,
        guardScope,
        guardBase
      );
      const offeredSet = new Set(offered);

      if (entry.program && !this.sourceContext) {
        throw new Error("node_source_context_unavailable");
      }

      // A run with no interactive caller (a validated schedule tick, or one with no subject such as a webhook) whose
      // every write tool is withheld has nothing it may do: end it now, with no model call, instead of paying for a
      // "no permission" answer on every tick. An interactive run keeps the system note below and may answer once.
      const writeTools = Object.entries(runtimeTools).filter(
        ([, rt]) => rt.spec.effect !== "read_only"
      );
      const noInteractiveCaller =
        ctx?.unattended === true || !scope.subjectUserId;
      const endWithoutModel =
        noInteractiveCaller &&
        writeTools.length > 0 &&
        writeTools.every(([id]) => !offeredSet.has(id));
      for (const id of Object.keys(runtimeTools)) {
        if (!offeredSet.has(id)) delete runtimeTools[id];
      }
      const offeredToolIdList = toolIds.filter((id) => offeredSet.has(id));
      const offeredMcpToolIds = mcpToolIds.filter((id) => offeredSet.has(id));

      // Combined tool IDs for allowlist: native catalog tools + MCP tools
      const allToolIds = [...offeredToolIdList, ...offeredMcpToolIds];

      // SECRET_ARGS_MASK_MODEL_CALLS: any offered secret tool masks every model call of this run.
      modelCallMask.on = offeredToolIdList.some((id) =>
        this.secretToolIds.has(id),
      );

      // Get catalog tools for contract extraction from the injected node bundle
      // (per NODE_BUNDLE_IS_CANONICAL — TOOL_CATALOG only has core tools post-bug.0319 ckpt 2)
      const catalogTools = catalogToolIds
        .filter((id) => offeredSet.has(id))
        .map((id) => this.boundToolMap.get(id))
        .filter((bt): bt is NonNullable<typeof bt> => bt !== undefined);

      // DENIAL_IS_TERMINAL (2/2): an exec-time denial ends the run cleanly. The run's abort signal chains the caller's.
      const runAbort = new AbortController();
      const callerSignal = scope.abortSignal;
      if (callerSignal) {
        if (callerSignal.aborted) runAbort.abort(callerSignal.reason);
        else
          callerSignal.addEventListener(
            "abort",
            () => runAbort.abort(callerSignal.reason),
            { once: true }
          );
      }
      let terminal: TerminalDenial | null = null;
      let modelCalls = 0;
      let modelCallsAfterDenial = 0;
      const countedCompletionFn: typeof completionFn = (params) => {
        modelCalls += 1;
        if (terminal) modelCallsAfterDenial += 1;
        return completionFn(params);
      };

      // Create tool execution function factory
      // Policy allowlist includes both native and MCP tool IDs
      const createToolExecFn = (emit: (e: AiEvent) => void): ToolExecFn => {
        const policy = createToolAllowlistPolicy(allToolIds);
        // GUARD_COVERS_EVERY_RUNNER_SITE: every runtime (native + MCP) passes through the guard.
        const guarded = guardTools(runtimeTools, requiresById, guardScope, {
          ...guardBase,
          onTerminalDenial: (denial) => {
            if (terminal) return;
            terminal = denial;
            runAbort.abort(new Error("agent_tool_denied"));
          },
          runAs: (identity: RunIdentity, fn) =>
            runInScope(
              {
                ...scope,
                ...(identity.principalId
                  ? { principalId: identity.principalId }
                  : {}),
                ...(identity.subjectUserId
                  ? { subjectUserId: identity.subjectUserId }
                  : {}),
              },
              fn
            ),
        });
        const source = createStaticToolSourceFromRecord(guarded);
        const toolRunner = createToolRunner(source, emit, {
          policy,
          ctx: { runId },
        });

        return async (name, args, toolCallId) => {
          const result =
            toolCallId !== undefined
              ? await toolRunner.exec(name, args, {
                  modelToolCallId: toolCallId,
                })
              : await toolRunner.exec(name, args);
          if (!result.ok) {
            // A secret tool's error text is scrubbed, but no text of it is logged: the code and receipt code suffice.
            const secretTool = this.secretToolIds.has(name);
            this.log.warn(
              {
                event: EVENT_NAMES.AI_TOOL_CALL_ERROR,
                runId,
                graphName,
                tool: name,
                errorCode: result.errorCode,
                ...(secretTool
                  ? result.receipt
                    ? { receiptCode: result.receipt.code }
                    : {}
                  : { safeMessage: result.safeMessage.slice(0, 300) }),
              },
              "tool call failed",
            );
          }
          return result;
        };
      };

      const toolContracts = catalogTools.map((bt) => bt.contract);

      const mcpToolSpecs = offeredMcpToolIds
        .map((id) => runtimeTools[id]?.spec)
        .filter((s): s is NonNullable<typeof s> => s !== undefined);

      const traceId =
        trace.getActiveSpan()?.spanContext().traceId ??
        "00000000000000000000000000000000";
      const runnerRequest: InProcGraphRequest = {
        runId,
        // A run that lost tools says so up front, so the model stops instead of hunting for another way (a
        // denied run must not loop). Only tools the graph lists are named.
        messages: (excluded.length > 0
          ? [
              {
                role: "system",
                content: `You have no permission to use: ${excluded.map((e) => e.tool).join(", ")}. If the task needs one of them, say so in one sentence and stop. Do not look for another way.`,
              },
              ...messages,
            ]
          : messages) as InProcGraphRequest["messages"],
        abortSignal: runAbort.signal,
        ...(traceId !== undefined && { traceId }),
        ...(requestId !== undefined && { ingressRequestId: requestId }),
        configurable: { model, toolIds: offeredToolIdList },
      };

      if (entry.program && !this.sourceContext) {
        throw new Error("node_source_context_unavailable");
      }
      // Resolve the node source first so a mission graph still fails closed when its hub context is missing.
      const resolvedSource =
        entry.program && this.sourceContext
          ? await this.sourceContext(Boolean(entry.program))
          : undefined;
      if (endWithoutModel) {
        const code = excluded.every((e) => e.code === "authz_unavailable")
          ? ("authz_unavailable" as const)
          : ("policy_denied" as const);
        this.log.warn(
          {
            event: EVENT_NAMES.AGENT_RUN_DENIED,
            runId,
            graphName,
            principal: entry.principal ?? null,
            tools: writeTools.map(([id]) => id),
            code,
            reason: "no_permission",
            modelCalls: 0,
            modelCallsAfterDenial: 0,
          },
          "run ended without a model call: every write tool is withheld"
        );
        const text = denialMessage(code);
        return {
          stream: (async function* () {
            yield { type: "text_delta" as const, delta: text };
            yield { type: "assistant_final" as const, content: text };
            yield { type: "done" as const } as AiEvent;
          })(),
          final: Promise.resolve({
            ok: true,
            finishReason: "stop",
            content: text,
          } as GraphResult),
        };
      }
      const inner = createInProcGraphRunner({
        createGraph: entry.graphFactory,
        completionFn: countedCompletionFn,
        createToolExecFn,
        toolContracts,
        ...(mcpToolSpecs.length > 0 && { mcpToolSpecs }),
        request: runnerRequest,
        ...(entry.program &&
          this.getPersistence && {
            persistence: await this.getPersistence(),
          }),
        ...(entry.program !== undefined && { program: entry.program }),
        ...(ctx?.actorUserId ? { trustedActorId: ctx.actorUserId } : {}),
        ...(entry.program && { trustedProgramId: entry.program }),
        ...(resolvedSource !== undefined && { sourceContext: resolvedSource }),
        ...(req.responseFormat !== undefined && {
          responseFormat: req.responseFormat,
        }),
        ...(entry.systemPrompt !== undefined && {
          systemPrompt: entry.systemPrompt,
        }),
      });
      const runner = this.endDeniedRunCleanly(inner, {
        runId,
        graphName,
        principal: entry.principal ?? null,
        denial: () => terminal,
        modelCalls: () => ({ modelCalls, modelCallsAfterDenial }),
      });
      // CatalogEntry.report: the graph's own report → registry events (graphs have no logger).
      const report = entry.report;
      if (report) {
        void runner.final
          .then((result) => {
            for (const fields of graphReportLogFields(
              report,
              runId,
              result.structuredOutput,
            )) {
              this.log.info(fields, "graph report");
            }
          })
          .catch(() => {
            // Run failure is already logged by the inproc error path.
          });
      }
      return runner;
    };

    // Execute: resolve MCP (if needed) then run graph.
    // Returns {stream, final} synchronously per GraphRunResult contract;
    // the inner async generator awaits the promise.
    const innerResult = resolveMcpAndExecute();
    const report = entry.report;

    const stream = (async function* () {
      let inner: Awaited<ReturnType<typeof resolveMcpAndExecute>>;
      try {
        inner = await innerResult;
      } catch {
        yield {
          type: "error" as const,
          error: "internal" as AiExecutionErrorCode,
        };
        yield { type: "done" as const };
        return;
      }
      for await (const event of inner.stream) {
        // CatalogEntry.report: echo the telemetry as one text delta just before `done`.
        if (event.type === "done" && report) {
          const delta = graphReportDelta((await inner.final).structuredOutput);
          if (delta) yield { type: "text_delta" as const, delta };
        }
        yield event;
      }
    })();

    const final = innerResult.then(
      (r) => this.mapToGraphFinal(r.final, runId, requestId, graphName),
      () =>
        ({
          ok: false as const,
          runId,
          requestId,
          error: "internal",
        }) as const,
    );

    // mapToGraphFinal returns Promise<GraphFinal>, so final is Promise<Promise<GraphFinal> | GraphFinal>
    // Flatten with .then()
    const flatFinal = final.then((f) => f);

    return { stream, final: flatFinal };
  }

  /**
   * DENIAL_IS_TERMINAL. When the guard denied a tool, the run was aborted (see `onTerminalDenial`). The runner reports an
   * abort as an error; this turns it into a clean completion: no error event, one fixed assistant message, `final.ok`.
   * Logs one `agent_run.denied` event with the model-call counts. A run with no denial passes through untouched.
   */
  private endDeniedRunCleanly(
    inner: { stream: AsyncIterable<AiEvent>; final: Promise<GraphResult> },
    info: {
      runId: string;
      graphName: string;
      principal: string | null;
      denial: () => TerminalDenial | null;
      modelCalls: () => { modelCalls: number; modelCallsAfterDenial: number };
    }
  ): { stream: AsyncIterable<AiEvent>; final: Promise<GraphResult> } {
    const log = this.log;
    const message = (denial: TerminalDenial) => denialMessage(denial.code);
    let logged = false;
    const logOnce = (denial: TerminalDenial) => {
      if (logged) return;
      logged = true;
      log.warn(
        {
          event: EVENT_NAMES.AGENT_RUN_DENIED,
          runId: info.runId,
          graphName: info.graphName,
          principal: info.principal,
          tool: denial.tool,
          code: denial.code,
          reason: denial.reason,
          ...info.modelCalls(),
        },
        "run ended cleanly after a tool denial"
      );
    };
    const stream = (async function* () {
      let sawFinal = false;
      for await (const event of inner.stream) {
        const denial = info.denial();
        if (denial && event.type === "error") continue; // the abort we caused
        if (event.type === "assistant_final") sawFinal = true;
        if (denial && event.type === "done") {
          if (!sawFinal) {
            yield { type: "text_delta" as const, delta: message(denial) };
            yield { type: "assistant_final" as const, content: message(denial) };
          }
          logOnce(denial);
        }
        yield event;
      }
    })();
    const final = inner.final.then((result): GraphResult => {
      const denial = info.denial();
      if (!denial) return result;
      logOnce(denial);
      if (result.ok) return result;
      return {
        ok: true,
        finishReason: "stop",
        content: message(denial),
      };
    });
    return { stream, final };
  }

  /**
   * Extract graph name from namespaced graphId.
   * Per GRAPH_ID_NAMESPACED: "langgraph:cogni" → "cogni"
   */
  private extractGraphName(graphId: string): string | undefined {
    const prefix = `${this.providerId}:`;
    if (graphId.startsWith(prefix)) {
      return graphId.slice(prefix.length);
    }

    return undefined;
  }

  /**
   * Create completion function wrapping adapter.executeCompletionUnit.
   */
  private createCompletionFn(
    req: GraphRunRequest,
    modelCallMask: { readonly on: boolean },
  ): CompletionFn<LlmToolDefinition> {
    const { runId, graphId } = req;
    const attempt = 0; // P0_ATTEMPT_FREEZE

    return (params: Parameters<CompletionFn<LlmToolDefinition>>[0]) => {
      const result = (async () => {
        if (
          params.model !== req.modelRef.modelId &&
          (params.model !== "deepseek-v4-flash" ||
            !(await isModelAllowed(params.model)))
        )
          throw new Error("cogni_child_model_not_authorized");
        return this.adapter.executeCompletionUnit({
          messages: params.messages as GraphRunRequest["messages"],
          model: params.model,
          runContext: { runId, attempt, graphId },
          ...(params.abortSignal && { abortSignal: params.abortSignal }),
          ...(params.tools?.length && { tools: [...params.tools] }),
          ...(params.toolChoice !== undefined && { toolChoice: params.toolChoice }),
          // Read per call: the flag is set after the offered tools are known, before the first model call.
          ...(modelCallMask.on && { maskContent: true }),
        });
      })();

      return {
        stream: (async function* () {
          yield* (await result).stream;
        })(),
        final: result
          .then((unit) => unit.final)
          .then((r) => {
            if (!r.ok) return { ok: false as const, error: r.error };
            return {
              ok: true as const,
              content: r.content ?? "",
              ...(r.toolCalls && { toolCalls: r.toolCalls }),
              ...(r.usage && { usage: r.usage }),
              ...(r.finishReason && { finishReason: r.finishReason }),
            };
          }),
      };
    };
  }

  /**
   * Map package GraphResult to port GraphFinal.
   * GraphResult.error is now AiExecutionErrorCode - direct passthrough.
   * Logs errors at adapter boundary for debugging.
   */
  private async mapToGraphFinal(
    final: Promise<GraphResult>,
    runId: string,
    requestId: string,
    graphName: string,
  ): Promise<GraphFinal> {
    const result = await final;

    if (!result.ok) {
      // Log error at adapter boundary (per OBSERVABILITY.md: adapter ERROR log)
      this.log.error(
        {
          runId,
          reqId: requestId,
          graphName,
          errorCode: result.error ?? "internal",
          errorMessage: result.errorMessage,
          event: EVENT_NAMES.ADAPTER_LANGGRAPH_INPROC_ERROR,
        },
        EVENT_NAMES.ADAPTER_LANGGRAPH_INPROC_ERROR,
      );

      // Direct passthrough - GraphResult.error is already AiExecutionErrorCode
      return { ok: false, runId, requestId, error: result.error ?? "internal" };
    }

    // Conditional spreads for exactOptionalPropertyTypes
    return {
      ok: true,
      runId,
      requestId,
      finishReason: "stop",
      ...(result.usage !== undefined && { usage: result.usage }),
      ...(result.content !== undefined && { content: result.content }),
      ...(result.structuredOutput !== undefined && {
        structuredOutput: result.structuredOutput,
      }),
    };
  }

  /**
   * Create error result for invalid requests.
   * Per ERROR_NORMALIZATION: details logged, stream gets code only.
   */
  private createErrorResult(
    runId: string,
    requestId: string,
    code: AiExecutionErrorCode = "internal",
  ): GraphRunResult {
    const errorStream = (async function* () {
      yield { type: "error" as const, error: code };
      yield { type: "done" as const };
    })();

    return {
      stream: errorStream,
      final: Promise.resolve({
        ok: false as const,
        runId,
        requestId,
        error: code,
      }),
    };
  }
}
