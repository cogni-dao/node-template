// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/account-access`
 * Purpose: The account-mode orchestration of the one table, for ONE person's own account: what their profile lists (`listMine`), turning a row On
 *   (`turnMineOn`: an outside AI's ask by its one-time link, or this node's own AI directly) and Off (`turnMineOff`), and the helper that says which
 *   account or node scopes each of this node's AI may use (`scopesByPrincipalOf`). A node supplies its routes, its session and an `ensureAccount` callback;
 *   it holds none of this logic (one fleet-carried mechanism, one owner).
 * Scope: Pure over the store plus the injected `ensureAccount`. No routes, no logging, no UI.
 * Invariants:
 *   - ENSURE_AFTER_VALIDATION: the person's billing account is created (`ensureAccount`) only after the token or the principal, scope, days and kind have
 *     validated, so a bogus request creates nothing.
 *   - SCOPE_KIND_PICKS_THE_PLANE: a direct On needs a declared scope of kind `account` (a node scope is refused, `wrong_kind`).
 *   - PROFILE_NEVER_SHOWS_NODE_ROWS: `listMine` reads account rows on the viewer's own account only.
 *   - BOUNDED: `listMine` returns at most `limit` rows and counts the rest in `more`.
 * Side-effects: IO (store reads and writes, `ensureAccount`)
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

import { ACCOUNT_GRANT_DAYS, type ApprovalCaller, isAccountGrantDays } from "./approval";
import { buildAccountAiView } from "./node-ai";
import {
  AgentRolesError,
  approveAccountAsk,
  denyAccountAsk,
  grantInternalOnAccount,
  previewAsk,
  revokeAccountRow,
  type ScopeKinds,
} from "./roles";
import type { AgentGrantsStore, NodeAiPermissionView, ScopeKind } from "./types";

/** Account rows the profile read returns at most (one person's account holds a handful). */
export const MAX_ACCOUNT_ROWS = 100;

/** The slice of a graph catalog entry the scope helper reads. */
export interface CatalogEntryLike {
  /** The internal AI slug the graph acts as. A graph with none holds no scoped tool. */
  readonly principal?: string | undefined;
  readonly toolIds: readonly string[];
}

/**
 * The scopes each of this node's AI may use, from the contracts of every tool its graphs list. `plane: "account"` returns account-kind scopes (the
 * profile table), `"node"` every other kind (the admin table): a scope shows on exactly one page.
 */
export function scopesByPrincipalOf(
  entries: Iterable<CatalogEntryLike>,
  requiresById: Readonly<Record<string, { readonly scope: string; readonly kind: ScopeKind }>>,
  plane: "account" | "node"
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const entry of entries) {
    if (!entry.principal) continue;
    const scopes = (out[entry.principal] ??= []);
    for (const toolId of entry.toolIds) {
      const requires = requiresById[toolId];
      if (requires && (requires.kind === "account") === (plane === "account")) scopes.push(requires.scope);
    }
  }
  return out;
}

export interface MineListInput {
  readonly userId: string;
  /** scope -> its declaration (`requires.label`, `requires.description`). */
  readonly declarations: Readonly<Record<string, { readonly label?: string | undefined; readonly description?: string | undefined }>>;
  /** From `scopesByPrincipalOf(..., "account")`. */
  readonly scopesByPrincipal: Readonly<Record<string, readonly string[]>>;
  readonly limit?: number | undefined;
}

/**
 * The profile table for one person: the live account rows on their OWN account (this node's AI and outside agents), and this node's AI Off until
 * On. A person with no account yet lists no rows. Bounded: `more` counts the live rows not returned.
 */
export async function listMine(
  store: AgentGrantsStore,
  input: MineListInput
): Promise<{ permissions: NodeAiPermissionView[]; more: number }> {
  const limit = input.limit ?? MAX_ACCOUNT_ROWS;
  const accountId = await store.accountOf(input.userId);
  const internal = await store.listInternalPrincipals();
  const listed = accountId ? await store.listAccountRoleRows(accountId, limit) : { rows: [], more: 0 };
  return {
    permissions: buildAccountAiView({
      declarations: input.declarations,
      scopesByPrincipal: input.scopesByPrincipal,
      internal,
      rows: listed.rows,
      ask: null,
    }),
    more: listed.more,
  };
}

