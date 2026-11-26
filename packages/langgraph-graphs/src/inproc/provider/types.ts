// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/inproc/provider/types`
 * Purpose: The ports a node injects into the in-process provider.
 * Scope: Types only. The package imports no `@/` path, no logger library, no OpenTelemetry and no env.
 * Invariants:
 *   - INJECTED_PORTS: everything the provider needs from the node (billed LLM call, tools, run scope, authority, source context, persistence, coding policy) arrives through `InProcProviderDeps`
 *   - STRUCTURAL_SEAM: node types (`LlmToolDefinition`, pino's logger, the node's `ExecutionScope`) must be assignable to these; none is imported
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/inproc-provider-package-design
 * @public
 */

import type { GuardDeps, RunIdentity } from "@cogni/agent-grants";
import type {
  AiEvent,
  AiExecutionErrorCode,
  GraphId,
  Message as PortMessage,
  ToolSourcePort,
} from "@cogni/ai-core";
import type { CatalogBoundTool } from "@cogni/ai-tools";
import type { CreateGraphOptions, GraphResult, InProcRunnerOptions } from "../types";
import type { LangGraphCatalog } from "../../catalog";
import type { CompletionToolChoice, ToolCall } from "../../runtime/cogni/completion-adapter";

/** The node's mission and governing index for a run that needs source context (`program` graphs). */
export type SourceContext = NonNullable<CreateGraphOptions["sourceContext"]>;

/** The checkpointer and store a `program` run compiles with. */
export type Persistence = NonNullable<InProcRunnerOptions["persistence"]>;

/** Params of one billed completion. `TTool` is the node's tool definition type (`LlmToolDefinition`). */
export interface CompletionUnitParams<TTool = unknown> {
  messages: PortMessage[];
  model: string;
  runContext: { runId: string; attempt: number; graphId: GraphId };
  abortSignal?: AbortSignal;
  tools?: readonly TTool[];
  toolChoice?: CompletionToolChoice;
  /** True when the run offers a tool whose contract declares `secretArgs`: the gateway must log neither input nor output. */
  maskContent?: boolean;
}

/** The final result of one billed completion (a node's `CompletionFinalResult` fits). */
export type CompletionUnitFinal =
  | {
      readonly ok: true;
      readonly content?: string;
      readonly toolCalls?: ToolCall[];
      readonly usage?: { readonly promptTokens: number; readonly completionTokens: number };
      readonly finishReason?: string;
    }
  | { readonly ok: false; readonly error: AiExecutionErrorCode };

/** The node's billed LLM call. Every model call of every graph goes through it (GRAPH_LLM_VIA_COMPLETION). */
export interface CompletionUnitPort<TTool = unknown> {
  executeCompletionUnit(params: CompletionUnitParams<TTool>): {
    stream: AsyncIterable<AiEvent>;
    final: Promise<CompletionUnitFinal>;
  };
}

/** One run's scope, as the provider reads it. Bridges the node's `ExecutionScope`. */
export interface RunScope {
  /** The authenticated caller this run serves. Absent for a run with no caller. */
  readonly subjectUserId?: string | undefined;
  /** The billing account the run acts on (account-kind tools open only for a principal with a live row for exactly this account). */
  readonly accountId: string;
  /** The caller's abort signal (chat disconnect). The run's own abort chains it. */
  readonly abortSignal?: AbortSignal | undefined;
  /** Runs one tool call with the acting principal and subject bound in the node's scope. */
  runAs<T>(identity: RunIdentity & { readonly runId: string }, fn: () => T): T;
}

export interface RunScopePort {
  /** The scope of the run being started or executed. Throws outside a run. */
  current(): RunScope;
}

/** The node's tool-authority wiring, seen structurally. Absent from deps: every scoped tool is denied. */
export interface AgentAuthorityPort {
  /** The seeded user id for a catalog principal slug, or null when no row exists. */
  resolvePrincipal(slug: string): Promise<string | null>;
  readonly guardDeps: Omit<GuardDeps, "runAs">;
}

/** The node's coding-caller rules for the shell tool (hub shell-caller-run-claim). Absent: the provider applies no audience rule. */
export interface CodingCallerPolicy {
  /** The tool this policy covers. Defaults to the sandbox shell. */
  readonly toolId?: string;
  /** Whether this authenticated user id is in the node's coding audience (`COGNI_CODING_ACTOR_IDS`). */
  isCodingActor(actorUserId: string): boolean;
  /** Whether the sandbox, its token and the push-token key are configured. */
  prerequisitesReady(): boolean;
}

/** `debug`, `info`, `warn` and `error`, each `(fields, message?)`. Pino's logger fits. */
export interface ProviderLogger {
  debug(fields: object, message?: string): void;
  info(fields: object, message?: string): void;
  warn(fields: object, message?: string): void;
  error(fields: object, message?: string): void;
}

export interface InProcProviderDeps<TTool = unknown> {
  /** From `createNodeCatalog`. One catalog feeds the provider, agent discovery and the `cogni` prompt. */
  readonly catalog: LangGraphCatalog;
  /** The node's billed LLM call. */
  readonly completion: CompletionUnitPort<TTool>;
  /** Bound tool runtimes. The node may compose it per request; the provider never caches it. */
  readonly tools: ToolSourcePort;
  /** Tool contracts (the node's composed bundle): `requires`, `secretArgs`, schemas. */
  readonly toolBundle: readonly CatalogBoundTool[];
  readonly scope: RunScopePort;
  /** Absent: every scoped tool is denied. */
  readonly authority?: AgentAuthorityPort;
  readonly log: ProviderLogger;
  /** MCP tools for graphs that declare `mcpServerIds`. */
  readonly mcpTools?: () => Promise<ToolSourcePort | null>;
  /** Source context for `program` graphs. `required` is true for them. Absent: a `program` graph fails closed. */
  readonly sourceContext?: (required: boolean) => Promise<SourceContext>;
  readonly persistence?: () => Promise<Persistence>;
  /** The shell audience rule. Absent: no audience filter. */
  readonly coding?: CodingCallerPolicy;
  /** Whether a graph may call a model other than the run's own (the `cogni` child model). Absent: no. */
  readonly isChildModelAllowed?: (modelId: string) => Promise<boolean>;
  /** The active trace id for the run's logs and runner, when the node traces. */
  readonly traceId?: () => string | undefined;
  /**
   * The engine that runs a compiled graph. Defaults to the package's `createInProcGraphRunner`. A seam for a node's
   * contract tests, which observe the runner's options (the offered tools, the abort signal, the tool exec function).
   */
  readonly createRunner?: (options: InProcRunnerOptions<TTool>) => {
    stream: AsyncIterable<AiEvent>;
    final: Promise<GraphResult>;
  };
}
