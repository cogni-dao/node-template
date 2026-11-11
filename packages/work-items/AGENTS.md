# work-items · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @cogni-dao
- **Status:** stable
- **Last reviewed:** 2026-11-07

## Purpose

Work item port interfaces, domain types, and storage adapters for structured work item management. Root entry (`@cogni/work-items`) exports types/interfaces and database-neutral content/lease composition. Adapter entries expose the legacy markdown implementation and the shared Doltgres implementation used by every node-owned work-item store.

## Pointers

- [Development Lifecycle](../../docs/spec/development-lifecycle.md): Status enum and transition rules
- [Identity Model](../../docs/spec/identity-model.md): Actor kinds for SubjectRef alignment
- [Packages Architecture](../../docs/spec/packages-architecture.md): Package conventions

## Boundaries

```json
{
  "layer": "packages",
  "may_import": [],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters",
    "shared",
    "services",
    "packages"
  ]
}
```

**External deps:** `zod` (canonical wire schema), `type-fest` (Tagged branded types), `yaml` (frontmatter parsing — adapter only). Doltgres adapter alone bundles `@cogni-dao/doltgres-admission` for the shared engine writer protocol; root/content/lease ports stay database-neutral.

## Public Surface

- **Exports (root `@cogni/work-items`):**
  - `WorkItemId`, `Revision`, `WorkItemType`, `WorkItemStatus`, `ActorKind` — identity and enum types
  - `SubjectRef`, `ExternalRef`, `RelationType`, `WorkRelation` — structured domain types
  - `toWorkItemDto` — spread-first read serializer with actor omission and derived rank
  - `WorkItemSummarySchema`, `WorkItemSummary` — projected Work list contract without detail or leases
  - `WorkItem`, `WorkQuery` — full work item type and query filter; rank bounds are inclusive and exclude unknown rank when set; projectIds is any-of
  - `WORK_ITEM_SORT_FIELDS`, `WORK_ITEM_SORT_DIRECTIONS`, `normalizeWorkItemOrder`, `compareWorkItems` — canonical ordering; default rankScore DESC, unknown last, id ASC
  - `WorkItemSortBy`, `WorkItemSortDirection`, `WorkItemOrder` — shared order types
  - `toWorkItemId(raw: string): WorkItemId` — boundary constructor
  - `WorkItemQueryPort`, `WorkItemCommandPort` — read/write interfaces
  - `VALID_TRANSITIONS`, `isValidTransition(from, to): boolean` — transition table
  - `WorkItemScore(s)`, `parseWorkItemScores(input)`, `rankScore(scores)`, `WorkItemScoresInvalidError` — the only `scores` bounds and WSJF rank (story.5111); every write path calls the parser, nobody re-states the rules
  - `WorkItemPatchInputSchema`, `WorkItemPatchStatusSchema`, `WorkItemScoresInputSchema`, `WorkItemPatchInput` — the one PATCH input schema: `PATCH /api/v1/work/items/{id}` (node-contracts `workItemsPatchOperation.input`) and the agent tool `core__work_item_update` share it (task.0065)
  - `ChangeReasonSchema`, `HistoryEntrySchema`, `HistoryOutputSchema`, `HistoryOutput`, `workItemsHistoryOperation` — history wire schemas (task.0052, story.0023); node-contracts re-exports them. A history item carries `cites: [{ id, commit, contribution? }]` (empty when none)
  - `checkChangeReason`, `normalizeChangeReason`, `CHANGE_REASON_REQUIRED_MESSAGE`, `ChangeReasonInvalidError`, `CHANGE_REASON_MAX_CHARS` (240), `CHANGE_REASON_MAX_WORDS` (25) — REASON_REQUIRED (task.0086): every patch carries a reason; line breaks (CR, LF, U+0085, U+2028, U+2029) become spaces, trim, 1–240 chars, ≤25 words, no NUL. The zod schema and the adapter call the same function
  - `CiteRefSchema`, `CITE_MAX` (8), `CITE_ID_PATTERN`, `CITE_CONTRIBUTION_PATTERN`, `EntryResolver` (port: `resolve(refs, "cite", signal)` → `{ id, commit, plane, contribution? }[]`), `EntryUnresolvedError` (→ 400 `cite_unresolved`), `EntryResolverUnavailableError` (→ 503), `CitesUnsupportedError` (no resolver wired → 400 `cites_unsupported`), `CitesInvalidError`, `formatCitesTrailer`, `parseCitesTrailer` — pinned cites (task.0086). `@cogni-dao/knowledge-store` implements the port
  - `readWorkItemHistory(store, id)`, `WorkItemHistoryStore`, `WorkItemHistoryResult`, `HistoryReadLog` — framework-agnostic handler returning `{ status, body, log }` (200, 404, 503; never throws); the node route owns auth and logging
