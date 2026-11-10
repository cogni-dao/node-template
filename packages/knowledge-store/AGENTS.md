# knowledge-store · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Last reviewed:** 2026-11-05
- **Owners:** @derekg1729
- **Status:** stable

## Purpose

Shared ports, contribution workflow, and adapters for versioned domain knowledge backed by Doltgres. Generic schema lives in `@cogni/knowledge-base`; each node may add companion tables and niche seeds.

## Pointers

- [Spec](../../docs/spec/knowledge-data-plane.md) — authoritative design
- [task.0231](../../work/items/task.0231.knowledge-data-plane.md) — port + adapter
- [task.0311](../../work/items/task.0311.poly-knowledge-syntropy-seed.md) — candidate-a wiring, clean-slate seeds, Doltgres 0.56 RBAC workaround
- [Design doc](../../docs/design/knowledge-data-plane-prototype.md) — spike results + agent tooling roadmap
- [proj.poly-prediction-bot](../../work/projects/proj.poly-prediction-bot.md) — parent project

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

**External deps:** `@cogni-dao/doltgres-admission` (bundled engine protocol), `zod` (schema validation), `postgres` (Doltgres wire protocol — adapter subpath only).

## Public Surface

**Root barrel** (`@cogni/knowledge-store`):

- Read serialization: `toKnowledgeRow` — canonical wire fields with Date/null/default normalization
- Types: `KnowledgeStorePort`, `KnowledgeWriteSession` (closed callback scope), `Knowledge`, `NewKnowledge`, `DoltCommit`, `DoltDiffEntry`, `SourceType`
- Schemas: `KnowledgeSchema`, `NewKnowledgeSchema`, `DoltCommitSchema`, `DoltDiffEntrySchema`, `SourceTypeSchema`
- Goal layer (story.5101): `KnowledgeStorePort.listActiveGoals()` (required port method, NO_GOAL_CAP), `ActiveGoal`, `GOAL_ENTRY_TYPE`, `GOAL_ID_PREFIX`, `GOAL_RETIRING_EDGE`, `isGoalRowId`, `selectActiveGoals`, `resolveGoals`, `renderGoalsLines`, `GOALS_BOOTSTRAP_INSTRUCTION`, `GoalsSection`, `GoalRequiresContributionError` (direct writes never touch goals), `createKnowledgeCapability(...).listActiveGoals` (for `core__goal_list`)
- Governing discovery: `listGoverningIndex()`, `GOVERNING_ENTRY_TYPES`, `isGoverningEntryType`, `selectGoverningIndex`, `GoverningIndexRow` — content-free, uncapped, nonblank triggers, no superseded targets. Doltgres and fake adapters use this same selector.
- Session cognition (bug.0018, 0.14.0): `readCognitionSnapshot(port, orientationIds, options?)` returns `{ snapshot: { revision, domains, governingIndex, orientation, goals, readMs }, memoHit, stale, staleReason? }`. It holds domains with entries, the projected governing index, active goals, and the first existing orientation body (the candidates are looked up in parallel). Nothing else is read. One HEAD check is shared per port and is abandoned only after `COGNITION_HEAD_ABANDON_MS`. Late, older HEAD results are ignored. One read runs per revision, and only a complete snapshot that started after the kept one is kept. Once a complete snapshot exists, a slow or failed HEAD check (`COGNITION_REVISION_DEADLINE_MS` 250) or a slow, failed or degraded fresh read (`COGNITION_FRESH_READ_DEADLINE_MS` 600) serves it `stale`, for up to `COGNITION_MAX_STALE_MS` (900 s, the session loader TTL) since HEAD last confirmed it. This bounded stale window is a deliberate exception to the knowledge-read-path-hosting rule "no stale window", made for bootstrap latency. A caller with nothing to serve waits up to `COGNITION_COLD_DEADLINE_MS` (5 s), then gets `CognitionUnavailableError`, which the route answers with a retryable 503. Headers: `cognitionEtag` (null for a stale, degraded or hubless bundle, so a stale bundle is never 304-confirmed), `cognitionEtagMatches`, `cognitionServerTiming` and `COGNITION_CACHE_CONTROL`. Goal KPI readings are not part of cognition; agents read `GET /api/v1/metrics/goals`.
- Node-admin seam: `NodeAdminAuthority`, `NodeAdminActor`, `NodeAdminDecision`, `checkNodeAdmin`, `isPrivilegedPriority` (priority <= 1), `NodeAdminRequiredError`, `touchesGoalLayer`, `TouchedCitation`

