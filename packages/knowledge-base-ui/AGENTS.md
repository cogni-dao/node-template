# knowledge-base-ui · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @cogni-dao
- **Status:** stable
- **Last reviewed:** 2026-11-09

## Purpose

Published React components and hooks every node renders for knowledge (Browse, Graph) and work surfaces (`@cogni-dao/knowledge-base-ui`, aliased `@cogni/knowledge-base-ui`). The package ships the whole capability: views, controls, their state contract and the bounded data hooks. A node supplies only its endpoints, auth, URL state and routing.

## Host requirements

- **QueryClientProvider is required.** `useWorkBoard`, `useWorkTablePage`, `useOpenWork`, `KnowledgeBrowse` / `useKnowledgeBrowse`, `KnowledgeGraph` / `useKnowledgeGraph` and `useKnowledgeRevision` call `@tanstack/react-query` 5 (`peerDependencies: "^5"`). Render them under the host's `QueryClientProvider`. Work hooks retry network/5xx only, never 4xx; knowledge hooks never retry automatically (`retry: false`: a failed window waits for the person's Retry). All accept `queryKeyPrefix` to scope their cache keys.
- Fetchers are node-supplied: `(params: URLSearchParams, signal: AbortSignal) => Promise<…>`. Reject with an error carrying the HTTP `status` so 4xx responses are not retried.
- Peer `@cogni/work-items` ≥ 0.7.0 supplies the work query codec, budgets and schemas; never re-declare limits or parameter names in a node.
- **Entry points.** `.` (work board, shared primitives, `DataTable`, `ConfidenceBar`, `CopyLinkButton`) never imports `@cogni/knowledge-store`. Knowledge Browse/Graph live on `./knowledge`; the WebGL renderer on the client-only `./graph-3d`.
- Peer `@cogni/knowledge-store` `>=0.13.0 <1` (marked optional because only `./knowledge` needs it) supplies, from its browser-safe `/contracts`: the browse query/page schemas (pages carry the exact filtered `total`), the exported browse constants (`KNOWLEDGE_BROWSE_PAGE_SIZE`, …) and `KnowledgeGraphResponseSchema`. The package encodes requests with the schemas (`knowledgeQueryToSearchParams`), validates user input by parsing it with `KnowledgeBrowseQuerySchema` (`knowledgeQueryIssue`, in plain words such as "Choose at most 50 values.") and imports the page size for "Showing 21–40 of N". **It copies no numeric limits.**
- Peer `react-force-graph-3d` `>=1.29.1 <2` is a **required** peer of `./graph-3d`. Work-board-only adopters never import `./graph-3d` (nothing in `.` or `./knowledge` loads the engine), so they may leave it uninstalled; pnpm only reports the unmet peer. The subpath imports the engine only after mount (it touches `window` at load); hosts lazy-load the subpath (`next/dynamic(() => import("@cogni/knowledge-base-ui/graph-3d"), { ssr: false })`). No runtime fallback.
- Knowledge fetchers: Browse `(params: URLSearchParams, signal) => Promise<KnowledgeBrowsePage>`; Graph `(signal, ifNoneMatch?) => Promise<KnowledgeGraphResponse | null>`, the whole corpus at one revision: send `ifNoneMatch` (the cached revision's entity tag) as `If-None-Match` with `cache: "no-store"` and resolve `null` on 304, so an unchanged graph is neither downloaded nor re-parsed. Serve the route with `readKnowledgeGraph` from `@cogni/knowledge-store` (it owns ETag/304, the per-revision read and the budget).
- `entryTypeOptions` / `sourceTypeOptions` are required: the canonical lists live in the store root, not `/contracts`, so nodes pass `EntryTypeSchema.options` / `SourceTypeSchema.options`.

## Public Surface (work, task.0055)

- `WorkBoard` / `WorkBoardView` — render per-status column pages (`columns`, `onLoadMore`); there is no rows-from-an-array mode. Empty capped columns show "Search further (N scanned)"; columns the board budget did not reach show "Load".
- `useWorkBoard` — one board request, one page per Load more, aborts on change.
- `useWorkTablePage`, `clampWorkPageSize`, `workPageStackNext` / `workPageStackPrevious` — one table page per cursor; the node keeps the cursor and stack in its URL/history.
- `useOpenWork`, `openWorkSearchParams` — one request for the top 5 open items by rank.
- `workBoardTableStateToQuery`, `shouldRetryWorkBoardRequest`.

## Public Surface (knowledge, task.0059; `./knowledge` and `./graph-3d`)

- `KnowledgeBrowse` — the whole bounded Browse: table (`DataTable`), click-to-sort headers with `aria-sort`, exact-value filters in keyboard-reachable popovers (validated by the store query schema), `DataTableColumnsPicker`, submit-only body search, Previous / Next or Continue search / Retry window / Restart, Clear filters (always window 1), revision prompt. Node supplies `fetchBrowse`, `initialData` (default first window only), `entryTypeOptions` / `sourceTypeOptions`, `onSelect` and its detail sheet as `children`.
- `useKnowledgeBrowse` — one window at a time, with `windowIndex` and the exact filtered `total`; a body search is requested once per rendered search window (mount with a search, submit, Continue, Previous, Restart, filter or sort change), never on focus, reconnect or invalidation; a query change resets to window 1 and the reset sticks (returning to an earlier query starts at 1); `reset()`; leaving a window aborts it; no automatic retry.
- `KnowledgeGraph` + `useKnowledgeGraph` — **the whole corpus**: every entry and citation drawn at once from one read per revision, with exact counts ("5,046 entries · 12,300 citations"), domain (default) or confidence coloring, client-side narrowing by text/domain over the loaded set ("Showing X of N"), neighbor highlighting from the in-memory edge set (`knowledgeGraphNeighbors`, no fetch), exact-id open, escaped labels. A same-revision revalidation keeps the graph object so the layout survives. The node passes `renderer`, `selectedId` / `onSelect`; citation paging stays in the node's detail panel.
- `KnowledgeForceGraph3D` (`./graph-3d`, also the default export) — the WebGL renderer, with `KNOWLEDGE_GRAPH_3D_BUDGET`: no warm-up ticks, cooldown ≤ 300 ticks / 15 s, low-resolution spheres above 1,500 nodes, line links without particles or arrows above 2,000 links, labels on hover only. Large graphs draw cheaper, never fewer entries.
- `createKnowledgeBrowseColumns`, `knowledgeBrowseTableStateToQuery`, `knowledgeQueryToSearchParams`, `knowledgeBrowseKey` / `knowledgeOverviewKey`, `useKnowledgeRevision`, `ConfidenceBar`, `CopyLinkButton`, budget constants.
- Shared primitives reused, not duplicated (root entry): `HeaderFilter` (adds `validate`, `entryLabel`, `caption`), `WorkColumnHeader` (adds an optional `filter` popover, the work board's facet pattern), `DataTable` (keyboard rows that ignore keys aimed at inner controls).

## Boundaries

- Does not import node app code, routers, auth or environment.
- Does not fetch on its own: every request goes through an injected fetcher.
- Never imports a node's private `@cogni/*` packages (`node-ui-kit`, `node-contracts`); table, menu, popover, button and input primitives live in `src/ui` and `data-table.tsx`.
- The root entry never imports `@cogni/knowledge-store` or `react-force-graph-3d`; keep knowledge modules reachable only from `src/knowledge.ts` and the engine only through `src/graph-3d.tsx`'s dynamic import.
