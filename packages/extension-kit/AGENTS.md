# @cogni-dao/extension-kit · AGENTS.md

> Scope: this package only.

## Purpose

The host's side of the node plugin contract (https://node-template.cognidao.org/knowledge/node-plugin-architecture): the `NodeExtensions<Host>` aggregate of the extension points the owning packages export (`tools` from `@cogni-dao/ai-tools`, `routes` from `@cogni-dao/agent-grants`, type-only imports), `defineNodeExtensions`, `assertOwnedToolIds` (a node's tool ids share one `<node>__` prefix; `core__` is rejected) and `addOnly` (the add-only merge: a repeated key throws, naming the key and both sources).

## Invariants

- No runtime dependency and no node import. The two owning packages are type-only peers.
- Every export is `@beta` until a second node pins it.
- `@cogni-dao/agent-grants` keeps its own copy of the merge (`src/add-only.ts`): the kit's aggregate type imports agent-grants' types, so agent-grants cannot import the kit without a cycle.
