# knowledge-base-ui · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @cogni-dao
- **Status:** stable
- **Last reviewed:** 2026-11-09

## Purpose

Published React components and hooks every node renders for knowledge (Browse, Graph) and work surfaces (`@cogni-dao/knowledge-base-ui`, aliased `@cogni/knowledge-base-ui`). The package ships the whole capability: views, controls, their state contract and the bounded data hooks. A node supplies only its endpoints, auth, URL state and routing.

## Host requirements

- **QueryClientProvider is required.** `useWorkBoard`, `useWorkTablePage`, `useOpenWork`, `KnowledgeBrowse` / `useKnowledgeBrowse`, `KnowledgeGraph` / `useKnowledgeOverview` and `useKnowledgeRevision` call `@tanstack/react-query` 5 (`peerDependencies: "^5"`). Render them under the host's `QueryClientProvider`; the hooks set their own retry policy (network/5xx only, never 4xx) and accept `queryKeyPrefix` to scope their cache keys.
- Fetchers are node-supplied: `(params: URLSearchParams, signal: AbortSignal) => Promise<…>`. Reject with an error carrying the HTTP `status` so 4xx responses are not retried.
- Peer `@cogni/work-items` ≥ 0.7.0 supplies the work query codec, budgets and schemas; never re-declare limits or parameter names in a node.
- Peer `@cogni/knowledge-store` ^0.12.0 supplies the knowledge browse/overview query schemas and the 20-row page (`/contracts` subpath only, browser-safe). The package encodes requests with it (`knowledgeQueryToSearchParams`); the node's routes parse them with the same schema.
- Knowledge fetchers: Browse/overview `(params: URLSearchParams, signal) => Promise<KnowledgeBrowsePage>`; citations `(id, cursor, signal) => Promise<{ links, nextCursor }>`.

## Public Surface (work, task.0055)

- `WorkBoard` / `WorkBoardView` — render per-status column pages (`columns`, `onLoadMore`); there is no rows-from-an-array mode. Empty capped columns show "Search further (N scanned)"; columns the board budget did not reach show "Load".
- `useWorkBoard` — one board request, one page per Load more, aborts on change.
- `useWorkTablePage`, `clampWorkPageSize`, `workPageStackNext` / `workPageStackPrevious` — one table page per cursor; the node keeps the cursor and stack in its URL/history.
- `useOpenWork`, `openWorkSearchParams` — one request for the top 5 open items by rank.
- `workBoardTableStateToQuery`, `shouldRetryWorkBoardRequest`.

## Public Surface (knowledge, task.0059)

- `KnowledgeBrowse` — the whole bounded Browse: table (`DataTable`), header sort + exact filters (≤ 50 values), `DataTableColumnsPicker`, submit-only body search, Previous / Next or Continue search / Retry window / Restart, revision prompt. Node supplies `fetchBrowse`, `initialData` (default first window only), known `entryTypeOptions` / `sourceTypeOptions`, `onSelect` and its detail sheet as `children`.
- `useKnowledgeBrowse`, `useKnowledgeOverview` — one window at a time; body search only on intent; window resets on query change; leaving a window aborts it; no automatic retry.
- `KnowledgeGraph` + `useGraphFocus` + `knowledgeFocusGeometry` — overview windows, replacement focus pages, ≤ 20 overview atoms, ≤ 5 typed edges, ≤ 26 nodes, palette, legend, escaped labels. **The drawing engine stays node-local**: the node injects `renderer` (node-template wraps `react-force-graph-3d` via `next/dynamic`, a heavy `window`-bound engine), plus `selectedId` / `onSelect` and the selected row from its own detail read.
- `createKnowledgeBrowseColumns`, `knowledgeBrowseTableStateToQuery`, `knowledgeQueryToSearchParams`, `knowledgeBrowseKey` / `knowledgeOverviewKey`, `useKnowledgeRevision`, `ConfidenceBar`, `CopyLinkButton`, budget constants.
- Shared primitives reused, not duplicated: `HeaderFilter` (adds `maxSelected`, `entryLabel`, `caption`), `WorkColumnHeader` (adds a `filter` menu with Asc/Desc).

## Boundaries

- Does not import node app code, routers, auth or environment.
- Does not fetch on its own: every request goes through an injected fetcher.
- Never imports a node's private `@cogni/*` packages (`node-ui-kit`, `node-contracts`); table, menu, popover, button and input primitives live in `src/ui` and `data-table.tsx`.