export type MineOnInput =
  | { readonly token: string; readonly days?: number | undefined }
  | { readonly principalUserId: string; readonly scope: string; readonly days?: number | undefined };

export interface MineOnResult {
  readonly changed: boolean;
  readonly via: "link" | "direct";
  /** Set on a direct On, for the node's log. */
  readonly principalUserId?: string;
  readonly scope?: string;
}

const checkDays = (days: number | undefined): void => {
  if (days !== undefined && !isAccountGrantDays(days))
    throw new AgentRolesError("invalid_days", `days must be one of ${ACCOUNT_GRANT_DAYS.join(", ")}`);
};

/**
 * The person turns an ACCOUNT row On: an outside AI's ask by its token, or this node's own AI directly (no ask). The approver is the signed-in person
 * and the account is the one they own. `ensureAccount` creates that account if absent and runs only after the request validated
 * (ENSURE_AFTER_VALIDATION).
 */
export async function turnMineOn(
  store: AgentGrantsStore,
  input: {
    readonly me: ApprovalCaller;
    readonly on: MineOnInput;
    readonly declaredScopes: readonly string[];
    readonly scopeKinds: ScopeKinds;
    /** Creates the person's billing account when none exists; returns its id. Injected by the node. */
    readonly ensureAccount?: ((userId: string) => Promise<string>) | undefined;
  }
): Promise<MineOnResult> {
  const { me, on } = input;
  checkDays(on.days);
  if ("token" in on) {
    // A token that is not usable, or an ask that is the person's own, creates nothing.
    const ask = await previewAsk(store, { token: on.token, resource: "account" });
    if (!ask || ask.principalUserId === me.userId) return { changed: false, via: "link" };
    await input.ensureAccount?.(me.userId);
    const { approved } = await approveAccountAsk(store, { me, token: on.token, days: on.days });
    return { changed: approved, via: "link" };
  }
  if (!input.declaredScopes.includes(on.scope)) throw new AgentRolesError("invalid_scope", "scope is not declared");
  if (input.scopeKinds[on.scope] !== "account")
    throw new AgentRolesError("wrong_kind", "an account decision needs an account permission");
  const internal = await store.listInternalPrincipals();
  if (!internal.some((p) => p.userId === on.principalUserId))
    throw new AgentRolesError("not_pending", "an outside agent must ask first");
  if (on.principalUserId === me.userId) return { changed: false, via: "direct" };
  await input.ensureAccount?.(me.userId);
  const { created } = await grantInternalOnAccount(store, {
    me,
    principalUserId: on.principalUserId,
    scope: on.scope,
    declaredScopes: input.declaredScopes,
    scopeKinds: input.scopeKinds,
    days: on.days,
  });
  return { changed: created, via: "direct", principalUserId: on.principalUserId, scope: on.scope };
}

export type MineOffInput = { readonly rowId: string } | { readonly token: string };

/**
 * The person turns a live ACCOUNT row Off by id (a row on someone else's account is invisible: `changed: false`), or dismisses a waiting ask by its
 * token (an undecided ask has no account yet, R15). A person who owns no account is refused by the one gate (`not_allowed`).
 */
export async function turnMineOff(
  store: AgentGrantsStore,
  input: { readonly me: ApprovalCaller; readonly off: MineOffInput }
): Promise<{ changed: boolean; via: "row" | "link" }> {
  if ("rowId" in input.off) {
    const { revoked } = await revokeAccountRow(store, { me: input.me, rowId: input.off.rowId });
    return { changed: revoked, via: "row" };
  }
  const { denied } = await denyAccountAsk(store, { me: input.me, token: input.off.token });
  return { changed: denied, via: "link" };
}
