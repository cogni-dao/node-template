# bootstrap/ai · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** stable

## Purpose

AI tool bindings and tool source factory. Wires tool implementations with injected capabilities at bootstrap time.

## Pointers

- [Tool Use Spec](../../../../../docs/spec/tool-use.md)
- [Tools Authoring](../../../../../docs/guides/tools-authoring.md)

## Boundaries

```json
{
  "layer": "bootstrap",
  "may_import": ["bootstrap"],
  "must_not_import": ["app", "features", "core", "adapters"]
}
```

## Public Surface

- **Exports:** `createToolBindings()`, `createBoundToolSource()`, `ToolBindings`, `ToolBindingDeps`, `NODE_LOCAL_TOOL_BUNDLE`, `NODE_LOCAL_TOOL_BINDINGS`, `NODE_LOCAL_CATALOG`, `secretProbeBoundTool`
- **Files considered API:** `tool-bindings.ts`, `tool-source.factory.ts`, `secret-probe.ts`

## Responsibilities

- This directory **does**: Wire tool implementations with capabilities, create ToolSourcePort
- This directory **does not**: Execute tools, contain business logic

## Usage

```bash
# Consumed by container.ts automatically
```

## Standards

- Per CAPABILITY_INJECTION: implementations receive capabilities at construction

## Dependencies

- **Internal:** bootstrap
- **External:** `@cogni/ai-core`, `@cogni/ai-tools`

## Change Protocol

- Add new tools to `tool-bindings.ts` when adding to TOOL_CATALOG

## Notes

- Per TOOL_BINDING_REQUIRED: createBoundToolSource throws if any catalog tool lacks binding
- `secret-probe.ts` is the node-local probe (task.0093): a `read_only` tool that declares `secretArgs: ["secret"]` (output `{ok, length}`) and the `secret-probe` graph that offers only it. It is composed into the tool source (`container.ts`) and the in-proc provider's node catalog (`graph-executor.factory.ts`), is executable by graph id `langgraph:secret-probe`, and is not advertised by agent discovery.
