# app · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Last reviewed:** 2026-10-27
- **Status:** draft

## Purpose

Next.js App Router delivery layer. UI pages and API routes that expose features to external clients.

## Pointers

- [Root AGENTS.md](../../../../AGENTS.md)
- [Architecture](../../../../docs/spec/architecture.md)
- [Feature Development Guide](../../../../docs/guides/feature-development.md)

## Boundaries

```json
{
  "layer": "app",
  "may_import": [
    "app",
    "features",
    "ports",
    "shared",
    "contracts",
    "types",
    "components",
    "styles"
  ],
  "must_not_import": ["adapters/server", "adapters/worker", "core"]
}
```

## Public Surface

- **Exports:** none
- **Route Groups:**
  - `(public)`: Unauthenticated pages (landing, marketing, docs)
  - `(app)`: Protected pages requiring authentication (chat, billing, etc.)
  - `(admin)`: DAO-admin pages gated by `activity_ledger.approvers` (server-side wallet check)
  - `(infra)`: Infrastructure endpoints (health, meta, openapi)
  - `api`: Versioned JSON APIs (v1, v2, etc.)
- **Routes (if any):**
  - Public pages: `/` (homepage via `(public)/page.tsx`)
  - Schedule pages: `/schedules` (active/paused configuration), `/schedules/[scheduleId]` (owned history linking to existing chat threads)
  - Development-only: `/dev/finance-preview` — actual Financials/shell fixture preview; production/test → 404; isolated disabled treasury query cache
  - Protected pages: `/chat` (via `(app)/chat/page.tsx`)
  - Infra: `/health`, `/openapi.json`, `/meta/route-manifest` (via `(infra)/*`)
  - API: `/api/auth/*`, `/api/v1/chat/completions`, `/api/v1/work/summaries`, `/api/v1/work/board`
  - Internal ops: `/api/internal/ops/governance/schedules/sync` [POST] (deploy-only trigger)
  - Agent discovery: `/.well-known/agent.json` [GET] — public discovery document for machine clients
- **Files considered API:** layout.tsx, page.tsx, loading.tsx, error.tsx, api/\*\*/route.ts, (infra)/\*\*/route.ts, .well-known/\*\*/route.ts
- **Suspense / error boundaries:** each route group exposes a
  `loading.tsx` + `error.tsx`. `(app)/loading.tsx` renders the shared
  `BrainLoading` indicator inside the sidebar shell. `/chat` uses that same
  indicator for route streaming and client model/credits/thread readiness;
  its route loading boundary also covers `useSearchParams()`. Other routes
  (`/dashboard`, `/work`, `/credits`, `/activity`, `/gov/*`)
  override with a per-route `loading.tsx` that mirrors the page's
  macro layout. `(public)/loading.tsx` renders the marketing-shaped
  skeleton (Hero + cards + feed) used by `/`; `propose/merge`
  overrides with a form skeleton. Reusable primitives
  (`PageHeaderSkeleton`, `TableSkeleton`, `CardGridSkeleton`) live
  under `kit/layout/`. **Forks inheriting this template inherit the
  skeleton pattern.**

## Responsibilities

- This directory **does**: expose UI pages and HTTP endpoints; validate requests with contracts
- This directory **does not**: contain business logic, port implementations, or direct database access

## Usage

```bash
pnpm dev     # start dev server
pnpm build   # build for production
```

## Standards

- API routes must validate input/output with contracts
- UI pages use features and components only
- No business logic in routes or pages

## Route Group Conventions

- **`(public)/*`**: Unauthenticated UI pages. No auth guard. Landing page, marketing, docs.
- **`(app)/*`**: Protected UI pages. Primary auth routing is enforced by `proxy.ts` before the app shell renders; server page checks may remain as defense-in-depth. Do NOT add client-side auth redirects.
- **`(admin)/*`**: DAO-admin pages. Login gate via `proxy.ts` matcher; role gate via server-side `(admin)/layout.tsx` checking the SIWE wallet against `getLedgerApprovers()` (repo-spec `activity_ledger.approvers`). Non-approvers redirect to `/dashboard`. See `(admin)/AGENTS.md`.
- **`(infra)/*`**: Infrastructure endpoints. Explicitly unauthenticated. Health checks, meta, OpenAPI specs.
- **`api/*`**: JSON APIs. Keep under `api/v1/**` for versioned endpoints. Auth enforced per-route using `auth()` calls in route handlers (not via layout).

When adding new protected pages (e.g., `/billing`, `/api-keys`), place them under `(app)/*` and rely on the layout's auth guard. When adding new APIs, keep them under `api/v1/**` and add explicit `auth()` checks in route handlers.

## Dependencies

- **Internal:** features, contracts, shared, components
- **External:** next, react

## Change Protocol

- Update this file when **Routes** change
- Bump **Last reviewed** date
- Ensure contract validation passes

## Notes

- Uses Next.js App Router patterns
- API routes are thin adapters that delegate to features

Goals and KPIs live in the Knowledge `?mode=goals` tab; there is no dedicated KPI page. /api/v1/metrics exposes list, detail/history, ranged `/{id}/history` buckets, goal progress (`/goals`), exact immutable observation reads and live computation; subject projections share goal/hypothesis observation identities.

Goals mount (task.0062): the Goals board, KPI chart and evidence view render only from `@cogni/knowledge-base-ui/goals` (node mount: `(app)/knowledge/_components/GoalsMount.tsx`: Next `Link`, `?observation=`, the tab badge read). The seven `/api/v1/metrics/*` routes keep only auth, path parameters, logging and `metricResponse`; parsing, contract validation and error mapping are `@cogni-dao/metrics/http` (`_facades/metrics.server.ts` binds its ports to the container).
