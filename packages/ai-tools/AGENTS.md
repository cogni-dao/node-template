# ai-tools · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** draft

## Purpose

Pure tool definitions for AI agent execution. Defines `ToolContract`, `ToolImplementation`, `BoundTool` types and tool implementations with Zod validation. NO LangChain dependencies — LangChain wrapping lives in `@cogni/langgraph-graphs`.

## Pointers

- [LangGraph AI Guide](../../docs/spec/langgraph-patterns.md)
- [Tool Use Spec](../../docs/spec/tool-use.md)

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

**External deps:** `zod` (v4), `@cogni-dao/work-items` and `@cogni-dao/knowledge-store/contracts` (public domain peers). Inlines structural `@cogni/ai-core` types in final declarations; imports canonical domain schemas and ordering constants from public peers. NO LangChain.

## Public Surface

`core__goal_progress` uses the shared `GoalsProgressReadInputSchema` and `projectGoalsProgressHistory` from metrics. Its default `history=none` preserves the response envelope and every assessment/observation/unknown state, with explicit `historyMode=none` and null chart values. `history=full` remains available; the same HTTP route option defaults to full for UI consumers. Do not hand-copy or omit assessment fields to reduce context.

- **Exports:**
  - `ToolContract` - Tool definition interface (name, inputSchema, outputSchema, redact)
  - `ToolImplementation` - Pure execute function interface
  - `BoundTool` - Contract + implementation bundled together
  - `CatalogBoundTool` - Type alias for TOOL_CATALOG entries (type-erased BoundTool)
  - `ToolResult`, `ToolErrorCode` - Execution result types (failures preserve optional ai-core nonretryable lookup receipt)
  - `getCurrentTimeBoundTool`, `GET_CURRENT_TIME_NAME` - Time tool
  - `metricsQueryBoundTool`, `METRICS_QUERY_NAME`, `createMetricsQueryImplementation` - Metrics query tool
  - `webSearchBoundTool`, `WEB_SEARCH_NAME`, `createWebSearchImplementation` - Web search tool
  - `WebSearchCapability`, `WebSearchParams`, `WebSearchResult`, `WebSearchResultItem` - Web search types
  - `repoSearchBoundTool`, `REPO_SEARCH_NAME`, `createRepoSearchImplementation` - Repo search tool
  - `repoOpenBoundTool`, `REPO_OPEN_NAME`, `createRepoOpenImplementation` - Repo open tool
  - `repoListBoundTool`, `REPO_LIST_NAME`, `createRepoListImplementation` - Repo list tool
  - `RepoCapability`, `RepoSearchHit`, `RepoSearchResult`, `RepoOpenResult`, `RepoListParams`, `RepoListResult` - Repo capability types
  - `makeRepoCitation()`, `REPO_CITATION_REGEX` - Citation helpers
  - `toToolSpec()`, `toToolSpecs()` - Compile ToolContract to ToolSpec (Zod → JSONSchema7)
  - `vcsListPrsBoundTool`, `VCS_LIST_PRS_NAME`, `createVcsListPrsImplementation` - VCS list PRs tool
  - `vcsGetCiStatusBoundTool`, `VCS_GET_CI_STATUS_NAME`, `createVcsGetCiStatusImplementation` - VCS CI status tool
  - `vcsMergePrBoundTool`, `VCS_MERGE_PR_NAME`, `createVcsMergePrImplementation` - VCS merge PR tool
  - `vcsCreateBranchBoundTool`, `VCS_CREATE_BRANCH_NAME`, `createVcsCreateBranchImplementation` - VCS create branch tool
  - `vcsFlightCandidateBoundTool`, `VCS_FLIGHT_CANDIDATE_NAME`, `createVcsFlightCandidateImplementation` - VCS dispatch candidate-flight tool (NO_AUTO_FLIGHT)
  - `vcsPrReadBoundTool`, `VCS_PR_READ_NAME`, `createVcsPrReadImplementation` - read-only PR facts tool (core bundle)
  - `vcsCommitContainsBoundTool`, `VCS_COMMIT_CONTAINS_NAME`, `createVcsCommitContainsImplementation` - read-only is-this-commit-live tool (core bundle; defaults ref to the running build SHA)
  - `VcsCapability`, `PrFacts`, `CommitCompareResult`, `CiStatusResult`, `MergeResult`, `PrSummary`, `CreateBranchResult`, `CheckInfo`, `DispatchCandidateFlightResult` - VCS capability types
  - `workItemQueryBoundTool`, `WORK_ITEM_QUERY_NAME`, `createWorkItemQueryImplementation` - Work item query tool; sortBy/sortDirection derive from bundled work-items allowlists
  - `workItemReadBoundTool`, `WORK_ITEM_READ_NAME`, `createWorkItemReadImplementation` - bounded full work-item read, the single-item envelope (task.0118, 0.11.0): it calls `WorkItemCapability.read(id, { includeLinks })` (falls back to `query` when absent), the same read `GET /api/v1/work/items/{id}` serves. Each `moves` entry carries its readings and verdict plus `metric` (id, title, unit, display), `kpi` (metricId, title, comparator, target, status?) and `goal` (id, title), resolved on the server; `kpi` and `goal` are absent when the metric serves no goal KPI, and `context: "unavailable"` means the chain could not be resolved. `includeLinks: true` adds `links` (first page of citation links + `nextCursor`; `links.unavailable` is not an empty list). `core__work_item_query` stays summary-sized: `moves` there are metric ids only, so call the read tool for the chain. The output derives from the one `WorkItemDtoSchema` (no `.pick` allowlist); `app/tests/contract/work-item-tool-envelope.conformance.test.ts` fails when a wire key is missing from the tool unless it is named in its reviewed exclusion set
  - `workItemTransitionBoundTool`, `WORK_ITEM_TRANSITION_NAME`, `createWorkItemTransitionImplementation` - Work item transition tool. DEPRECATED: use `core__work_item_update`; its `patch` action requires a reason (task.0086)
  - `workItemUpdateBoundTool`, `workItemUpdateContract`, `WORK_ITEM_UPDATE_NAME`, `createWorkItemUpdateImplementation`, `WorkItemUpdateOutputSchema` - `core__work_item_update`: mirrors `PATCH /api/v1/work/items/{id}` one to one.  Success returns the same `WorkItemDto` the route returns (`WorkItemUpdateSuccessSchema`); a lost compare-and-set returns the typed `revision_conflict` result. Its input schema is `WorkItemPatchInputSchema` from `@cogni-dao/work-items` (the schema the route parses): `reason` is required (≤25 words, 240 chars) and `cites` is optional (≤8 hub atoms, pinned to commits by the store) (task.0086); `set.moves` (≤3 `{ metricId, direction }`, `[]` = none) names the metrics the item moves and the store pins the baseline (story.0033, needs work-items ^0.10.0); it requires `work_item:transition`, the scope the route declares through `sameDoor`
  - `WorkItemCapability`, `WorkItemInfo`, `WorkItemPatchScores`, `WorkItemQueryParams`, `WorkItemTransitionResult` - Work item capability types
  - `knowledgeReadBoundTool`, `KNOWLEDGE_READ_NAME`, `createKnowledgeReadImplementation` - Knowledge read tool (read_only: get by id or list by domain+tags)
  - `knowledgeSearchBoundTool`, `KNOWLEDGE_SEARCH_NAME`, `createKnowledgeSearchImplementation` - Knowledge search tool (read_only: text search by domain+query)
  - `knowledgeWriteBoundTool`, `KNOWLEDGE_WRITE_NAME`, `createKnowledgeWriteImplementation` - Knowledge write tool (state_change: upsert + auto dolt_commit)
  - `goalListBoundTool`, `GOAL_LIST_NAME`, `createGoalListImplementation` - DAO goal list tool (read_only: the node's approved `goal-*` atoms via `KnowledgeCapability.listActiveGoals`; never counted or truncated)
  - `KnowledgeCapability`, `KnowledgeEntry`, `KnowledgeWriteParams`, `CONFIDENCE` - Canonical-derived knowledge read types (see `@cogni/knowledge-store` for port + adapter)
  - `TOOL_CATALOG` - Singleton catalog of all core tool definitions (Record<string, CatalogBoundTool>)
  - `CORE_TOOL_BUNDLE` - Cross-node core tool array (all non-Polymarket tools); pass to createBoundToolSource. Poly node additionally imports POLY_TOOL_BUNDLE from `@cogni/poly-ai-tools`.
  - `createToolCatalog()`, `getToolById()`, `getToolIds()`, `hasToolId()` - Catalog accessors
  - `toBoundToolRuntime()`, `contractToRuntime()` - Runtime adapter converters (contractToRuntime for DI). A contract that declares `secretArgs` gets the scrubbing runtime
  - `REDACTION_MARKER`, `declaresSecretArgs()`, `SECRET_ARGS_UNAVAILABLE`, `SECRET_ARGS_VALIDATION_MESSAGE` - secret tool argument helpers and fixed strings
  - `ToolCapabilities`, `AuthCapability`, `ClockCapability`, `MetricsCapability`, `RepoCapability` - Capability interfaces
- **Files considered API:** `index.ts`, `types.ts`, `schema.ts`, `catalog.ts`, `runtime-adapter.ts`, `secret-args.ts`, `secret-args-lint.ts`, `capabilities/*.ts`, `tools/*.ts`

## Ports

- **Uses ports:** none
- **Implements ports:** none

## Responsibilities

- This directory **does**: Define pure tool contracts and implementations
- This directory **does not**: Import LangChain, make I/O calls (except pure Date), depend on src/

## Usage

```bash
pnpm --filter @cogni-dao/ai-tools typecheck
pnpm --filter @cogni-dao/ai-tools build
```

## Standards

- Pure implementations only (no I/O beyond pure functions)
- All exports must work in both browser and Node.js
- NO_LANGCHAIN: LangChain wrapping happens in `@cogni/langgraph-graphs`

## Dependencies

- **Build only:** `@cogni/ai-core` (structural types rolled up after tsc)
- **External:** `zod` (v4), `@cogni-dao/work-items` and `@cogni-dao/knowledge-store/contracts` (public domain peers)

## Change Protocol

- Update this file when public exports change
- Changes require updating `@cogni/langgraph-graphs` wrappers
- Coordinate with TOOL_USE_SPEC.md invariants

## Notes

- Per LANGGRAPH_AI.md: tool contracts live here, LangChain `tool()` wrappers in langgraph-graphs
- Per PACKAGES_NO_SRC_IMPORTS: This package cannot import from `src/**`
- Package isolation enables LangGraph Server to import tools without Next.js deps

Metric list/read/compute tools consume the public @cogni-dao/metrics contracts. createMetricTools binds an injected node service. Completed evidence is read through the same service as HTTP/UI.

Every non-`read_only` tool contract declares `requires = {scope, kind, subject}` (type `ToolRequires`); `tests/requires-guard.test.ts` fails CI for one without it. A node builds `requiresById` from these contracts and `@cogni-dao/agent-grants` `guardTools` enforces it. `core__metric_compute` is the tenth state-changing tool (story.5147 N3 names it `core__goal_progress`, which is read_only).

A tool that takes a credential declares it once: `secretArgs` on its contract, a list of input paths (dots for objects, `[]` for every item of an array). `toBoundToolRuntime` then returns a runtime whose `validateInput` returns a frozen copy with `[REDACTED]` at those paths (the real value sits in a `WeakMap` keyed by that copy, read only by `exec`), whose validation error is the fixed `Invalid tool arguments`, and whose exec errors, receipt lookups and output are scrubbed by exact match. A runner or guard that clones the copy makes `exec` fail closed with receipt `secret_args_unavailable`. No `spanInput`/`spanPort` may be wired on any `createToolRunner` call. `tests/secret-args-guard.test.ts` is a lint (credential-named field must be declared; declared path must be a string field; a `cogni_ag_sk_v2_` probe must not survive); `tests/secret-args.test.ts` proves the sinks. A contract with no `secretArgs` is unchanged.

Adopting 0.10.0 gives the scrub only. A node that declares a `secretArgs` tool must also add the app wiring the package cannot carry: (1) a run that offers any such tool masks every model call of that run (`maskContent` on the LlmCaller, set once the offered tools are known, because the model's own tool call and the next call that resends it reach the gateway's Langfuse logger raw); (2) its `ai.tool_call.error` line carries no `safeMessage` for such a tool; (3) its dev provider never offers them; (4) no `createToolRunner` call passes `spanInput`/`spanPort` (the runner hands them raw arguments before validation). Node-template's `inproc.provider.ts` is the reference. `secretArgsLeaks()`, `undeclaredCredentialFields()` and `declaredPathsNotStringFields()` are exported so a node can run the CI guard over its own bundle.
