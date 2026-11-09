# knowledge-base-ui · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @cogni-dao
- **Status:** stable
- **Last reviewed:** 2026-11-09

## Purpose

Published React components and hooks every node renders for knowledge (Browse, Graph) and work surfaces (`@cogni-dao/knowledge-base-ui`, aliased `@cogni/knowledge-base-ui`). The package ships the whole capability: views, controls, their state contract and the bounded data hooks. A node supplies only its endpoints, auth, URL state and routing.

## Host requirements

- **QueryClientProvider is required.** `useWorkBoard`, `useWorkTablePage`, `useOpenWork`, `KnowledgeBrowse` / `useKnowledgeBrowse`, `KnowledgeGraph` / `useKnowledgeOverview` and `useKnowledgeRevision` call `@tanstack/react-query` 5 (`peerDependencies: "^5"`). Render them under the host's `QueryClientProvider`. Work hooks retry network/5xx only, never 4xx; knowledge hooks never retry automatically (`retry: false`: a failed window waits for the person's Retry). All accept `queryKeyPrefix` to scope their cache keys.
- Fetchers are node-supplied: `(params: URLSearchParams, signal: AbortSignal) => Promise<…>`. Reject with an error carrying the HTTP `status` so 4xx responses are not retried.
- Peer `@cogni/work-items` ≥ 0.7.0 supplies the work query codec, budgets and schemas; never re-declare limits or parameter names in a node.
- **Entry points.** `.` (work board, shared primitives, `DataTable`, `ConfidenceBar`, `CopyLinkButton`) never imports `@cogni/knowledge-store`. Knowledge Browse/Graph live on `./knowledge`; the WebGL renderer on the client-only `./graph-3d`.
- Optional peer `@cogni/knowledge-store` `>=0.12.0 <1` (required only for `./knowledge`) supplies the browse/overview query schemas from its browser-safe `/contracts` subpath. The package encodes requests with them (`knowledgeQueryToSearchParams`) and reads its budgets (20-row window, 50 × 500-char filter values, 2000-char search) from them; the node's routes parse with the same schemas.
- Optional peer `react-force-graph-3d` `>=1.29.1 <2` (required only for `./graph-3d`). The subpath never loads the engine at import; it is fetched after mount in a browser. Hosts lazy-load the subpath (e.g. `next/dynamic(() => import("@cogni/knowledge-base-ui/graph-3d"), { ssr: false })`).
- Knowledge fetchers: Browse/overview `(params: URLSearchParams, signal) => Promise<KnowledgeBrowsePage>`; citations `(id, cursor, signal) => Promise<{ links, nextCursor }>` returning at most 5 links per page (geometry draws the first 5).
- `entryTypeOptions` / `sourceTypeOptions` are required: the canonical lists live in the store root, not `/contracts`, so nodes pass `EntryTypeSchema.options` / `SourceTypeSchema.options`.

## Public Surface (work, task.0055)

- `WorkBoard` / `WorkBoardView` — render per-status column pages (`columns`, `onLoadMore`); there is no rows-from-an-array mode. Empty capped columns show "Search further (N scanned)"; columns the board budget did not reach show "Load".
- `useWorkBoard` — one board request, one page per Load more, aborts on change.
- `useWorkTablePage`, `clampWorkPageSize`, `workPageStackNext` / `workPageStackPrevious` — one table page per cursor; the node keeps the cursor and stack in its URL/history.
- `useOpenWork`, `openWorkSearchParams` — one request for the top 5 open items by rank.
- `workBoardTableStateToQuery`, `shouldRetryWorkBoardRequest`.

## Public Surface (knowledge, task.0059; `./knowledge` and `./graph-3d`)

- `KnowledgeBrowse` — the whole bounded Browse: table (`DataTable`), click-to-sort headers with `aria-sort`, exact-value filters in keyboard-reachable popovers (≤ 50 values), `DataTableColumnsPicker`, submit-only body search, Previous / Next or Continue search / Retry window / Restart, Clear filters (always window 1), revision prompt. Node supplies `fetchBrowse`, `initialData` (default first window only), `entryTypeOptions` / `sourceTypeOptions`, `onSelect` and its detail sheet as `children`.
- `useKnowledgeBrowse`, `useKnowledgeOverview` — one window at a time; a body search is requested once per rendered search window (mount with a search, submit, Continue, Previous, Restart, filter or sort change), never on focus, reconnect or invalidation; a query change resets to window 1 and the reset sticks (returning to an earlier query starts at 1); `reset()`; leaving a window aborts it; no automatic retry.
- `KnowledgeGraph` + `useGraphFocus` + `knowledgeFocusGeometry` — overview windows, replacement focus pages, ≤ 20 overview atoms, ≤ 5 typed edges, ≤ 26 nodes, palette, legend, escaped labels. The node passes `renderer` (the package's `KnowledgeForceGraph3D` from `./graph-3d`, lazy-loaded), `selectedId` / `onSelect` and the selected row from its own detail read.
- `KnowledgeForceGraph3D` (`./graph-3d`, also the default export) — the WebGL renderer node-template draws with.
- `createKnowledgeBrowseColumns`, `knowledgeBrowseTableStateToQuery`, `knowledgeQueryToSearchParams`, `knowledgeBrowseKey` / `knowledgeOverviewKey`, `useKnowledgeRevision`, `ConfidenceBar`, `CopyLinkButton`, budget constants.
- Shared primitives reused, not duplicated (root entry): `HeaderFilter` (adds `maxSelected`, `entryLabel`, `caption`), `WorkColumnHeader` (adds an optional `filter` popover, the work board's facet pattern), `DataTable` (keyboard rows that ignore keys aimed at inner controls).

## Boundaries

- Does not import node app code, routers, auth or environment.
- Does not fetch on its own: every request goes through an injected fetcher.
- Never imports a node's private `@cogni/*` packages (`node-ui-kit`, `node-contracts`); table, menu, popover, button and input primitives live in `src/ui` and `data-table.tsx`.
- The root entry never imports `@cogni/knowledge-store` or `react-force-graph-3d`; keep knowledge modules reachable only from `src/knowledge.ts` and the engine only through `src/graph-3d.tsx`'s dynamic import.
