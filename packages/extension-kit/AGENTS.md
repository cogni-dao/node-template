# @cogni-dao/extension-kit · AGENTS.md

> Scope: this package only.

## Purpose

The host's side of the node plugin contract (https://node-template.cognidao.org/knowledge/node-plugin-architecture): the `NodeExtensions<Host>` aggregate of the extension points the owning packages export (`tools` from `@cogni-dao/ai-tools`, `routes` from `@cogni-dao/agent-grants`, type-only imports), `defineNodeExtensions`, `assertOwnedToolIds` (a node's tool ids share one `<node>__` prefix; `core__` is rejected) and `addOnly` (re-exported from agent-grants: a repeated key throws, naming the key and both sources).

## Invariants

- No node import. `@cogni/ai-tools` is a type-only peer; `@cogni/agent-grants` is a peer the kit re-exports `addOnly` from at runtime (floor 0.11.0, the minor that carries `composeAgentRoutes`).
- ONE add-only merge: it lives in agent-grants (`src/add-only.ts`); the kit re-exports it and has no copy. agent-grants never imports the kit, so there is no cycle.
- Every export is `@beta` until a second node pins it.