**Pure subpath** (`@cogni/knowledge-store/contracts`):

- Bounded `KnowledgeSummarySchema`, Browse/Overview query/page schemas and inferred types; `browseKnowledge` / `overviewKnowledge` port methods project metadata globally and bind continuations to query and operation. Search consumes twenty candidate bodies per explicit window. Both pages carry the observed committed HEAD (not a snapshot token) and `total`: the exact count for the window's filters (one `COUNT(*)` read per window inside the same budget; with `search`, the candidate set). Browse limits are exported constants (`KNOWLEDGE_BROWSE_PAGE_SIZE`, `KNOWLEDGE_BROWSE_FILTER_VALUES_MAX`, `KNOWLEDGE_BROWSE_FILTER_VALUE_MAX_LENGTH`, `KNOWLEDGE_BROWSE_SEARCH_MAX_LENGTH`, `KNOWLEDGE_BROWSE_CURSOR_MAX_LENGTH`) that the schemas and adapters use; consumers import them instead of copying. Totals are remembered per (revision, filters) in the adapter, so Next windows never recount. `KnowledgeGraphResponseSchema` (contracts) is the whole-corpus graph wire shape. `readKnowledgeGraph(port, { ifNoneMatch, signal })` is the framework-agnostic graph route handler (`{ status: 200|304|503, headers, body, log }`): ETag = HEAD and 304 without a read; one pinned read per revision per port (counts + serialized body memoized; concurrent callers share the in-flight read; failures forgotten); retryable 503 on deadline/abort/failure; `knowledge.graph_read` logs counts, bytes and `budgetExceeded` against the exported budget (`KNOWLEDGE_GRAPH_ENVELOPE_BYTES_BUDGET` + `KNOWLEDGE_GRAPH_NODE_BYTES_BUDGET`/node + `KNOWLEDGE_GRAPH_EDGE_BYTES_BUDGET`/edge, capped at `KNOWLEDGE_GRAPH_RESPONSE_BYTES_BUDGET`). The port's `readKnowledgeGraphSnapshot` reads HEAD, domains, projected nodes and `id, citing_id, cited_id, citation_type` citations, then HEAD again (retrying if it moved), under the `graphTimeoutMs` deadline (default 30s) and the shared read admission (0.13.0, task.0059).
- Canonical `KnowledgeRowSchema` / `KnowledgeRow`, knowledge and EDO capability contracts, parameters and results. No adapters or capability implementations.
- History wire schemas (story.0023): `HistoryEntrySchema`, `HistoryOutputSchema`, `HistoryOutput`, `knowledgeHistoryOperation`. Root also exports `readKnowledgeHistory(port, id)`: a framework-agnostic handler returning `{ status, body, log }` (200, 404, 503; never throws).

**Subpath** (`@cogni/knowledge-store/adapters/doltgres`):

- `DoltgresKnowledgeStoreAdapter` (`withWrite` required for mutations), `DoltgresAdapterConfig` (injected shared writer session; optional finite `browseTimeoutMs`, default 15s), `buildDoltgresClient`, `DoltgresClientConfig`
- `DomainSql`, `getDoltgresDomain`, `updateDoltgresDomain`, `deleteDoltgresDomain`: domain SQL operations for caller-owned query callbacks; mutations require the caller's existing admitted write scope and do not admit or commit.
- `queryKnowledgeHistory(sql, id)`, `KnowledgeHistorySql`: the entry-history SQL, shared by the adapter's `history()` and by nodes or the operator that hold their own `sql`.
- `DoltgresKnowledgeContributionAdapter`, `DoltgresKnowledgeContributionAdapterConfig` (contribution-branch lifecycle)
- `createDoltgresPusher`, `DoltgresPusher`, `DoltgresPushConfig` (post-merge mirror to a Dolt remote; lazy `dolt_remote add` + `dolt_push`)
- `wrapPushSafe`, `PushOutcomeListener` (fire-and-forget wrapper with injectable success/failure callbacks — keeps logging out of the adapter)

