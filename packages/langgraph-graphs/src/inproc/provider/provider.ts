// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/inproc/provider`
 * Purpose: The in-process LangGraph provider every node runs: principal lock, tool guard, audience filter, terminal denial, MCP tools, secret-argument mask and the billed completion.
 * Scope: Implements `GraphExecutorPort` over the package runner. Everything the node owns arrives through `InProcProviderDeps`; the package imports no `@/` path, no logger library, no OpenTelemetry and no env.
 * Invariants:
 *   - GRAPH_ID_NAMESPACED: graphId format is "langgraph:${graphName}"
 *   - NODE_BUNDLE_IS_CANONICAL: contracts come from the injected tool bundle; the global tool catalog is never iterated
 *   - DENY_BY_DEFAULT: tool policy is explicit per graph; with no authority wired every scoped tool is denied
 *   - MCP_VIA_ASYNC_SOURCE: MCP tools come from the injected async source
 *   - SECRET_ARGS_MASK_MODEL_CALLS: a run that offers any tool whose contract declares `secretArgs` masks every model call of that run
 *   - CATALOG_REPORT_SEAM: a catalog entry's `report` (not a graph name) decides whether the run's telemetry is logged and echoed onto the stream
 *   - GUARD_COVERS_EVERY_RUNNER_SITE: every runtime (native and MCP) passes through `guardTools`
 *   - DENIAL_IS_TERMINAL: the model is never offered a tool whose principal lock already fails; an exec-time denial aborts the run and ends it cleanly with one fixed message
 *   - SHELL_NEEDS_AUDIENCE_AND_RUN_CLAIM: with a `coding` policy, the sandbox shell is offered only on a run whose `runClaimVerified` is true, whose actor is in the audience and equals the subject. Any other run loses the shell and still runs. The shell runtime rechecks at exec time, before any sandbox or token access.
 *   - STARTS_WORK_WHEN_CALLED: `runGraph` begins work when called; compose it only behind a preflight decorator
 * Side-effects: IO (executes graphs, MCP tool resolution through the injected source)
 * Links: https://node-template.cognidao.org/knowledge/inproc-provider-package-design, https://node-template.cognidao.org/knowledge/shell-caller-run-claim
 * @public
 */

import {
  type GuardDeps,
  guardTools,
  offeredToolIds,
  type TerminalDenial,
  ToolAuthorityError,
  type ToolRequires,
} from "@cogni/agent-grants";
import type { AiEvent, AiExecutionErrorCode, BoundToolRuntime, ToolSourcePort } from "@cogni/ai-core";
import {
  createStaticToolSourceFromRecord,
  createToolAllowlistPolicy,
  createToolRunner,
} from "@cogni/ai-core";
import {
  type CatalogBoundTool,
  declaresSecretArgs,
  SANDBOX_SHELL_NAME,
} from "@cogni/ai-tools";
import type {
  ExecutionContext,
  GraphExecutorPort,
  GraphFinal,
  GraphRunRequest,
  GraphRunResult,
} from "@cogni/graph-execution-core";
import { graphReportDelta, graphReportLogFields } from "../../catalog";
import type { CatalogEntry } from "../../catalog";
import { createInProcGraphRunner } from "../runner";
import type {
  CompletionFn,
  GraphResult,
  InProcGraphRequest,
  ToolExecFn,
} from "../types";
import { INPROC_EVENTS } from "./events";
import type { CompletionUnitFinal, InProcProviderDeps, RunScope } from "./types";

export const LANGGRAPH_INPROC_PROVIDER_ID = "langgraph" as const;

/** The only model a graph may call besides the run's own, and only when the node allows it (the `cogni` child model). */
const CHILD_MODEL_ID = "deepseek-v4-flash";
const NO_TRACE = "00000000000000000000000000000000";

/** Why a coding run stopped before its first model call. */
type StartDenialReason = "policy_denied" | "authz_unavailable" | "sandbox_unavailable";

