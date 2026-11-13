// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/account`
 * Purpose: The door for ACCOUNT data. May this caller read this billing account under this scope? The answer is the owner, a live personal grant
 *   from the owner, or null (one non-disclosing "not found"). `authorize()` stays the door for tool authority.
 * Scope: Pure over the store port. It decides; it reads no account data.
 * Invariants:
 *   - ACCOUNT_NAMED_BY_THE_PATH: the account comes from the request path, never from the caller. An agent's own account is not "the" account it is asking about.
 *   - ACCOUNT_SCOPE_NEEDS_OWNER_GRANT: an agent reads another person's account only through a live personal grant that account's owner approved for it.
 *     A node role row never opens an account (a node row is a different `resource_kind`), and an agent with no owner has no grant to hold.
 *   - RLS_BACKSTOP: the live-grant predicate is the SQL function `agent_has_scope` (migration template). The route still reads through RLS with the agent as the
 *     context user, so an allow here is necessary and not sufficient.
 *   - FAIL_CLOSED_NON_DISCLOSING: a missing account, a foreign account, a missing, expired or revoked grant, a wrong scope and a malformed id are the same `null`.
 *     A store outage throws; the route says `authz_unavailable`, never an allow.
 *   - NEVER_CACHED: every call reads the store.
 * Side-effects: IO (store reads)
 * @public
 */

import type { AgentGrantsStore } from "./types";

export interface AccountAccess {
  /** `owner` = the caller owns the account. `delegated` = a live personal grant from its owner. */
  readonly accessKind: "owner" | "delegated";
}

/** Account ids are short text keys; anything else is not an account. A bounded, plain shape also keeps a path value out of the query. */
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,100}$/;

export async function authorizeAccount(
  store: AgentGrantsStore,
  input: {
    readonly userId: string;
    /** How the request authenticated. A human session is never a delegate: it reads its own account or none. */
    readonly via: "bearer" | "session";
    readonly accountId: string;
    readonly scope: string;
  }
): Promise<AccountAccess | null> {
  const { userId, via, accountId, scope } = input;
  if (!userId || !ACCOUNT_ID.test(accountId)) return null;
  const owner = await store.accountOwner(accountId);
  if (!owner) return null;
  if (owner === userId) return { accessKind: "owner" };
  if (via !== "bearer") return null;
  // The agent must still belong to the account's owner, and hold a live personal grant from that owner for this scope.
  const delegated = await store.hasLiveRole(userId, scope, { kind: "account", ownerUserId: owner });
  return delegated ? { accessKind: "delegated" } : null;
}
