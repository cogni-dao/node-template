# graph-execution-host · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

PURE_LIBRARY package providing graph execution decorator infrastructure — billing enrichment, usage commit, observability tracing, preflight credit check, and namespace routing. Consumed by all node apps and future worker-local execution (task.0181).

## Pointers

- [Graph Execution Spec](../../docs/spec/graph-execution.md)
- [Packages Architecture](../../docs/spec/packages-architecture.md)
- [GraphExecutorPort](../graph-execution-core/src/graph-executor.port.ts)

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

**Internal deps:** `@cogni/ai-core`, `@cogni/graph-execution-core`, `@cogni/node-shared`.

## Public Surface

- **Exports:** BillingEnrichmentGraphExecutorDecorator, UsageCommitDecorator, ObservabilityGraphExecutorDecorator, PreflightCreditCheckDecorator, NamespaceGraphRouter
- **Canonical execution:** `ManagedExecutionPort`, bounded `CanonicalRunResult`, `canonicalTerminal` admission and `publishCanonicalTerminal` presentation. SQL, authorization and migrations remain node-owned; provisional text never reaches terminal presentation.
- **Completion requests:** `scopeExecutionIdempotencyKey`, `completionRequestHash`, `reserveCompletionRequest`, `CompletionIdempotencyConflictError` and structural payload/reservation port types. Hosts inject the HMAC key and persistence port; the package never authenticates or starts workflows.
- **Port types:** LoggerPort, TracingPort, BillingIdentity, CommitUsageFactFn, PreflightCreditCheckFn, PlatformCreditChecker, GetTraceIdFn, CreateTraceWithIOParams, ObservabilityDecoratorConfig

## Responsibilities

- This directory **does**: Provide decorator implementations for billing, observability, and credit enforcement around GraphExecutorPort. Define minimal port interfaces satisfied by app implementations via structural typing.
- This directory **does not**: Read environment variables, manage process lifecycle, implement LLM adapters, or contain graph execution providers. Factory composition and provider registration remain app-local.

## Standards

- PURE_LIBRARY: No env vars, no process lifecycle, no @/ imports
- NO_SRC_IMPORTS: Never imports @/ or src/ paths
- Port interfaces are minimal projections of app-local ports (structural typing, not inheritance)
- No pino or @opentelemetry/api runtime dependencies; node:crypto is used only for deterministic request identity/HMAC with a host-injected key (graph-execution-package-design D9).

## Dependencies

- **Internal:** @cogni/ai-core, @cogni/graph-execution-core, @cogni/node-shared
- **External:** Node built-in crypto; all persistence/context dependencies injected via ports

## Notes

- Follow-up: extend ObservabilityGraphExecutorDecorator unit tests to the 4 terminal states (node-attribution covered in `observability-executor.decorator.spec.ts`)
- Follow-up: export Message from @cogni/ai-core barrel to eliminate PreflightCreditCheckFn cast in factories

## Change Protocol

- Update this file when **Exports** or **Dependencies** change
- Ensure `pnpm check` passes (includes arch:check for boundary violations)