/** The one fixed outcome a denied run ends with (DENIAL_IS_TERMINAL). */
function denialMessage(code: "policy_denied" | "authz_unavailable"): string {
  return code === "authz_unavailable"
    ? "I can't check my permissions right now, so I stopped. Try again later."
    : "I don't have permission to do that on this node, so I stopped. Ask a node admin to allow it.";
}

function startDenialMessage(reason: StartDenialReason): string {
  return reason === "sandbox_unavailable"
    ? "The sandbox is not available on this node, so I stopped. Ask a node admin to check it."
    : denialMessage(reason);
}

/** With no authority wired, the guard can reach no store and no admin check: scoped tools deny. */
const DENY_ALL_GUARD_DEPS: Omit<GuardDeps, "runAs"> = {
  withStore: async () => {
    throw new Error("agent_authority_not_configured");
  },
  adminCheck: async () => "unavailable",
};

/** A run that ends cleanly with one fixed assistant message and no model call. */
function cleanEnd(text: string): { stream: AsyncIterable<AiEvent>; final: Promise<GraphResult> } {
  return {
    stream: (async function* () {
      yield { type: "text_delta" as const, delta: text };
      yield { type: "assistant_final" as const, content: text };
      yield { type: "done" as const } as AiEvent;
    })(),
    final: Promise.resolve({ ok: true, finishReason: "stop", content: text } as GraphResult),
  };
}

