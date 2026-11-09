# knowledge-base-ui · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @cogni-dao
- **Status:** stable
- **Last reviewed:** 2026-11-08

## Purpose

Published React components and hooks every node renders for knowledge and work surfaces (`@cogni-dao/knowledge-base-ui`, aliased `@cogni/knowledge-base-ui`). The package ships the whole capability: views, controls, their state contract and the bounded data hooks. A node supplies only its endpoints, auth, URL state and routing.

## Host requirements

- **QueryClientProvider is required.** `useWorkBoard`, `useWorkTablePage` and `useOpenWork` call `@tanstack/react-query` 5 (`peerDependencies: "^5"`). Render them under the host's `QueryClientProvider`; the hooks set their own retry policy (network/5xx only, never 4xx) and accept `queryKeyPrefix` to scope their cache keys.
- Fetchers are node-supplied: `(params: URLSearchParams, signal: AbortSignal) => Promise<…>`. Reject with an error carrying the HTTP `status` so 4xx responses are not retried.
- Peer `@cogni/work-items` ≥ 0.7.0 supplies the query codec, budgets and schemas; never re-declare limits or parameter names in a node.

## Public Surface (work, task.0055)

- `WorkBoard` / `WorkBoardView` — render per-status column pages (`columns`, `onLoadMore`); there is no rows-from-an-array mode. Empty capped columns show "Search further (N scanned)"; columns the board budget did not reach show "Load".
- `useWorkBoard` — one board request, one page per Load more, aborts on change.
- `useWorkTablePage`, `clampWorkPageSize`, `workPageStackNext` / `workPageStackPrevious` — one table page per cursor; the node keeps the cursor and stack in its URL/history.
- `useOpenWork`, `openWorkSearchParams` — one request for the top 5 open items by rank.
- `workBoardTableStateToQuery`, `shouldRetryWorkBoardRequest`.

## Boundaries

- Does not import node app code, routers, auth or environment.
- Does not fetch on its own: every request goes through an injected fetcher.
