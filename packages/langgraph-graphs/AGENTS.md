# langgraph-graphs · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** draft

## Purpose

LangGraph graph definitions and runtime utilities for agentic AI execution. Contains all `@langchain/*` code in the monorepo. Provides graph factories, message converters, tool wrappers, and streaming utilities.

## Pointers

- [LangGraph AI Guide](https://node-template.cognidao.org/knowledge/graph-execution-invariants)
- [Graph Execution](https://node-template.cognidao.org/knowledge/graph-execution-invariants)
- [Tool Use Spec](https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/tool-use.md)
- [Packages Architecture](https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/packages-architecture.md)

## Boundaries

```json
{
  "layer": "packages",
  "may_import": ["packages"],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters",
    "shared",
    "services"
  ]
}
```

**External deps:** `@langchain/core`, `@langchain/langgraph`, `@langchain/mcp-adapters`, `zod`. Imports `@cogni/ai-core`, `@cogni/ai-tools`.

## Public Surface

- **Exports (subpaths):**
  - `@cogni/langgraph-graphs` — Barrel re-export of common types plus:
    - `LANGGRAPH_CATALOG` / `NODE_LANGGRAPH_CATALOG` — Graph catalog; publishes exactly two graphs: `cogni` (node operator, principal `node-ai`, default graph) and `work-prioritizer` (display "Work Prioritizer", principal `prioritizer`, scheduled triage program: the guarded `core__work_item_update` writer)
    - `LANGGRAPH_GRAPH_IDS`, `DEFAULT_LANGGRAPH_GRAPH_ID` (`langgraph:cogni`) — Namespaced graph ids
    - `McpToolSource` — ToolSourcePort implementation for MCP-discovered tools
    - `loadMcpTools()`, `parseMcpConfigFromEnv()` — MCP client connection + config parsing
    - `McpHttpServerConfig`, `McpSseServerConfig`, `McpStdioServerConfig` — Transport config types
  - `@cogni/langgraph-graphs/inproc` — InProc execution runner:
    - `createInProcGraphRunner()` — Generic InProc graph runner factory
    - `InProcRunnerOptions`, `InProcGraphRequest`, `GraphResult` (includes optional `structuredOutput`) — Runner types
    - `CompletionFn`, `CompletionResult` — Injected completion function types
    - `CreateGraphFn`, `CreateGraphOptions` — Graph factory types. `CreateGraphFn.createRunHooks` returns per-run program hooks: `graphOptions`, `observeTool`, `onSkillReadFailure`, `verifyEffects`, `projectAnswer`, `projectOutput` and `projectStepBudget`. On normal completion the runner awaits bounded `verifyEffects` through registered, request-allowed read-only tools under the run's cancellation signal, then uses `projectAnswer` before final emission and persistence. The runner calls `projectStepBudget` when a run hits `GraphRecursionError`; a program that returns a report ends the run ok with it (writes already made stay), and a program with no hook keeps the error
    - `ToolExecFn`, `ToolExecResult` — Tool execution types
  - `@cogni/langgraph-graphs/runtime` — LangChain utilities (split: `core/` generic, `cogni/` ALS-based):
    - **Core (no ALS):** `makeLangChainTool()`, `toLangChainToolsCaptured()`, `toBaseMessage()`, `fromBaseMessage()`, `AsyncQueue`, `makeServerGraph()`
    - **Cogni (uses ALS):** `CogniCompletionAdapter` (with `withStructuredOutput()` for Zod/JSON Schema response parsing), `runWithCogniExecContext()`, `getCogniExecContext()`, `hasCogniExecContext()`, `toLangChainToolsFromContext()`, `makeCogniGraph()`
    - `CogniExecContext` — Runtime context type (completionFn, tokenSink, toolExecFn; NO model per #35)
  - `@cogni/langgraph-graphs/graphs` — Graph factories and shared types:
    - `createCogniGraph()` / `createCogniProgram()` — shared native deep-agent composition for roots and bounded compiled children
    - `createWorkPrioritizerGraph()` — Scheduled triage program on the shared harness (`work-prioritizer`): the guarded `core__work_item_update` writer (status, scores, labels and moves with `expectedRevision`, at most `MAX_CHANGED_ITEMS_PER_RUN` changed items). Writes require the triage, scoring, human-boundary, goal-authority and metrics-expert bodies. Guard refusals remain in report receipts. Normal completion verifies cumulative requested effects with at most one missing readback per changed item; its answer distinguishes verified writes, unresolved intake/ranks, incomplete paging and failed reads. A write with no reason is refused `reason_required`; the guard never writes a reason for the model (task.0086). `WORK_PRIORITIZER_GRAPH_NAME`, `cycleTelemetry()`
    - `InvokableGraph<I,O>`, `MessageGraphInput`, `MessageGraphOutput` — Type firewall
    - `GraphInvokeOptions`, `CreateReactAgentGraphOptions` — Factory types
  - **Per-graph tools:** `src/graphs/*/tools.ts` exports `*_TOOL_IDS` constants (e.g., `COGNI_TOOL_IDS`)
- **Env/Config keys:** none (all deps injected)
- **Files considered API:** `index.ts`, `inproc/index.ts`, `runtime/index.ts`, `graphs/index.ts`, `langgraph.json`
- **Server entrypoints:** `src/graphs/*/server.ts` — LangGraph dev server (uses `makeServerGraph`)
- **Cogni entrypoints:** `src/graphs/*/cogni-exec.ts` — Cogni executor (uses `makeCogniGraph`)

## Ports

- **Uses ports:** none (pure package, no ports)
- **Implements ports:** none

## Responsibilities

- This directory **does**: Define LangGraph graphs, wrap tools for LangChain, convert message formats
- This directory **does not**: Import from `src/`, execute graphs (runners in `src/`), own billing logic

## Usage

```bash
pnpm --filter @cogni-dao/langgraph-graphs typecheck
pnpm --filter @cogni-dao/langgraph-graphs build
pnpm --filter @cogni-dao/langgraph-graphs test
```

## Standards

- All `@langchain/*` imports must stay in this package (NO_LANGCHAIN_IN_SRC)
- Graph factories are pure functions — no env reads, no side effects
- PROMPTS_ARE_REVIEWABLE: All authored harness, root and child instructions live in the owning graph's prompts.ts; graph factories and catalogs import references, never append instruction strings.
- PURE_GRAPH_FACTORY: `graph.ts` has no env/ALS/entrypoint wiring
- TYPE_TRANSPARENT_RETURN: Graph factories have NO explicit return type annotation to preserve `CompiledStateGraph` for CLI schema extraction
- ENTRYPOINT_IS_THIN: `server.ts` and `cogni-exec.ts` are ~1-liners calling `makeServerGraph`/`makeCogniGraph`
- NO_CROSSING_THE_STREAMS: `server.ts` uses `initChatModel`; `cogni-exec.ts` uses ALS — never mix
- TOOLS_DENY_BY_DEFAULT: toLangChainTool checks configurable.toolIds; returns policy_denied if not in list
- TOOL_CATALOG_IS_CANONICAL: `LANGGRAPH_CATALOG` entries use `toolIds: string[]` references; providers resolve from `TOOL_CATALOG`

## Dependencies

- **Internal:** `@cogni/ai-core` (AiEvent types), `@cogni/ai-tools` (ToolContract, BoundTool)
- **External:** `@langchain/core`, `@langchain/langgraph`, `zod`

## Change Protocol

- Update this file when public exports change
- Changes to graph contracts require updating `src/adapters/server/ai/langgraph/inproc.provider.ts`
- Coordinate with LANGGRAPH_AI.md invariants

## Notes

- Per NO_LANGCHAIN_IN_SRC: `src/**` cannot import `@langchain/*` — only this package
- Per PACKAGES_NO_SRC_IMPORTS: This package cannot import from `src/**`
- `LangGraphInProcProvider` in `src/adapters/server/ai/langgraph/` wires this package
- Package isolation enables LangGraph Server to import graphs without Next.js deps
- **Dual tsconfig:** LangGraph CLI generates runtime `.ts` files (`__langgraph__*.ts`) that break `composite` mode. This package uses `tsconfig.json` (noEmit, for CLI) + `tsconfig.build.json` (composite, for `tsc -b`). Root tsconfig.json references the build config explicitly. This is not proper form, but a valid workaround.
- New or changed triage metric declarations require a canonical goal-progress/metric-list receipt and the named metric's full knowledge body. A new declaration with goal score 4–5 cites that metric body. Existing identical declarations remain quiet and retain their server-owned baseline.
- `createCogniProgram` accepts program-owned native middleware after source-identity validation and clears it for isolated readers. Work-review uses `TriageReadPreflight.beforeAgent` for nine bounded authorized reads (five guide bodies, goals, KPI status and two canonical initial candidate pages); actual tool-call/results enter graph state before the first model call. It adds no writer or outer Runnable wrapper.
- `CatalogEntry.principal` names the internal agent principal a graph acts as (`work-prioritizer` → `prioritizer`, `cogni` → `node-ai`). A graph with no principal gets no scoped tool; a slug with no seeded `agent_principals` row fails the run before any tool runs. The dev runner (`createDevToolExecFn`) guards its runtimes with `@cogni-dao/agent-grants` and has no run scope, so scoped tools are denied there.

- The coordinator uses catalog-owned `guidanceId` values and host-observed per-run receipts. The catalog registers `createCatalogCogniGraph`, which binds those ids into `createCoordinatorGraph` and reuses its `createRunHooks` (`createCoordinatorRunHooks`) for receipt observation. After an exact-purpose lookup, native middleware supplies missing goals, KPI status, bounded open work and workflow cards before the next model decision. Creation requires those context reads and the selected full card; ordinary answers trigger no reads. The original host capability retains all ownership/edit-policy checks.
