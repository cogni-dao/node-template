# knowledge-base-ui · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @cogni-dao
- **Status:** stable
- **Last reviewed:** 2026-11-10 (0.9.1)

## Purpose

Published React components and hooks every node renders for knowledge (Browse, Graph), goals (Goals board) and work surfaces (`@cogni-dao/knowledge-base-ui`, aliased `@cogni/knowledge-base-ui`). The package ships the whole capability: views, controls, their state contract and the bounded data hooks. A node supplies only its endpoints, auth, URL state and routing.

## Host requirements

- **QueryClientProvider is required.** `useWorkBoard`, `useWorkTablePage`, `useOpenWork`, `GoalsBoard` / `KpiChart` / `MetricEvidence` / `useGoalsProgress` (`./goals`), `KnowledgeBrowse` / `useKnowledgeBrowse`, `KnowledgeGraph` / `useKnowledgeGraph` and `useKnowledgeRevision` call `@tanstack/react-query` 5 (`peerDependencies: "^5"`). Render them under the host's `QueryClientProvider`. Work hooks retry network/5xx only, never 4xx; the Goals reads retry 2 (board) or 1 (badge) times and a 401 is final ("Signed out"); knowledge hooks never retry automatically (`retry: false`: a failed window waits for the person's Retry). All accept `queryKeyPrefix` to scope their cache keys.
- Fetchers are node-supplied: `(params: URLSearchParams, signal: AbortSignal) => Promise<…>`. Reject with an error carrying the HTTP `status` so 4xx responses are not retried.
- Peer `@cogni/work-items` ≥ 0.7.0 supplies the work query codec, budgets and schemas; never re-declare limits or parameter names in a node.
- **Entry points.** `.` (work board, shared primitives, `DataTable`, `ConfidenceBar`, `CopyLinkButton`) never imports `@cogni/knowledge-store`. Knowledge Browse/Graph live on `./knowledge`; the Goals board on `./goals`; the WebGL renderer on the client-only `./graph-3d`.
- Peer `@cogni-dao/metrics` `>=0.7.0 <1` (optional: only `./goals` needs it) supplies the wire schemas (`GoalsProgressSchema`, `MetricHistorySchema`, `MetricReadResponseSchema`, `MetricSnapshotSchema`) the Goals client parses with, and peer `recharts` `^2.15.4` draws the marks. Both are external in the bundle; Goals-free adopters may leave them uninstalled.
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
- `KnowledgeGraph` + `useKnowledgeGraph` — **the whole corpus**: every entry and citation drawn from one read per revision. Header row (0.9.1), in order: Confidence (default) | Domain segmented toggle; "Domain hubs" checkbox (checked; synthetic hub nodes and faint membership links on top of the complete data); Domain dropdown ("All domains", then "<domain> · <exact count>"); Type dropdown when the data has entry types ("All types", "<type> · <exact count>"). Dropdowns apply on select, client-side; no free-text inputs or apply buttons. Toggle, checkbox and bottom-left legend keep the pre-#264 GraphView classes and copy. `onEntriesChange({ shown, total, narrowed })` lets the page subtitle read "What this node has learned · N entries on main" or "Showing X of N entries". Clicking an entry highlights its neighbours from memory (`knowledgeGraphNeighbors`, no fetch) and calls `onSelect`; hubs are not selectable. A same-revision revalidation keeps the graph object so the layout survives. The node passes `renderer`, `selectedId` / `onSelect`; citation paging stays in the node's detail panel. `knowledgeGraphRenderData(graph, { hubs, domain, entryType })` builds the drawn data. Hosts define the legend's theme tokens `--height-knowledge-graph`, `--width-knowledge-graph-legend`, `--text-knowledge-graph-section`, `--text-knowledge-graph-stat`.
- `KnowledgeForceGraph3D` (`./graph-3d`, also the default export) — the WebGL renderer, with `KNOWLEDGE_GRAPH_3D_BUDGET`: no warm-up ticks, cooldown ≤ 300 ticks / 15 s, low-resolution spheres above 1,500 nodes, line links without particles or arrows above 2,000 links, labels on hover only. Large graphs draw cheaper, never fewer entries.
- `createKnowledgeBrowseColumns`, `knowledgeBrowseTableStateToQuery`, `knowledgeQueryToSearchParams`, `knowledgeBrowseKey` / `knowledgeOverviewKey`, `useKnowledgeRevision`, `ConfidenceBar`, `CopyLinkButton`, budget constants.
- Shared primitives reused, not duplicated (root entry): `HeaderFilter` (adds `validate`, `entryLabel`, `caption`), `WorkColumnHeader` (adds an optional `filter` popover, the work board's facet pattern), `DataTable` (keyboard rows that ignore keys aimed at inner controls).

## Public Surface (goals, task.0062; `./goals`)

- `GoalsBoard` — the whole Goals view. Props: `initialData` (SSR seed, exact `GET /api/v1/metrics/goals` shape), `goalId` (one goal, no strip, first KPI open), `onSignedOut`, and the host options `client`, `queryKeyPrefix`, `hrefs` (`goal`, `metric`, `observation`, `help`; defaults `/knowledge/...`), `LinkComponent` (default `<a>`; pass `next/link`). `KpiChart` (open chart + `RangeToggle` 1D/1W/1M/3M), `MetricEvidence` (`id`, `observationId` from the node's `?observation=`), `KpiEvidence` (a hypothesis page's KPI evidence from `kpiBindings` and the subject projection's `kpis`; links from `hrefs.metric` / `hrefs.observation`), `StatusPill`/`ProgressBar`/`Sparkline`/`AvailabilityStrip`, `GoalsProvider` / `useGoalsHost`.
- `createGoalsClient({ baseUrl = '/api/v1/metrics', fetch, init })` — GET-only reads parsed with the metrics schemas; a failure throws `GoalsReadError` carrying `status` (`goalsErrorStatus` reads `status` from any fetcher's error). A node adds auth through `fetch`/`init` or replaces the whole `GoalsClient`.
- `useGoalsProgress({ initialData, poll, enabled })` — the one cached progress read: `poll: true` (board) refreshes every 30 s only while the page is visible; `poll: false` (a tab badge) reads once per freshness window, never on focus. `attentionCount`, `goalNeedsAttention`, `summarize`, `STATUS_META`, `REASON_TEXT`, `formatValue`, `GOALS_QUERY_KEY`.

### Goals UI rules (moved from the app feature; each is tested in `tests/goals-*.test.*`)

- Read at a glance. The board is a count strip (goals and KPIs counted once each; every status count is a count of KPIs), then one collapsible row per goal (title as header, KPI count, most urgent status, due date). Inside a row, one card per KPI: label, number, at most one short hint, a status pill and one mark. No sentences on the board; the plain-words reason (`REASON_TEXT`, exhaustive by type) is the card toggle's accessible description and hover title.
- Display type comes from the read model (`kpi.metric.display`; see packages/metrics/AGENTS.md). The UI never guesses from units. progress = bar toward target; volume = gradient sparkline + change since the bucket of its first reading; slo = availability bars + error budget against a >= objective (axis to 100) or <= objective (axis from 0), values truncated (never rounded up to 100%). One formatter (`formatValue`) prints a reading everywhere.
- Status comes from `assessKpi` only; the UI never re-derives it. Cards are keyed by binding position plus metric id (a goal may bind one metric twice; a shifted binding closes the open chart). The whole card is one toggle button whose accessible description carries value, status, hint and reason. Every status shows a symbol and a word (`STATUS_META`); color is redundant.
- Unknown is not zero: no reading is "—" (`aria-label="No reading"`), never 0; delayed and failing values are muted.
- Quiet refresh: a failed poll keeps the data silently; only `STALE_AFTER_FAILURES` consecutive failures mark it "Stale"; a 401 (any error with `status` 401) says "Signed out" and calls `onSignedOut` (default reload).
- Gaps stay gaps (`connectNulls={false}`); the newest reading after the last closed bucket is its own point. A card draws the 30-day daily `trend` once it has `MIN_DAILY_SHAPE` readings, else the 24-hour `recent`; the open chart starts on 1D until then. Every history read is one aligned window of at most 400 buckets.
- Recharts 2 renders only its own element types as direct chart children: pass arrays, never Fragments or wrapper components. Every chart and series takes a `useChartId` id (SSR-stable). No animation.
- The open chart is a `figure` named by the metric title; a collapsed "Readings" list is the keyboard path to each observation (links come from `hrefs.observation`). Operational IDs stay behind those links.
- The UI only reads; the worker computes. Read the canonical complete active-goal list; never bridge missing history, invent expected values or present stale readings as current.

- **Theme tokens (`./goals`).** The board uses the host's Tailwind theme and ships no CSS: `text-success` / `border-success` / `bg-success`, `text-warning` / `bg-warning`, `text-destructive` / `bg-destructive`, `text-muted-foreground` / `bg-muted`, `text-foreground` / `bg-background`, `bg-accent` / `text-accent-foreground`, `ring-ring` / `border-ring`, `border-border` / `border-input`, and the chart colour `--chart-1` (read as `hsl(var(--chart-1))`). A theme missing one renders that part unstyled, never wrong.
- **Mount the board on its own tab.** Knowledge mounts `GoalsBoard` only on `?mode=goals`, so its 30 s poll (`refetchIntervalInBackground: false`) runs only while that tab is selected; the tab badge uses `useGoalsProgress({ poll: false, enabled })` and never polls. Wrap the badge and every Goals component in **one** `GoalsProvider` (client, `queryKeyPrefix`, `hrefs`, `LinkComponent`): a hook outside it reads the default client and unprefixed key, so board and badge would stop sharing a cache entry (tested).

## Public Surface (html visuals, story.0027)

- `KnowledgeHtmlFrame` — the sandboxed iframe for `entryType=html`. **FINAL_SRCDOC_AT_INSERT:** each iframe is inserted with its final normalized `srcdoc` and never mutated; a new document mounts a new iframe. Before the client can normalize, it renders a same-size `aria-busy` placeholder. (Chrome isolates sandboxed frames in their own process, and a `srcdoc` write during the first navigation committed an empty frame.) Height defaults to `var(--height-artifact-canvas, 720px)`. The node passes the themed document, `title` and `className`; it never keys or remounts the frame itself.

## Boundaries

- Does not import node app code, routers, auth or environment.
- Does not fetch on its own: every request goes through an injected fetcher.
- Never imports a node's private `@cogni/*` packages (`node-ui-kit`, `node-contracts`); table, menu, popover, button and input primitives live in `src/ui` and `data-table.tsx`.
- `./goals` imports no router (`next/*`), no `@/` app path and no node UI kit; links are the injected `LinkComponent`. Only `src/goals.ts` reaches `src/goals/`; the root entry never imports `@cogni-dao/metrics` or `recharts`.
- The root entry never imports `@cogni/knowledge-store` or `react-force-graph-3d`; keep knowledge modules reachable only from `src/knowledge.ts` and the engine only through `src/graph-3d.tsx`'s dynamic import.