**Subpath** (`@cogni-dao/knowledge-store/migrations`):

- `createDoltgresMigrationRunner`, `isDoltgresMigrationOutcomeUncertain`: bounded owned-session execution for the node-owned migrator; bundles the private engine with its guard. Journals, DDL, schema checks, identity and process lifecycle stay node-owned.

**Service** (`@cogni/knowledge-store/service/contribution-service`):

- `createContributionService`, `ContributionService`, `ContributionServiceDeps`
- `ContributionServiceDeps.pushMainOnMerge?: () => Promise<void>` — optional post-merge mirror hook; caller owns error handling (service does not await + does not catch)
- `ContributionServiceDeps.nodeAdmin?: NodeAdminAuthority` — goal-layer merge gate (raw diff ids via the required port method `KnowledgeContributionPort.touchedIds`, merge pinned with `expectedHeadCommit`); absent ⇒ goal-layer merges fail closed 503

## Ports

- **Implements:** `KnowledgeStorePort`
- **Uses:** none

## Responsibilities

- This directory **does**: define port interface, Zod domain schemas, Doltgres adapter (CRUD + commit/log/diff), connection factory with Doltgres-compatible settings.
- This directory **does not**: define schema (node packages own that), load env vars, own database provisioning or process lifecycle. Shared engine admission/branch mutation is delegated to `@cogni-dao/doltgres-admission`.

## Notes

- **postgres.js parameterized queries don't work on Doltgres** — adapter uses `sql.unsafe()` + `escapeValue()` for all queries.
- **`ON CONFLICT ... EXCLUDED` unsupported** — `upsertKnowledge` uses try-INSERT / catch-duplicate / fallback-UPDATE.
- **JSONB `@>` and ILIKE not supported** — fallbacks: `CAST(tags AS TEXT) LIKE` and `LOWER(col) LIKE`.
- **Doltgres 0.56 RBAC is non-functional** — GRANT reports success but roles can't even `SELECT current_user`. Runtime `DOLTGRES_URL_*` must connect as `postgres` superuser until upstream lands working role access.
- **`fetch_types: false` required** on all postgres.js connections (pg_type grants missing).
- Schema lives in node packages (`nodes/{node}/packages/doltgres-schema/`) because nodes may add companion tables and fork takes schema with it.
- `core__knowledge_search` / `core__knowledge_read` / `core__knowledge_write` BoundTools shipped in `@cogni/ai-tools`; brain graph uses them via tool runtime.

Contribution adapters require an explicit independent `writerSession` or `branchSql`; no write path falls back to its read client. The existing session runner registers each reader and rejects both initial and replacement writer aliases before SQL; rejected replacement factories never destroy a reader. Pure read-only store construction remains supported.

metricSpec and kpiBindings are nullable reviewed JSON fields. Omitted updates preserve them; explicit null clears them. The node validates metric semantics; this package never executes calculators.

Browse/Overview accept an optional AbortSignal and share one finite admission + HEAD + metadata/body-window deadline, including SSR. Per borrowed pool, at most max−1 native windows (one on a single-slot pool) and 32 waiting callers are admitted. Deadlines/aborts retain permits until native server settlement. Server (`PostgresError`) and closed-connection errors (`CONNECTION_CLOSED`/`CONNECTION_DESTROYED`/`CONNECTION_ENDED`/`ECONNRESET`/`ECONNREFUSED`) release the permit at once; unknown transport outcomes hold it for 4× the deadline, then release. A permit released after ECONNRESET/CONNECTION_CLOSED may coexist with an orphaned bounded (LIMIT 21) native query — accepted. No borrowed pool is canceled, closed or replaced; multi-slot pools retain one slot for unrelated readers. The private writer executor exposes no ordinary-read API, so this narrow reader guard follows Work’s retained-settlement accounting without writer admission.
