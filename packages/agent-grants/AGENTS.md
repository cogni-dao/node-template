# agent-grants · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @cogni-dao
- **Status:** draft (story.5115 PoC; private, 0.0.0 until it joins the publish lane)
- **Last reviewed:** 2026-10-23

## Purpose

Scoped, revocable agent access for a Cogni node: `authorize()` (owner / delegated / null), the access-request → one-time approval link → owner decision → grant lifecycle, soft grant revocation, and revocable agent credentials (sha256 key hash). Ported from Poly `features/agent-grants` (950e155) without its scope type or `performance:read` alias. Scopes are plain strings the node declares in one place and passes in.

## Pointers

- [node-capability-grants-standard](https://cognidao.org/knowledge/node-capability-grants-standard): Pareto path rows 1, 3, 4
- Schema: `packages/db-schema/src/agent-grants.ts`; RLS functions `agent_has_scope` / `agent_grant_has_scope` in migration `0034_agent_grants.sql`
- Conformance: `app/tests/component/db/agent-grants-authorize.int.test.ts`

## Boundaries

```json
{
  "layer": "packages",
  "may_import": ["packages"],
  "must_not_import": ["app", "features", "ports", "core", "adapters", "shared", "services"]
}
```

**External deps:** `drizzle-orm`, `@cogni/db-schema` (tables). Publishing requires moving the schema slice into this package (or a migration template) first.

## Invariants

- `authorize()` mirrors SQL `agent_has_scope()`; every denial is `null`.
- Raw keys/approval tokens are never stored; only sha256 hex.
- Grant/request rows are never deleted (soft revoke).
- Credential helpers take the service-role db; everything else takes an app-role tenant transaction.