export function createLangGraphInProcProvider<TTool = unknown>(
  deps: InProcProviderDeps<TTool>,
): GraphExecutorPort & { readonly providerId: "langgraph" } {
  const { log } = deps;
  const boundToolMap = new Map<string, CatalogBoundTool>(
    deps.toolBundle.map((bt) => [bt.contract.name, bt]),
  );
  /** Ids of node-bundle tools whose contract declares `secretArgs`. */
  const secretToolIds = new Set(
    deps.toolBundle.filter((bt) => declaresSecretArgs(bt.contract)).map((bt) => bt.contract.name),
  );

  log.debug(
    { graphCount: Object.keys(deps.catalog).length, graphs: Object.keys(deps.catalog) },
    "LangGraphInProcProvider initialized",
  );

  function createCompletionFn(
    req: GraphRunRequest,
    modelCallMask: { readonly on: boolean },
  ): CompletionFn<TTool> {
    const { runId, graphId } = req;
    const attempt = 0; // P0_ATTEMPT_FREEZE
    return (params) => {
      const result = (async () => {
        if (
          params.model !== req.modelRef.modelId &&
          (params.model !== CHILD_MODEL_ID ||
            !deps.isChildModelAllowed ||
            !(await deps.isChildModelAllowed(params.model)))
        )
          throw new Error("cogni_child_model_not_authorized");
        return deps.completion.executeCompletionUnit({
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
          .then((r: CompletionUnitFinal) => {
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
   * DENIAL_IS_TERMINAL. When the guard denied a tool, the run was aborted (see `onTerminalDenial`). The runner reports an
   * abort as an error; this turns it into a clean completion: no error event, one fixed assistant message, `final.ok`.
   * Logs one `agent_run.denied` event with the model-call counts. A run with no denial passes through untouched.
   */
  function endDeniedRunCleanly(
    inner: { stream: AsyncIterable<AiEvent>; final: Promise<GraphResult> },
    info: {
      runId: string;
      graphName: string;
      principal: string | null;
      denial: () => TerminalDenial | null;
      modelCalls: () => { modelCalls: number; modelCallsAfterDenial: number };
    },
  ): { stream: AsyncIterable<AiEvent>; final: Promise<GraphResult> } {
    const message = (denial: TerminalDenial) => denialMessage(denial.code);
    let logged = false;
    const logOnce = (denial: TerminalDenial) => {
      if (logged) return;
      logged = true;
      log.warn(
        {
          event: INPROC_EVENTS.AGENT_RUN_DENIED,
          runId: info.runId,
          graphName: info.graphName,
          principal: info.principal,
          tool: denial.tool,
          code: denial.code,
          reason: denial.reason,
          ...info.modelCalls(),
        },
        "run ended cleanly after a tool denial",
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
      return { ok: true, finishReason: "stop", content: message(denial) };
    });
    return { stream, final };
  }

  /** Map the runner's GraphResult to the port's GraphFinal, logging errors at the provider boundary. */
  async function mapToGraphFinal(
    final: Promise<GraphResult>,
    runId: string,
    requestId: string,
    graphName: string,
  ): Promise<GraphFinal> {
    const result = await final;
    if (!result.ok) {
      log.error(
        {
          runId,
          reqId: requestId,
          graphName,
          errorCode: result.error ?? "internal",
          errorMessage: result.errorMessage,
          event: INPROC_EVENTS.ADAPTER_LANGGRAPH_INPROC_ERROR,
        },
        INPROC_EVENTS.ADAPTER_LANGGRAPH_INPROC_ERROR,
      );
      return { ok: false, runId, requestId, error: result.error ?? "internal" };
    }
    return {
      ok: true,
      runId,
      requestId,
      finishReason: "stop",
      ...(result.usage !== undefined && { usage: result.usage }),
      ...(result.content !== undefined && { content: result.content }),
      ...(result.structuredOutput !== undefined && { structuredOutput: result.structuredOutput }),
    };
  }

  function createErrorResult(
    runId: string,
    requestId: string,
    code: AiExecutionErrorCode = "internal",
  ): GraphRunResult {
    return {
      stream: (async function* () {
        yield { type: "error" as const, error: code };
        yield { type: "done" as const };
      })(),
      final: Promise.resolve({ ok: false as const, runId, requestId, error: code }),
    };
  }

  function runGraph(req: GraphRunRequest, ctx?: ExecutionContext): GraphRunResult {
    const { runId, messages, modelRef, graphId } = req;
    const model = modelRef.modelId;
    const scope: RunScope = deps.scope.current();
    const requestId = ctx?.requestId ?? req.runId;

    // GRAPH_ID_NAMESPACED: "langgraph:cogni" -> "cogni"
    const prefix = `${LANGGRAPH_INPROC_PROVIDER_ID}:`;
    const graphName = graphId.startsWith(prefix) ? graphId.slice(prefix.length) : undefined;
    if (!graphName) {
      log.error({ runId, graphId }, "Invalid graphId format");
      return createErrorResult(runId, requestId, "invalid_request");
    }
    const entry: CatalogEntry | undefined = deps.catalog[graphName];
    if (!entry) {
      log.error({ runId, graphName }, "Graph not found in catalog");
      return createErrorResult(runId, requestId, "not_found");
    }

    log.debug(
      { runId, graphName, model, messageCount: messages.length },
      "LangGraphInProcProvider.runGraph routing to package runner",
    );

    // Run-scoped mask flag: set once the offered tools are known (below), read on every model call.
    const modelCallMask = { on: false };
    const completionFn = createCompletionFn(req, modelCallMask);

    // P0 Contract: undefined => catalog default, [] => deny-all, [...] => exact
    const catalogToolIds = entry.toolIds;
    const toolIds: readonly string[] = req.toolIds ?? catalogToolIds;
    if (req.toolIds === undefined) {
      log.debug(
        { runId, graphName, catalogToolIds },
        "toolIds undefined; using catalog default per P0 contract",
      );
    }

    // Resolve BoundToolRuntime from the injected tool source (TOOL_SOURCE_RETURNS_BOUND_TOOL).
    const runtimeTools: Record<string, BoundToolRuntime> = {};
    for (const toolId of catalogToolIds) {
      const runtime = deps.tools.getBoundTool(toolId);
      if (runtime) {
        runtimeTools[toolId] = runtime;
      } else {
        log.error({ runId, graphName, toolId }, "Tool not found in toolSource; graph misconfigured");
      }
    }

    const mcpServerIds = entry.mcpServerIds ?? [];

    // Async helper: resolve MCP tools then execute graph.
    const resolveMcpAndExecute = async (): Promise<{
      stream: AsyncIterable<AiEvent>;
      final: Promise<GraphResult>;
    }> => {
      // Principal lock: the catalog names the agent this graph acts as. No seed row denies the run
      // before any tool runs (SCOPED_TOOL_NEEDS_PRINCIPAL; fail closed).
      let principalId: string | undefined;
      if (entry.principal) {
        try {
          principalId = (await deps.authority?.resolvePrincipal(entry.principal)) ?? undefined;
        } catch (error) {
          // The principal store is down: fail closed, and say so as `authz_unavailable` (not a generic internal error).
          log.error(
            {
              event: INPROC_EVENTS.AGENT_TOOL_AUTHZ,
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
          log.error(
            {
              event: INPROC_EVENTS.AGENT_TOOL_AUTHZ,
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
      if (mcpServerIds.length > 0 && deps.mcpTools) {
        const mcpToolSource: ToolSourcePort | null = await deps.mcpTools();
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
            log.debug(
              { runId, graphName, mcpServerIds, mcpToolCount: mcpToolIds.length },
              "Resolved MCP tools for graph",
            );
          }
        }
      }

      // The contracts' `requires` are the only input that names scopes. An MCP tool has none yet, so it is
      // denied (it is external_side_effect) until MCP server scopes merge into requiresById.
      const requiresById: Record<string, ToolRequires> = {};
      for (const [id, bound] of boundToolMap) {
        if (bound.contract.requires) requiresById[id] = bound.contract.requires;
      }
      const guardScope = {
        runId,
        principalId,
        subjectUserId: scope.subjectUserId,
        // The account the run acts on (R13): an account-kind tool opens only for a principal with a live row for exactly this account.
        accountId: scope.accountId,
        payer: scope.accountId,
      };
      const guardBase = deps.authority?.guardDeps ?? DENY_ALL_GUARD_DEPS;

      // SHELL_NEEDS_AUDIENCE_AND_RUN_CLAIM: decide the shell before the guard reads the store and before any model schema
      // exists. A withheld shell is gone from `runtimeTools`, so it is never offered, never named in the withheld-tool
      // note, and never counted as a write tool.
      const coding = deps.coding;
      const shellId = coding ? (coding.toolId ?? SANDBOX_SHELL_NAME) : undefined;
      let codingActor: string | undefined;
      if (coding && shellId && runtimeTools[shellId] && toolIds.includes(shellId)) {
        const actor = ctx?.actorUserId;
        const inAudience = actor !== undefined && coding.isCodingActor(actor);
        if (inAudience && scope.subjectUserId !== actor) {
          log.error(
            {
              event: INPROC_EVENTS.AGENT_RUN_START_DENIED,
              runId,
              graphName,
              reason: "identity_mismatch",
            },
            "coding actor differs from the run subject; run refused before any effect",
          );
          throw new Error("shared_identity_unavailable");
        }
        const claimed = ctx?.runClaimVerified === true;
        if (inAudience && claimed) {
          codingActor = actor;
        } else {
          delete runtimeTools[shellId];
          log.warn(
            {
              event: INPROC_EVENTS.AGENT_CODING_SHELL_WITHHELD,
              runId,
              graphName,
              reason: claimed ? "not_audience" : "unclaimed",
            },
            "shell withheld from this run",
          );
        }
      }

      // DENIAL_IS_TERMINAL (1/2): the model is never offered a tool whose principal lock already fails.
      const { offered, excluded } = await offeredToolIds(
        Object.entries(runtimeTools).map(([id, rt]) => ({ id, effect: rt.spec.effect })),
        requiresById,
        guardScope,
        guardBase,
      );
      const offeredSet = new Set(offered);

      // A claimed audience actor runs only when the shell can work: the node says its prerequisites are ready and the
      // guard offers the tool. Otherwise the run ends cleanly before its first model call: no sandbox call, no mint.
      if (coding && shellId && codingActor !== undefined) {
        const missing = !coding.prerequisitesReady()
          ? ("sandbox_unavailable" as const)
          : offeredSet.has(shellId)
            ? undefined
            : (excluded.find((e) => e.tool === shellId)?.code ?? ("policy_denied" as const));
        if (missing) {
          log.warn(
            {
              event: INPROC_EVENTS.AGENT_RUN_START_DENIED,
              runId,
              graphName,
              reason: missing,
            },
            "coding run stopped before the first model call",
          );
          return cleanEnd(startDenialMessage(missing));
        }
      }

      if (entry.program && !deps.sourceContext) {
        throw new Error("node_source_context_unavailable");
      }

      // A run with no interactive caller (a validated schedule tick, or one with no subject such as a webhook) whose
      // every write tool is withheld has nothing it may do: end it now, with no model call, instead of paying for a
      // "no permission" answer on every tick. An interactive run keeps the system note below and may answer once.
      const writeTools = Object.entries(runtimeTools).filter(([, rt]) => rt.spec.effect !== "read_only");
      const noInteractiveCaller = ctx?.unattended === true || !scope.subjectUserId;
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
      modelCallMask.on = offeredToolIdList.some((id) => secretToolIds.has(id));

      // Contracts come from the injected bundle (NODE_BUNDLE_IS_CANONICAL).
      const catalogTools = catalogToolIds
        .filter((id) => offeredSet.has(id))
        .map((id) => boundToolMap.get(id))
        .filter((bt): bt is NonNullable<typeof bt> => bt !== undefined);

      // DENIAL_IS_TERMINAL (2/2): an exec-time denial ends the run cleanly. The run's abort signal chains the caller's.
      const runAbort = new AbortController();
      const callerSignal = scope.abortSignal;
      if (callerSignal) {
        if (callerSignal.aborted) runAbort.abort(callerSignal.reason);
        else
          callerSignal.addEventListener("abort", () => runAbort.abort(callerSignal.reason), {
            once: true,
          });
      }
      let terminal: TerminalDenial | null = null;
      const onTerminalDenial = (denial: TerminalDenial) => {
        if (terminal) return;
        terminal = denial;
        runAbort.abort(new Error("agent_tool_denied"));
      };
      let modelCalls = 0;
      let modelCallsAfterDenial = 0;

      // Recheck at exec time, before the guard and before any sandbox capability or token access. The conditions are
      // the ones that opened the shell at run start, so a later change in audience, readiness or subject ends the run.
      if (coding && shellId && codingActor !== undefined) {
        const startActor = codingActor;
        const inner = runtimeTools[shellId];
        if (inner) {
          runtimeTools[shellId] = {
            ...inner,
            exec: async (args, execCtx, caps) => {
              const stillOpen =
                coding.isCodingActor(startActor) &&
                coding.prerequisitesReady() &&
                deps.scope.current().subjectUserId === startActor;
              if (!stillOpen) {
                log.warn(
                  {
                    event: INPROC_EVENTS.AGENT_TOOL_AUTHZ,
                    runId,
                    graphName,
                    tool: shellId,
                    decision: "deny",
                    code: "policy_denied",
                    reason: "coding_recheck_failed",
                  },
                  "shell recheck failed at exec time",
                );
                onTerminalDenial({
                  tool: shellId,
                  code: "policy_denied",
                  reason: "coding_recheck_failed",
                });
                throw new ToolAuthorityError("policy_denied", shellId, null);
              }
              return inner.exec(args, execCtx, caps);
            },
          };
        }
      }
      const countedCompletionFn: typeof completionFn = (params) => {
        modelCalls += 1;
        if (terminal) modelCallsAfterDenial += 1;
        return completionFn(params);
      };

      // Tool execution function factory. The policy allowlist covers native and MCP tool ids.
      const createToolExecFn = (emit: (e: AiEvent) => void): ToolExecFn => {
        const policy = createToolAllowlistPolicy(allToolIds);
        // GUARD_COVERS_EVERY_RUNNER_SITE: every runtime (native + MCP) passes through the guard.
        const guarded = guardTools(runtimeTools, requiresById, guardScope, {
          ...guardBase,
          onTerminalDenial,
          runAs: (identity, fn) => scope.runAs({ ...identity, runId }, fn),
        });
        const source = createStaticToolSourceFromRecord(guarded);
        const toolRunner = createToolRunner(source, emit, { policy, ctx: { runId } });

        return async (name, args, toolCallId) => {
          const result =
            toolCallId !== undefined
              ? await toolRunner.exec(name, args, { modelToolCallId: toolCallId })
              : await toolRunner.exec(name, args);
          if (!result.ok) {
            // A secret tool's error text is scrubbed, but no text of it is logged: the code and receipt code suffice.
            const secretTool = secretToolIds.has(name);
            log.warn(
              {
                event: INPROC_EVENTS.AI_TOOL_CALL_ERROR,
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

      const traceId = deps.traceId?.() ?? NO_TRACE;
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
        traceId,
        ...(requestId !== undefined && { ingressRequestId: requestId }),
        configurable: { model, toolIds: offeredToolIdList },
      };

      // Resolve the node source first so a mission graph still fails closed when its hub context is missing.
      const resolvedSource =
        entry.program && deps.sourceContext
          ? await deps.sourceContext(Boolean(entry.program))
          : undefined;
      if (endWithoutModel) {
        const code = excluded.every((e) => e.code === "authz_unavailable")
          ? ("authz_unavailable" as const)
          : ("policy_denied" as const);
        log.warn(
          {
            event: INPROC_EVENTS.AGENT_RUN_DENIED,
            runId,
            graphName,
            principal: entry.principal ?? null,
            tools: writeTools.map(([id]) => id),
            code,
            reason: "no_permission",
            modelCalls: 0,
            modelCallsAfterDenial: 0,
          },
          "run ended without a model call: every write tool is withheld",
        );
        return cleanEnd(denialMessage(code));
      }
      const inner = (deps.createRunner ?? createInProcGraphRunner)({
        createGraph: entry.graphFactory,
        completionFn: countedCompletionFn,
        createToolExecFn,
        toolContracts,
        ...(mcpToolSpecs.length > 0 && { mcpToolSpecs }),
        request: runnerRequest,
        ...(entry.program && deps.persistence && { persistence: await deps.persistence() }),
        ...(entry.program !== undefined && { program: entry.program }),
        ...(ctx?.actorUserId ? { trustedActorId: ctx.actorUserId } : {}),
        ...(entry.program && { trustedProgramId: entry.program }),
        interactive: !noInteractiveCaller,
        // A scheduled tick keeps the default budget; only a run with a caller waiting gets the entry's.
        ...(!noInteractiveCaller && entry.stepBudget !== undefined && { recursionLimit: entry.stepBudget }),
        ...(resolvedSource !== undefined && { sourceContext: resolvedSource }),
        ...(req.responseFormat !== undefined && {
          responseFormat: req.responseFormat as { prompt?: string; schema: unknown },
        }),
        ...(entry.systemPrompt !== undefined && { systemPrompt: entry.systemPrompt }),
      });
      const runner = endDeniedRunCleanly(inner, {
        runId,
        graphName,
        principal: entry.principal ?? null,
        denial: () => terminal,
        modelCalls: () => ({ modelCalls, modelCallsAfterDenial }),
      });
      // CatalogEntry.report: the graph's own report -> registered events (graphs have no logger).
      const report = entry.report;
      if (report) {
        void runner.final
          .then((result) => {
            for (const fields of graphReportLogFields(report, runId, result.structuredOutput)) {
              log.info(fields, "graph report");
            }
          })
          .catch(() => {
            // Run failure is already logged by the inproc error path.
          });
      }
      return runner;
    };

    // Returns {stream, final} synchronously per the GraphRunResult contract; the inner generator awaits the promise.
    const innerResult = resolveMcpAndExecute();
    const report = entry.report;

    const stream = (async function* () {
      let inner: Awaited<ReturnType<typeof resolveMcpAndExecute>>;
      try {
        inner = await innerResult;
      } catch {
        yield { type: "error" as const, error: "internal" as AiExecutionErrorCode };
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

    const final: Promise<GraphFinal> = innerResult.then(
      (r) => mapToGraphFinal(r.final, runId, requestId, graphName),
      () => ({ ok: false as const, runId, requestId, error: "internal" as const }),
    );

    return { stream, final };
  }

  return { providerId: LANGGRAPH_INPROC_PROVIDER_ID, runGraph };
}