- **Exports (adapter `@cogni/work-items/markdown`):**
  - `MarkdownWorkItemAdapter` — implements QueryPort + CommandPort against markdown files
  - `StaleRevisionError` — thrown on optimistic concurrency conflict
  - `InvalidTransitionError` — thrown on invalid status transition
  - `UnsupportedWorkItemFieldError` — thrown when create/patch names `scores` (Doltgres-only); nothing is written
- **Exports (adapter `@cogni/work-items/adapters/doltgres`):**
  - `DoltgresWorkItemAdapter` — node-local content query/create/patch; hard delete fails with a typed retirement error
  - `WorkItemRevisionConflictError` — `patch` with a stale `expectedRevision`; nothing committed
  - `DoltgresWorkItemAdapterOptions` — per-store allocator configuration (`idFloor`) (create/patch reject invalid `scores` with `WorkItemScoresInvalidError` before any SQL); `entryResolver` pins a patch's `cites`
  - cursor codec + Doltgres port/error types
  - `WORK_SUMMARY_PAGE_DEFAULT` (25), `WORK_SUMMARY_PAGE_MAX` (100), `WORK_BOARD_COLUMN_PAGE` (20), `WORK_SUMMARY_LIST_MAX` (50 values per list filter), `WORK_SUMMARY_TEXT_MAX` (200 chars); `parseWorkSummarySearchParams` / `workSummaryQueryToSearchParams` — the one query codec the browser encodes and the route decodes with; `WorkSummaryPageSchema` (task.0055)
  - `WORK_TEXT_SCAN_MAX_ROWS` (1000, root + Doltgres entry) — rows one text search may scan — this applies to full `list` too (`GET /api/v1/work/items?text=…`, `core__work_item_query`), so any text page may be empty with a cursor; at the cap the page returns its matches with `hasMore` and an `endCursor` at the last SCANNED row (a page that fills first continues after its last RETURNED match); `pageInfo.rowsScanned` reports the rows read. `listSummaries(query, { signal, deadline, maxScanRows })` only tightens bounds and clamps to 100 rows; full `list` keeps 500
  - `handleWorkSummariesRequest` / `handleWorkBoardRequest` → `{ status, body, telemetry }`, `classifyWorkReadError`, `WORK_READ_ERROR_CODES` — framework-neutral route logic; a node route is auth + logging + one call
  - `DoltgresWorkItemAdapter.listBoardColumns(query, statuses, perColumn)` (optional `WorkItemsPort.listBoardColumns`, forwarded by `withWorkItemLeases`) — boards without text read every column in ONE native query (CTE of bracketed per-status page SQL joined by UNION ALL, `LIMIT perColumn + 1` each); column cursors are byte-identical to `listSummaries({ ...query, statuses: [status], limit: perColumn })`. Never composes text
  - `loadWorkBoardColumns(list, query, statuses, { perColumn, signal, budgetMs, maxScanRows, listColumns })` — with `listColumns` and no text: one composed call — ONE admission deadline (`WORK_BOARD_READ_BUDGET_MS`) and ONE rows-scanned budget per board; unreached columns come back `state: "not_started"` (no items, no cursor). POOL_SAFETY: a caller `deadline` only gates admission of the next column/text batch (a cut page returns matches + continuation); native timeouts and reader-pool retirement stay on `queryTimeoutMs`; `parseWorkBoardSearchParams`, `WorkBoardColumnsSchema`, `WORK_BOARD_STATUSES` — bounded board read: one summary page per visible status, read sequentially (the reader pool is width one, and each call owns its read deadline), column cursors valid for `/summaries?statuses=<status>&…&cursor=`; pure over an injected `listSummaries`
