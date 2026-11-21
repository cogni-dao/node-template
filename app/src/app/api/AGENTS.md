# api · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derek @core-dev
- **Last reviewed:** 2026-11-05
- **Status:** draft

## Purpose

HTTP API endpoints using Next.js App Router. Contract-validated entry points that delegate to feature services.

## Pointers

- [App AGENTS.md](../AGENTS.md)
- [Architecture](https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/architecture.md)
- [Feature Development Guide](https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/guides/feature-development.md)

## Boundaries

```json
{
  "layer": "app",
  "may_import": ["features", "contracts", "shared"],
  "must_not_import": [
    "adapters/server",
    "adapters/worker",
    "core",
    "ports",
    "components"
  ]
}
```

## Public Surface

- **Exports:** none
- **Routes (if any):**
  - `/api/v1/knowledge/browse` [GET] — authenticated bounded metadata pages with the exact filtered `total`; body search advances only through explicit continuation. Reads forward request abort and return retryable 503 on deadline/capacity exhaustion.
  - `/api/v1/knowledge/graph` [GET] — the whole projected graph at one store revision via `readKnowledgeGraph` (`@cogni/knowledge-store`): ETag = revision, 304 on If-None-Match, one pinned read per revision, graph deadline → retryable 503, `knowledge.graph_read` logs bytes and `budgetExceeded`.
  - `/api/auth/[...nextauth]` [GET, POST]
  - `/api/setup/verify` [POST] - DAO formation verification
  - `/api/internal/billing/ingest` [POST] - LiteLLM generic_api callback receiver (bearer auth, Docker-internal only)
  - `/api/internal/ops/governance/schedules/sync` [POST] - deploy-time governance sync trigger (bearer auth)
  - `/api/v1/chat/completions` [POST] - OpenAI-compatible chat completions (streaming + non-streaming, `cogni_status` extension); see [completions spec](https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/completions-api.md)
  - `/api/v1/ai/chat` [POST] - streaming chat with server-authoritative thread persistence
  - `/api/v1/activity` [GET]
  - `/api/v1/identity/bindings/import/start` [POST] - mint a session-owned nonce and return the pinned operator broker URL
  - `/api/v1/identity/bindings/import` [POST] - verify and consume an operator identity attestation into this node's binding ledger
  - `/api/v1/identity/wallet/challenge` [POST] - any principal (session or agent bearer): mint a single-use SIWE nonce and the message fields for this node's domain
  - `/api/v1/identity/wallet/bind` [POST] - any principal: verify the signed challenge (shared `verifySiwe`), consume the nonce, bind the wallet to the caller, keyed by its lowercase address (EIP-55 is only the input checksum; the message is pinned to this node's domain, uri and chain, no resources); an agent may bind but is never a payee (AGENT_WALLET_IS_NOT_A_PAYEE)
  - `/api/v1/public/attribution/epochs` [GET] - closed epochs list (public, no auth)
  - `/api/v1/public/attribution/epochs/[id]/user-projections` [GET] - closed epoch user projections (public)
  - `/api/v1/public/attribution/epochs/[id]/claimants` [GET] - closed epoch claimant attribution (public)
  - `/api/v1/public/attribution/epochs/[id]/statement` [GET] - epoch statement (public)
  - `/api/v1/attribution/epochs` [GET] - all epochs (SIWE auth)
  - `/api/v1/attribution/epochs/[id]/activity` [GET] - epoch activity events (SIWE auth)
  - `/api/v1/attribution/epochs/[id]/claimants` [GET] - claimant-aware finalized attribution (SIWE auth)
  - `/api/v1/attribution/epochs/[id]/user-projections` [GET, PATCH=410] - read per-user unsigned projections; edits are deprecated
  - `/api/v1/attribution/epochs/[id]/review-subject-overrides` [GET, PATCH, DELETE] - review-time subject overrides (SIWE + approver)
  - `/api/v1/attribution/settlement-lifecycle` [GET] - settlement and chain-proven publication lifecycle (SIWE auth)
  - `/api/v1/attribution/epochs/[id]/pool-components` [POST] - record pool component (SIWE + approver)
  - `/api/v1/users/me` [GET, PATCH] - current profile
  - `/api/v1/users/me/ownership` [GET] - current ownership summary derived from linked identities
  - `/api/v1/work/summaries` [GET] - one bounded page (default 25, max 100; text scans ≤1000 rows, `pageInfo.rowsScanned`) of projected Work summaries; the route is auth + logging + the published `handleWorkSummariesRequest` (SIWE or agent bearer auth)
  - `/api/v1/work/board` [GET] - first page (≤20) of each visible status column under one deadline and scan budget (unreached columns `not_started`); the route is auth + logging + the published `handleWorkBoardRequest`; column cursors continue through `/summaries` (SIWE or agent bearer auth)
  - `/api/v1/work/items/{id}/expectations` [GET] - authenticated bounded tracked EDO projection using composed knowledge and metrics reads; unmatched commitments remain unresolved.
  - `/api/v1/work/items` [GET, POST] - list or create node-local Dolt work items (SIWE or agent bearer auth)
  - `/api/v1/work/items/[id]` [GET, PATCH, DELETE] - read/update a node-local Dolt work item; DELETE returns 410 (use status=cancelled) (SIWE or agent bearer auth)
  - `/api/v1/work/items/[id]/artifacts` [POST, GET] - record or list immutable triage, design-review, implementation-review, validation and closeout artifacts (task.0028; the list carries `body`, the item read does not). POST needs the `work_item:transition` grant, the same door as PATCH (a signed-in human passes), stamps the caller as author (audit only; no server check compares it with the subject's author), stamps the item revision, and refuses a build subject whose origin is not this hub's own (400); GET lists newest first, at most 50. The route is auth + logging + the published `recordWorkItemArtifact` / `listWorkItemArtifacts`; the item read (`GET /work/items/[id]`) carries the latest of each kind as `artifacts`
  - `/api/v1/work/items/[id]/artifacts/[artifactId]` [GET] - one artifact of this item in full, with `rows`, `body` and `url`; another item's artifact is a 404 (story.0058). The list route's `?view=refs&cursor=<seq>` returns 20 refs and `nextCursor`, the history route's `?view=refs&cursor=<commit>` 20 versions without `diff`; without `view` both answer as before. `GET /work/items/[id]?include=artifacts,history&artifact=<id>` adds page 1 of both and that one artifact, the same parts `core__work_item_read` returns
  - `/api/v1/work/items/[id]/claims` [POST, DELETE] - acquire or release an authenticated principal+run lease
  - `/api/v1/work/items/[id]/heartbeat` [POST] - refresh an authenticated principal+run lease
  - `/api/v1/work/items/[id]/coordination` [GET] - read lease and next-action coordination state
  - `/api/v1/knowledge/index` [GET] - content-free retrieval-trigger projection with optional `useWhen` substring filter
  - `/api/v1/agent/register` [POST] - unauthenticated machine actor registration (returns Bearer API key)
  - `/api/v1/agent/credentials/{upgrade,rotate,confirm,revoke}` [POST] - revocable hashed keys (task.0070): a signed key upgrades to a PENDING revocable key for the same user id; rotate mints a pending successor (a repeat supersedes); confirm (called with the pending key) activates it and revokes the predecessor in one transaction, idempotent; revoke ends one key and its pending successor. Logic lives in `@cogni-dao/agent-grants/credentials`; routes are thin. Once a user's revocable key is confirmed, that user's signed keys answer 401 `v1_superseded` (revoking the revocable key does not revive them). Any store failure is 503 `authz_unavailable`, never 401
  - `/api/v1/agent/runs` [GET] - machine-authenticated run list
  - `/api/v1/public/agent/service-enrollments` [POST] - a service on a trusted home node asks for one permission with a signed assertion (`Authorization: Bearer <jwt>`, body `{ scope }`); 201 `{ status: "pending" }` for a new ask, 200 when it already waits or is granted, 401 for a refused assertion, 503 when the home's keys are unreachable (story.0038). Nothing is granted; an admin turns the ask On in `/admin/ai-access`
  - `/api/v1/orgs` [GET, POST] - a signed-in person's cookie session (the human plane): GET lists the orgs they are in with their role, a page at a time (`?limit=1..100&cursor=`, answer `{ orgs, nextCursor }`); POST `{ name }` creates an org (its account, its `org` principal with owner source `grants`, and the creator's `org:owner`, approved by the org's own users id); 409 `org_role_limit` for a second org (release 1: one role per kind per person; release 2 raises it to 5 owned orgs). Replaces the retired repo-spec `POST /api/v1/orgs` (task.0181, agent-grants 0.10.0).
  - `/api/v1/orgs/{orgId}` [GET] - an owner or admin: the org, the caller's role and the first page of its people and open node links; 404 for anyone else. `/api/v1/orgs/{orgId}/members` and `/links` [GET] page the rest (`{ items, nextCursor }`).
  - `/api/v1/orgs/{orgId}/invites` [POST] - an owner or admin: `{ wallet, role: owner|admin }` stores an invite (7 days, single use); grants nothing; only an owner invites an owner. `/api/v1/orgs/invites/mine` [GET] lists open invites for the caller's own bound wallets; `/api/v1/orgs/invites/{inviteId}/accept` [POST] writes the grant.
  - `/api/v1/orgs/{orgId}/members/{userId}` [PATCH `{ role }`, DELETE] - an owner or admin changes or removes a person; only an owner touches an owner; the last owner is 409 `last_owner` (one locking transaction).
  - `/api/v1/orgs/{orgId}/link-codes` [POST] - an org owner: `{ origin }` (the other node's) returns a one-time code once; it carries this node's origin and id and the org id, so the other node's admin enters only the code (the secret is hashed at rest, 15 minutes, bound to the org and the other origin). `/api/v1/public/orgs/link-preview` [POST `{ code }`] - public (the perimeter's `/api/v1/public/` namespace), rate limited, the code in the body never a URL: the org's name and this node's origin for a valid unused code, else 404 `not_found`, nothing else. `/api/v1/orgs/{orgId}/links/{linkId}` [DELETE] - an owner unlinks; the next run is refused `org_link_closed`.
  - `/api/v1/orgs/link` [POST] - public, the credential is the signed `node-connect` assertion (`act: link|unlink`, `code`, `org`, `services`) verified against `<origin>/.well-known/jwks.json` (https, no redirects, 5 s, 64 KB, private ranges refused, address pinned); 201 link, 200 unlink; `link_code_invalid`, `issuer_already_linked`, `no_open_link`, `org_suspended`.
  - `/api/v1/orgs/{orgId}/suspension` [POST] - node-admin only (the one admin check): `{ suspended: true }`, final (no resume), stores `suspended_by`; a suspended org's next run is refused `org_suspended`. `/api/v1/admin/orgs` [GET `?limit=&cursor=`] - node-admin only: every org, `{ orgs: [{ orgUserId, name, suspended }], nextCursor }`. `/api/v1/orgs/outbound` [POST] - node-admin only; the admin enters only the code: `{ step: preview, code }` returns the org name and origin the other node reports; `{ step: link, code, expectOrgName, services }` signs only if a fresh preview still names that org; `{ step: unlink, code }` signs the close. Every request to the other node goes through the pinned request path.
  - `/api/v1/service-links/ask` [POST] - node-admin only (the one admin check, any credential): `{ alias, scope }` has this node's AI ask the `.cogni/service-links.yaml` target `alias` for one permission (a signed assertion as service `node-ai`, posted to its `/api/v1/public/agent/service-enrollments`); returns `{ alias, status, httpStatus }`. 404 `unknown_alias`, 503 `signer_unavailable`, 502 `target_unreachable`.
  - `/.well-known/jwks.json` [GET] - this node's public service-assertion keys; 404 until `SERVICE_ASSERTION_SIGNING_SEED` is set
  - `/api/v1/agent/runs/[runId]/stream` [GET] - machine-authenticated run stream SSE
  - `/api/v1/ai/runs/[runId]/ui-stream` [GET] - session-authenticated AI SDK chat replay stream
- **Files considered API:** v1/_/route.ts, admin/_/route.ts

## Responsibilities

- This directory **does**: validate HTTP requests/responses with contracts; delegate to features
- This directory **does not**: contain business logic, direct port usage, or data transformations

## Usage

```bash
curl -X POST http://localhost:3000/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hello"}]}'
```

## Standards

- All routes must validate with contract schemas
- Parse input before processing, parse output before responding
- Use NextResponse for consistent HTTP responses

## Dependencies

- **Internal:** contracts (for validation), shared (for types)
- **External:** next (NextResponse)

## Change Protocol

- Update this file when **Routes** change
- Bump **Last reviewed** date
- Ensure contract tests pass

## Notes

- v1 API prefix for versioned product routes
- `v1/admin/ai-access` is an ADMIN-area route (a session or a bearer, through the one admin check; the only door for node-admin writes): `GET` lists node AI, `POST`/`DELETE` allow or remove a node AI permission for a node-admin, through `requireAdminSession()` and `NodeAdminPort`. A session and a bearer reach the same route and the same `agentAuthority.adminCheck` (ONE_ADMIN_CHECK). `v1/agent-access/mine` still calls `refuseNonSession()` (`_lib/auth/human-plane.ts`) first and is the last session-only route (task.0140 follow-up). A header that is not a signed or revocable agent bearer, with no session cookie, gets 401 from `proxy.ts` before the route runs; no authority is granted either way.
- Account grants (task.5465, one `agent_roles` row for node and account alike). `v1/agent-access/mine` is a HUMAN-plane route (session only; `refuseNonSession()` first, so any `Authorization` header is 403 `human_session_required`): `GET` lists the AIs that may act on the signed-in person's OWN account (this node's AI Off until On, outside AIs On), `POST` turns one On (an outside AI's ask by its one-time `token`, or this node's own AI directly by `principalUserId` + `scope`; a grant has no end date and lasts until Off, like a node permission), `DELETE` turns one Off (`rowId`) or dismisses an ask (`token` + `deny`). `POST v1/agent-access/mine/preview` and `POST v1/admin/ai-access/preview` take a link token (body only, never a URL) and return the waiting ask as a table row, or one 404 for a wrong-kind, used, expired or unknown token. The approver is the session and the account is the one that person owns: a body never names either, and a node-admin session adds nothing (APPROVER_FOLLOWS_RESOURCE, ONE_GATE = `canApprove` in `@cogni-dao/agent-grants`). `POST v1/agent/access-requests` (AI plane) returns `approvalUrl`: the one-time link to `/profile#agent-request=<token>` for an account scope or `/admin/ai-access#agent-request=<token>` otherwise, picked by the scope's declared kind. `GET v1/accounts/{accountId}/credits` is the gated read (`sameDoor: core__account_credits_read` + `sameDoorAccountParam: accountId`): the owner by session or an agent with a live grant for exactly that account, else ONE 404 (`not_found`), read in an app-role tenant transaction as the caller so row-level security (`agent_has_scope`) repeats the app's test.