- **Files considered API:** `src/index.ts`, `src/adapters/markdown/index.ts`, `src/adapters/doltgres/index.ts`

## Ports

- **Uses ports:** none
- **Implements ports:** `WorkItemQueryPort`, `WorkItemCommandPort` (via MarkdownWorkItemAdapter and DoltgresWorkItemAdapter)

## Responsibilities

- This directory **does**: Define port interfaces, domain types, transition rules, and the markdown adapter
- This directory **does not**: Import from `@/` or `src/`, depend on app-layer or service code

## Usage

```bash
pnpm --filter @cogni/work-items typecheck
pnpm --filter @cogni/work-items build
pnpm vitest run packages/work-items/tests/
```

## Standards

- Root entry: no environment/pool/framework imports; orchestration delegates to injected ports.
- Adapter entries: I/O allowed, but no `@/` or app `src/` imports
- No `as WorkItemId` casts outside test fixtures — use `toWorkItemId()` at boundaries

## Dependencies

- **Internal:** none
- **External:** `type-fest` (Tagged branded types), `yaml` (YAML parse/stringify)

## Change Protocol

- Update this file when types, ports, or transition rules change
- Coordinate with development-lifecycle.md for status/transition changes
- Coordinate with identity-model.md for SubjectRef kind changes

## Notes

- `toWorkItemId()` does no format validation — WorkItemIds include both numeric (`task.0149`) and slug-based (`proj.agentic-project-management`) formats
- `MarkdownWorkItemAdapter` constructor takes `workDir` (repo root) — scans `work/items/` and `work/projects/`
- `blocked` can transition to any `needs_*` status — adapters may enforce stricter return-to-previous-status logic
- Dolt ID allocation is inside the common per-database writer scope; never move it before admission.

## Operational leases

Work-item leases live in PostgreSQL `work_item_leases`; shared package `@cogni-dao/work-items/adapters/postgres` owns atomic principal/run/token predicates. Heartbeat and release return lease-only data and never call Dolt. Runtime uses the service-role pool; RLS denies app-role SQL. Content get/list project this authority via `withWorkItemLeases`. Old Dolt lease columns are historical evidence, never current authority.

## Reader fault containment

A read has its own deadline and never enters writer admission. Reader timeout retires only the captured generation, gracefully drains siblings and permits at most one replacement; maximum two generations. Runtime factories must budget the overlap. Explicit `readConnectionBudget` fails closed on unknown or invalid public pool widths. The template uses max 1 per reader generation, at most two reader connections plus one writer. See [README](README.md) for cutover and fault proof limits.

- ONE_ENFORCER (task.0086): `DoltgresWorkItemAdapter.patch` applies the reason and cite rules for every writer (route, `core__work_item_update`, `core__work_item_transition`, the capability, the guard, system writers). It validates before any SQL; with cites it calls the resolver in `preflight` (inside the writer lock, before the branch checkout) raced against one `queryTimeoutMs` deadline; a timeout or resolver failure releases the lock and writes nothing. The commit message is `work-items: patch <id> by actor:<p>`, `Reason: <reason>`, and a last `Cites: id@commit, id@contrib-…:commit` line built from the request plus validated commits, so no line can be forged. Crash recovery reads line one only. History parsing matches each line from its start.
- PATCH_CAS (task.5284): Doltgres `patch` with `expectedRevision` adds `AND revision = <expected>` to its UPDATE; a mismatch throws `WorkItemRevisionConflictError` and drops the empty op branch with no commit. Omitted = unconditioned, as before.
- AUTHORITY_IS_NOT_KIND (bug.0019, supersedes COLLABORATOR_TRIAGE task.5284): `patch` never compares the writing principal to `created_by_principal_id`. The column is immutable attribution data. Who may patch is decided at the door by the one `authorize()` check (scope `work_item:transition`), on `work.items.patch` and on the guarded tool; the adapter only requires a non-blank principal, an unchanged creator, and a proven row diff.

- Query cursors bind version, normalized result filters and sort; decoder callers pass the identity from `queryIdentity`; unbound old versions require restart; old/order-mismatched cursors require restart. Native SQL owns exact cursor keys. Timestamp ordering, projection and seek use the engine's public microsecond precision; hidden NOW() nanoseconds do not survive native text I/O. Text uses bounded ordered batches sharing one read deadline.
