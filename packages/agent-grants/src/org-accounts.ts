// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/org-accounts`
 * Purpose: Org accounts on a node (task.0181, `org-account-lifecycle` v0): an org connects from its own node, its admins come only from the statement it signs, its admins
 *   grant `org:spend` on this node, this node's admins suspend and restore the account, every act is one `org_events` row, and ONE resolver names who pays for a run.
 * Scope: Raw SQL over an injected service-role tag (the caller owns the transaction) plus the pure Bill-to decision. No routes, no logging, no billing: identity names the account,
 *   billing decides and charges.
 * Invariants:
 *   - AN_ORG_IS_A_DAO_AND_ITS_NODE: no function here creates an org from a person's request; `connectOrg` takes a VERIFIED statement the org signed.
 *   - ADMINS_FROM_THE_ORG / NO_TAKEOVER: `org:admin` is read from the statement on every decision (`orgRoleOf`) and never written; nothing here changes the admin list but a newer
 *     statement (`applyStatement`). Suspend and restore touch only `suspended_*`.
 *   - ADMIN_ROLES_LAPSE: an unreadable statement makes an org admin a non-admin for that call; the account, its balance and the `org:spend` rows stay.
 *   - EVERY_ACT_LOGGED: each act writes ONE `org_events` row in the caller's transaction, so the act and its history commit or roll back together.
 *   - SPEND_HELD_BY_WALLET: a spend grant for a wallet that has not signed in is an `org_wallet_holds` row; `claimHolds` makes it an `agent_roles` row at that wallet's first read after sign-in.
 *   - ONE_RESOLVER: `resolveBillTo` is the only function that names the paying account: the org account a member chose and holds `org:spend` (or `org:admin`) on, the org account of
 *     a calling service, a live payer binding (story.0038), else the caller's own.
 *   - SUSPENDED_REFUSES: a run billed to a suspended org account is refused (`org_suspended`), at the choice and again at the run's own scope check.
 *   - DIRECTORY_GATES_CONNECT: the caller (the host) connects only an origin and node id the fleet directory lists; `applyStatement` also keeps `node_id` unique, so two origins never claim one node.
 *   - ONE_INDEXED_SERVICE_LOOKUP: a service principal's org is found by one indexed read of `org_service_principals`, filled at connect and refresh.
 * Side-effects: IO (SQL through the injected tag)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle, https://node-template.cognidao.org/knowledge/org-fleet-identity
 * @public
 */

import { ensureOrg, isCanonicalOrgOrigin, type OrgOwners, OwnerSourceUnavailableError } from "./orgs";
import type { OrgStatement } from "./org-statement";
import type { SqlTag } from "./postgres";
import type { RunPayerDeps } from "./payer";
import { ensureServicePrincipal, type ReplayStore, servicePrincipalId } from "./service-auth";

/** The one service slug an org's connect call is signed as. */
export const ORG_CONNECT_SERVICE = "org-connect";

export const ORG_ADMIN = "org:admin";
export const ORG_SPEND = "org:spend";

export type OrgRole = "admin" | "spend";
export type OrgStatus = "connected" | "disconnected" | "suspended";

export type OrgAct =
  | "org.connected"
  | "org.admins_changed"
  | "org.services_changed"
  | "org.disconnected"
  | "org.spend_granted"
  | "org.spend_claimed"
  | "org.spend_removed"
  | "org.suspended"
  | "org.restored"
  | "org.funded";

export type OrgErrorCode =
  | "not_found"
  | "not_allowed"
  | "org_suspended"
  | "invalid_wallet"
  | "invalid_reason"
  | "already_suspended"
  | "not_suspended"
  | "org_disconnected"
  | "statement_unavailable"
  | "not_in_directory"
  | "wrong_node"
  | "node_id_taken"
  | "no_signer"
  | "unversioned"
  | "invalid_amount"
  | "invalid_payment_ref";

export class OrgAccountError extends Error {
  readonly code: OrgErrorCode;
  constructor(code: OrgErrorCode, message: string) {
    super(message);
    this.name = "OrgAccountError";
    this.code = code;
  }
}

/** The longest reason a suspend or restore carries. */
export const MAX_ORG_REASON_CHARS = 500;
/** Most rows any list returns. */
export const MAX_ORG_ROWS = 100;

const WALLET = /^0x[0-9a-f]{40}$/;
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const strs = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
const num = (value: unknown): number => (typeof value === "number" ? value : Number(value ?? 0));
const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : typeof value === "string" ? new Date(value).toISOString() : null);
const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** The same facts: admins, services, DAO and repo-spec commit (the version, a build's commit time, is not a fact). */
const sameContent = (held: OrgAccountRow, statement: OrgStatement): boolean =>
  sameList(held.admins, statement.admins) && sameList(held.services, statement.services) && held.dao === statement.dao && held.commit === statement.commit;

/** The org account as the node stores it. */
export interface OrgAccountRow {
  readonly orgUserId: string;
  readonly billingAccountId: string;
  readonly nodeId: string;
  readonly origin: string;
  /** The host of `origin`: what a page shows as the org's name. */
  readonly name: string;
  readonly dao: string | null;
  /** The admin wallets of the LAST verified statement. Display and history only; authority reads the statement again. */
  readonly admins: readonly string[];
  readonly services: readonly string[];
  readonly version: number;
  readonly commit: string | null;
  readonly status: OrgStatus;
  readonly suspendReason: string | null;
  readonly suspendedAt: string | null;
}

function toOrg(row: Record<string, unknown> | undefined): OrgAccountRow | null {
  const orgUserId = str(row?.org_user_id);
  const billingAccountId = str(row?.billing_account_id);
  const origin = str(row?.origin);
  if (!row || !orgUserId || !billingAccountId || !origin) return null;
  const suspendedAt = iso(row.suspended_at);
  return {
    orgUserId,
    billingAccountId,
    nodeId: str(row.node_id) ?? "",
    origin,
    name: new URL(origin).host,
    dao: str(row.dao),
    admins: strs(row.admins),
    services: strs(row.services),
    version: num(row.statement_version),
    commit: str(row.statement_commit),
    status: suspendedAt ? "suspended" : row.disconnected_at ? "disconnected" : "connected",
    suspendReason: str(row.suspend_reason),
    suspendedAt,
  };
}

/** The org account with this user id, or null. */
export async function orgByUserId(sql: SqlTag, orgUserId: string): Promise<OrgAccountRow | null> {
  const rows = await sql`SELECT org_user_id, billing_account_id, node_id, origin, dao, admins, services, statement_version, statement_commit, disconnected_at, suspended_at, suspend_reason FROM org_accounts WHERE org_user_id = ${orgUserId} LIMIT 1`;
  return toOrg(rows[0]);
}

/** The org account of this billing account, or null when the account is not an org's. */
export async function orgByBillingAccount(sql: SqlTag, billingAccountId: string): Promise<OrgAccountRow | null> {
  const rows = await sql`SELECT org_user_id, billing_account_id, node_id, origin, dao, admins, services, statement_version, statement_commit, disconnected_at, suspended_at, suspend_reason FROM org_accounts WHERE billing_account_id = ${billingAccountId} LIMIT 1`;
  return toOrg(rows[0]);
}

/** The org account keyed by this origin, or null. */
export async function orgByOrigin(sql: SqlTag, origin: string): Promise<OrgAccountRow | null> {
  const rows = await sql`SELECT org_user_id, billing_account_id, node_id, origin, dao, admins, services, statement_version, statement_commit, disconnected_at, suspended_at, suspend_reason FROM org_accounts WHERE origin = ${origin} LIMIT 1`;
  return toOrg(rows[0]);
}

/** The highest statement version stored for an origin, or null: the floor a newer statement must meet. */
export async function heldStatementVersion(sql: SqlTag, origin: string): Promise<number | null> {
  const rows = await sql`SELECT statement_version FROM org_accounts WHERE origin = ${origin} LIMIT 1`;
  return rows[0] ? num(rows[0].statement_version) : null;
}

/**
 * Whether the account row already holds exactly these facts (admins, services, DAO, commit). Replicas of one build share a version, so a statement at or below the floor that says what the node
 * already holds (a re-read, or an older build's replica with the same facts) is a no-op, not `stale`; one that says anything else stays stale.
 */
export async function heldStatementMatches(sql: SqlTag, statement: OrgStatement): Promise<boolean> {
  const held = await orgByOrigin(sql, statement.origin);
  return held !== null && sameContent(held, statement);
}

/** Append one history row. Call it inside the act's own transaction. */
export async function logOrgEvent(
  tx: SqlTag,
  event: { orgUserId: string; act: OrgAct; actor: string; reason?: string | null; detail?: Record<string, unknown> | null }
): Promise<void> {
  await tx`
    INSERT INTO org_events (org_user_id, act, actor, reason, detail)
    VALUES (${event.orgUserId}, ${event.act}, ${event.actor}, ${event.reason ?? null}, ${event.detail ? JSON.stringify(event.detail) : null}::text::jsonb)`;
}

/**
 * The actor of an act the org's own signed call performs: the org's `org-connect` SERVICE PRINCIPAL (its `users.id`, created here if absent), so the history's actor is a real user row with a
 * name; the origin is in the event's detail. One write at most per call (only when an event is logged).
 */
export const orgActor = (tx: SqlTag, origin: string): Promise<string> => ensureServicePrincipal(tx, { issuer: origin, service: ORG_CONNECT_SERVICE });

export interface ConnectResult {
  /** False when the statement was OLDER than the one held and changed nothing: the caller must not serve or cache what it read. */
  readonly applied: boolean;
  readonly orgUserId: string;
  readonly billingAccountId: string;
  readonly status: OrgStatus;
  readonly reason: string | null;
  /** The statement version this node holds for the org AFTER this call (never lower than before): a connect answers it, so the org records an acknowledgement only for a statement that is held. */
  readonly version: number;
  /** Which lists this statement changed (each also wrote its history row): the host logs them. */
  readonly changed?: { readonly admins: boolean; readonly services: boolean };
}

/**
 * Apply a VERIFIED statement. `connect` creates the account (its users row, org principal and one billing account) or refreshes it, clears a disconnect and logs `org.connected`;
 * `refresh` only updates an account that exists and logs what changed. Both log `org.admins_changed` (old and new list) and `org.services_changed` when the lists differ. A statement
 * below the stored version changes nothing (a no-op, not a failure), and one naming another node id than the connected one is `wrong_node`. Run it in one service-role transaction.
 */
export async function applyStatement(tx: SqlTag, statement: OrgStatement, mode: "connect" | "refresh"): Promise<ConnectResult | null> {
  if (!isCanonicalOrgOrigin(statement.origin)) throw new OrgAccountError("not_found", "origin is not canonical");
  let orgUserId: string;
  let billingAccountId: string;
  if (mode === "connect") {
    const org = await ensureOrg(tx, { kind: "org-statement", ref: statement.origin });
    orgUserId = org.userId;
    billingAccountId = org.billingAccountId;
  } else {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`org_account:${statement.origin}`}))`;
    const existing = await orgByOrigin(tx, statement.origin);
    if (!existing) return null;
    orgUserId = existing.orgUserId;
    billingAccountId = existing.billingAccountId;
  }
  const locked = await tx`SELECT org_user_id, billing_account_id, node_id, origin, dao, admins, services, statement_version, statement_commit, disconnected_at, suspended_at, suspend_reason, (fetched_at < now() - interval '1 hour') AS old FROM org_accounts WHERE org_user_id = ${orgUserId} FOR UPDATE`;
  const current = toOrg(locked[0]);
  let actorId: string | null = null;
  const actor = async (): Promise<string> => (actorId ??= await orgActor(tx, statement.origin));
  // A statement older than the one held changes nothing (a replayed or skewed read is not a failure; the admin list it carries is never applied).
  // At or below the held version is stale unless it says exactly what is held: facts are constant per build, so an EQUAL version with other facts is another build's (never newer), and a lower
  // version with the same facts is processed as the held content. The stored version never goes down.
  if (current && statement.version <= current.version && !sameContent(current, statement))
    return { applied: false, orgUserId, billingAccountId, status: current.status, reason: current.suspendReason, version: current.version };
  // NODE_ID_IS_NEVER_OVERWRITTEN: the node id was fixed at connect (and checked against the directory); a statement that names another is refused.
  if (current && current.nodeId !== statement.nodeId) throw new OrgAccountError("wrong_node", "the statement's node id differs from the one connected");
  // NODE_ID_IS_UNIQUE: another origin already holds this node id. The unique index is the last word under a race; both answer `node_id_taken`.
  const taken = await tx`SELECT 1 AS taken FROM org_accounts WHERE node_id = ${statement.nodeId} AND org_user_id <> ${orgUserId} LIMIT 1`;
  if (taken.length > 0) throw new OrgAccountError("node_id_taken", "another origin already holds this node id");
  // The service rows change only when the service list does: a refresh with the same list writes nothing.
  if (!current || !sameList(current.services, statement.services)) await syncServicePrincipals(tx, orgUserId, statement);
  try {
    if (!current) {
      await tx`
        INSERT INTO org_accounts (org_user_id, billing_account_id, node_id, origin, dao, admins, services, statement_version, statement_commit)
        VALUES (${orgUserId}, ${billingAccountId}, ${statement.nodeId}, ${statement.origin}, ${statement.dao}, ${[...statement.admins]}::text[], ${[...statement.services]}::text[], ${statement.version}, ${statement.commit})`;
      await logOrgEvent(tx, {
        orgUserId,
        act: "org.connected",
        actor: await actor(),
        detail: { origin: statement.origin, admins: [...statement.admins], services: [...statement.services], version: statement.version, commit: statement.commit, dao: statement.dao },
      });
      return { applied: true, orgUserId, billingAccountId, status: "connected", reason: null, version: statement.version };
    }
    const contentChanged =
      !sameList(current.admins, statement.admins) || !sameList(current.services, statement.services) || current.dao !== statement.dao || current.commit !== statement.commit;
    const old = locked[0]?.old === true;
    // `fetched_at` and the stored version move only when the content changed, on a connect, or when the row is an hour old: a refresh that read the same content writes nothing.
    if (mode === "connect" || contentChanged || old)
      await tx`
        UPDATE org_accounts
        SET dao = ${statement.dao}, admins = ${[...statement.admins]}::text[], services = ${[...statement.services]}::text[],
            statement_version = GREATEST(statement_version, ${statement.version}::bigint), statement_commit = ${statement.commit}, fetched_at = now(),
            disconnected_at = CASE WHEN ${mode === "connect"} THEN NULL ELSE disconnected_at END,
            connected_at = CASE WHEN ${mode === "connect"} AND disconnected_at IS NOT NULL THEN now() ELSE connected_at END
        WHERE org_user_id = ${orgUserId}`;
  } catch (error) {
    const e = error as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
    if (e?.code === "23505" && (e.constraint_name === "org_accounts_node_id_unique" || e.constraint === "org_accounts_node_id_unique"))
      throw new OrgAccountError("node_id_taken", "another origin already holds this node id");
    throw error;
  }
  if (mode === "connect")
    await logOrgEvent(tx, { orgUserId, act: "org.connected", actor: await actor(), detail: { origin: statement.origin, version: statement.version, commit: statement.commit, reconnect: current.status === "disconnected" } });
  if (!sameList(current.admins, statement.admins))
    await logOrgEvent(tx, { orgUserId, act: "org.admins_changed", actor: await actor(), detail: { origin: statement.origin, old: [...current.admins], new: [...statement.admins], version: statement.version, commit: statement.commit } });
  if (!sameList(current.services, statement.services))
    await logOrgEvent(tx, { orgUserId, act: "org.services_changed", actor: await actor(), detail: { origin: statement.origin, old: [...current.services], new: [...statement.services], version: statement.version } });
  const status: OrgStatus = current.suspendedAt ? "suspended" : mode === "connect" || current.status !== "disconnected" ? "connected" : "disconnected";
  return {
    applied: true,
    orgUserId,
    billingAccountId,
    status,
    reason: current.suspendReason,
    version: Math.max(current.version, statement.version),
    changed: { admins: !sameList(current.admins, statement.admins), services: !sameList(current.services, statement.services) },
  };
}

/** One indexed row per (org, enabled service): the service principal's id, so a calling service is found by one primary-key read. Removed services lose their row. */
async function syncServicePrincipals(tx: SqlTag, orgUserId: string, statement: OrgStatement): Promise<void> {
  const services = [...statement.services];
  await tx`DELETE FROM org_service_principals WHERE org_user_id = ${orgUserId} AND service <> ALL(${services}::text[])`;
  if (services.length === 0) return;
  const ids = await Promise.all(services.map((service) => servicePrincipalId({ issuer: statement.origin, service })));
  await tx`
    INSERT INTO org_service_principals (service_user_id, org_user_id, service)
    SELECT t.id, ${orgUserId}, t.service FROM unnest(${ids}::text[], ${services}::text[]) AS t(id, service)
    ON CONFLICT DO NOTHING`;
}

/** The org's signed disconnect: its services stop at the next call. Idempotent (a second disconnect logs nothing). Null when the org never connected. */
export async function disconnectOrg(tx: SqlTag, origin: string): Promise<ConnectResult | null> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`org_account:${origin}`}))`;
  const org = await orgByOrigin(tx, origin);
  if (!org) return null;
  const rows = await tx`UPDATE org_accounts SET disconnected_at = now() WHERE org_user_id = ${org.orgUserId} AND disconnected_at IS NULL RETURNING org_user_id`;
  if (rows.length > 0) await logOrgEvent(tx, { orgUserId: org.orgUserId, act: "org.disconnected", actor: await orgActor(tx, origin), detail: { origin } });
  return { applied: true, orgUserId: org.orgUserId, billingAccountId: org.billingAccountId, status: org.suspendedAt ? "suspended" : "disconnected", reason: org.suspendReason, version: org.version };
}

const reasonOf = (reason: string): string => {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text.length === 0 || text.length > MAX_ORG_REASON_CHARS) throw new OrgAccountError("invalid_reason", "a reason of 1 to 500 characters is required");
  return text;
};

/** This node's admin suspends an org account with a reason. Never touches the org's admins (NO_TAKEOVER). `by` is the admin session's user id. */
export async function suspendOrg(tx: SqlTag, input: { orgUserId: string; by: string; reason: string }): Promise<void> {
  const reason = reasonOf(input.reason);
  const rows = await tx`
    UPDATE org_accounts SET suspended_at = now(), suspended_by = ${input.by}, suspend_reason = ${reason}
    WHERE org_user_id = ${input.orgUserId} AND suspended_at IS NULL RETURNING org_user_id`;
  if (rows.length === 0) {
    const exists = await orgByUserId(tx, input.orgUserId);
    throw new OrgAccountError(exists ? "already_suspended" : "not_found", exists ? "already suspended" : "no such org account");
  }
  await logOrgEvent(tx, { orgUserId: input.orgUserId, act: "org.suspended", actor: input.by, reason });
}

/** This node's admin restores a suspended org account, with a reason. */
export async function restoreOrg(tx: SqlTag, input: { orgUserId: string; by: string; reason: string }): Promise<void> {
  const reason = reasonOf(input.reason);
  const rows = await tx`
    UPDATE org_accounts SET suspended_at = NULL, suspended_by = NULL, suspend_reason = NULL
    WHERE org_user_id = ${input.orgUserId} AND suspended_at IS NOT NULL RETURNING org_user_id`;
  if (rows.length === 0) {
    const exists = await orgByUserId(tx, input.orgUserId);
    throw new OrgAccountError(exists ? "not_suspended" : "not_found", exists ? "not suspended" : "no such org account");
  }
  await logOrgEvent(tx, { orgUserId: input.orgUserId, act: "org.restored", actor: input.by, reason });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------------------------------------------------------------------------------

async function liveSpendRow(sql: SqlTag, userId: string, billingAccountId: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 AS ok FROM agent_roles
    WHERE principal_user_id = ${userId} AND resource = 'account' AND account_id = ${billingAccountId} AND scope = ${ORG_SPEND}
      AND approved_by IS NOT NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`;
  return rows.length > 0;
}

/**
 * The person's role on an org account: `admin` when the org's statement lists a wallet the person bound (read now, cached at most 5 minutes in the owner source), else `spend` when
 * an admin granted `org:spend` and the row is live, else null. An unreadable statement lapses ONLY the admin role (`adminLapsed`): a live spend row still answers `spend`.
 * `org:admin` includes `org:spend`, so an admin needs no row.
 */
export async function orgRoleOf(
  sql: SqlTag,
  owners: OrgOwners | undefined,
  input: { userId: string; org: Pick<OrgAccountRow, "origin" | "billingAccountId">; /** When the caller already read whether a live `org:spend` row exists (a list), no second query. */ knownSpend?: boolean }
): Promise<{ role: OrgRole | null; adminLapsed: boolean }> {
  let adminLapsed = false;
  if (owners) {
    try {
      if ((await owners.owners({ kind: "org-statement", ref: input.org.origin })).includes(input.userId)) return { role: "admin", adminLapsed };
    } catch (error) {
      if (!(error instanceof OwnerSourceUnavailableError)) throw error;
      adminLapsed = true;
    }
  }
  const spends = input.knownSpend ?? (await liveSpendRow(sql, input.userId, input.org.billingAccountId));
  return { role: spends ? "spend" : null, adminLapsed };
}

/** The person's bound wallets, lowercase (at most 20). Read it once per request and pass it on (`claimHolds`, `listMyOrgs`). */
export const userWallets = async (sql: SqlTag, userId: string): Promise<string[]> =>
  (await sql`SELECT external_id FROM user_bindings WHERE user_id = ${userId} AND provider = 'wallet' ORDER BY external_id LIMIT 20`).map((r) => String(r.external_id).toLowerCase());
const walletsOf = userWallets;

async function insertSpendRow(tx: SqlTag, input: { userId: string; billingAccountId: string; approvedBy: string }): Promise<boolean> {
  const rows = await tx`
    INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, resource, account_id)
    VALUES (${input.userId}, ${ORG_SPEND}, ${input.approvedBy}, now(), 'account', ${input.billingAccountId})
    ON CONFLICT DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

/**
 * An ADMIN of the org (the caller decided that, from the statement) gives a wallet `org:spend` on this account. A wallet that already has a user here gets an `agent_roles` row now; any
 * other wallet gets an `org_wallet_holds` row that `claimHolds` turns into the same row at that wallet's first read after sign-in. Logs `org.spend_granted` (detail: wallet, held).
 * Returns `changed: false` when the grant already exists or the wallet is the admin's own (an admin already spends).
 */
export async function grantOrgSpend(tx: SqlTag, input: { org: OrgAccountRow; by: string; wallet: string }): Promise<{ changed: boolean; held: boolean }> {
  const wallet = input.wallet.toLowerCase();
  if (!WALLET.test(wallet)) throw new OrgAccountError("invalid_wallet", "wallet must be a 0x address");
  const bound = await tx`SELECT user_id FROM user_bindings WHERE provider = 'wallet' AND external_id = ${wallet} LIMIT 1`;
  const userId = str(bound[0]?.user_id);
  let changed: boolean;
  let held = false;
  if (userId) {
    if (userId === input.by) return { changed: false, held: false };
    changed = await insertSpendRow(tx, { userId, billingAccountId: input.org.billingAccountId, approvedBy: input.by });
  } else {
    held = true;
    const rows = await tx`
      INSERT INTO org_wallet_holds (org_user_id, wallet, scope, granted_by)
      VALUES (${input.org.orgUserId}, ${wallet}, ${ORG_SPEND}, ${input.by})
      ON CONFLICT (org_user_id, wallet, scope) WHERE claimed_at IS NULL AND revoked_at IS NULL DO NOTHING
      RETURNING id`;
    changed = rows.length > 0;
  }
  if (changed) await logOrgEvent(tx, { orgUserId: input.org.orgUserId, act: "org.spend_granted", actor: input.by, detail: { wallet, held } });
  return { changed, held };
}

/** An admin takes `org:spend` away from a wallet: revokes its live row and any waiting hold. Logs `org.spend_removed`. */
export async function removeOrgSpend(tx: SqlTag, input: { org: OrgAccountRow; by: string; wallet: string }): Promise<{ changed: boolean }> {
  const wallet = input.wallet.toLowerCase();
  if (!WALLET.test(wallet)) throw new OrgAccountError("invalid_wallet", "wallet must be a 0x address");
  // LOCK_ORDER: holds first, then roles: the same order `claimHolds` takes them in (it locks the hold rows, then inserts the role), so the two cannot deadlock.
  const holds = await tx`
    UPDATE org_wallet_holds SET revoked_at = now()
    WHERE org_user_id = ${input.org.orgUserId} AND wallet = ${wallet} AND scope = ${ORG_SPEND} AND claimed_at IS NULL AND revoked_at IS NULL
    RETURNING id`;
  const rows = await tx`
    UPDATE agent_roles r SET revoked_at = now()
    FROM user_bindings ub
    WHERE ub.provider = 'wallet' AND ub.external_id = ${wallet} AND r.principal_user_id = ub.user_id
      AND r.resource = 'account' AND r.account_id = ${input.org.billingAccountId} AND r.scope = ${ORG_SPEND} AND r.revoked_at IS NULL
    RETURNING r.id`;
  const changed = rows.length > 0 || holds.length > 0;
  if (changed) await logOrgEvent(tx, { orgUserId: input.org.orgUserId, act: "org.spend_removed", actor: input.by, detail: { wallet } });
  return { changed };
}

/** Throws `org_suspended` when this billing account is an org's and suspended. Called at every charge point, so a suspension stops the next call without relying on row-level security. */
export async function assertOrgChargeable(sql: SqlTag, billingAccountId: string): Promise<void> {
  // The charge point reads only what it decides on, not the whole account row.
  const rows = await sql`SELECT suspended_at, suspend_reason FROM org_accounts WHERE billing_account_id = ${billingAccountId} LIMIT 1`;
  if (rows[0]?.suspended_at) throw new OrgAccountError("org_suspended", str(rows[0].suspend_reason) ?? "suspended");
}

/**
 * The replay store of the org connect door, in the database so every replica shares it (a `jti` is single-use inside its window). A row lives until its assertion expires; expired rows are
 * removed on each call. `seen` is true for a repeat. A database failure rejects (the door answers 503), never a pass.
 */
export function createPostgresReplayStore(sql: SqlTag): ReplayStore {
  return {
    async seen(jti, expiresAt) {
      await sql`DELETE FROM org_connect_jtis WHERE expires_at < now()`;
      const rows = await sql`INSERT INTO org_connect_jtis (jti, expires_at) VALUES (${jti}, ${expiresAt.toISOString()}) ON CONFLICT (jti) DO NOTHING RETURNING jti`;
      return rows.length === 0;
    },
  };
}

/** Does this person's wallet list hold an open (unclaimed, unrevoked) spend hold? One plain read, so the node opens a transaction only when there is something to claim. */
export async function hasOpenHolds(sql: SqlTag, wallets: readonly string[]): Promise<boolean> {
  if (wallets.length === 0) return false;
  const rows = await sql`SELECT 1 AS open FROM org_wallet_holds WHERE wallet = ANY(${[...wallets]}::text[]) AND claimed_at IS NULL AND revoked_at IS NULL AND scope = ${ORG_SPEND} LIMIT 1`;
  return rows.length > 0;
}

/**
 * Turn the holds of the wallets this person has bound into live `org:spend` rows (the person has signed in; the account menu reads "Your orgs" and that read claims). Skips a hold the person granted
 * themself. A hold for an org where the person already holds a live row is closed without a second row and without an event. Rows, closes and events are each ONE statement for the whole batch
 * (at most 20 holds). Logs `org.spend_claimed` for each row made and returns that count. `wallets` is the person's wallet list the caller already read.
 */
export async function claimHolds(tx: SqlTag, userId: string, wallets?: readonly string[]): Promise<number> {
  const mine = wallets ?? (await walletsOf(tx, userId));
  if (mine.length === 0) return 0;
  const holds = await tx`
    SELECT h.id, h.org_user_id, h.granted_by, a.billing_account_id
    FROM org_wallet_holds h JOIN org_accounts a ON a.org_user_id = h.org_user_id
    WHERE h.wallet = ANY(${[...mine]}::text[]) AND h.claimed_at IS NULL AND h.revoked_at IS NULL AND h.scope = ${ORG_SPEND}
    ORDER BY h.created_at LIMIT 20
    FOR UPDATE OF h`;
  const eligible = holds.flatMap((hold) => {
    const grantedBy = str(hold.granted_by);
    const orgUserId = str(hold.org_user_id);
    const billingAccountId = str(hold.billing_account_id);
    return grantedBy && orgUserId && billingAccountId && grantedBy !== userId ? [{ id: String(hold.id), grantedBy, orgUserId, billingAccountId }] : [];
  });
  if (eligible.length === 0) return 0;
  const made = await tx`
    INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, resource, account_id)
    SELECT ${userId}, ${ORG_SPEND}, t.by, now(), 'account', t.account
    FROM unnest(${eligible.map((h) => h.grantedBy)}::text[], ${eligible.map((h) => h.billingAccountId)}::text[]) AS t(by, account)
    ON CONFLICT DO NOTHING
    RETURNING account_id`;
  const madeFor = new Set(made.map((row) => String(row.account_id)));
  await tx`UPDATE org_wallet_holds SET claimed_at = now() WHERE id::text = ANY(${eligible.map((h) => h.id)}::text[])`;
  // One event per org the person newly spends for (a second wallet of the same person for the same org is one row, one event).
  const events = [...new Map(eligible.filter((h) => madeFor.has(h.billingAccountId)).map((h) => [h.billingAccountId, h])).values()];
  if (events.length > 0)
    await tx`
      INSERT INTO org_events (org_user_id, act, actor, detail)
      SELECT t.org, 'org.spend_claimed', ${userId}, jsonb_build_object('grantedBy', t.by)
      FROM unnest(${events.map((h) => h.orgUserId)}::text[], ${events.map((h) => h.grantedBy)}::text[]) AS t(org, by)`;
  return madeFor.size;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Reads for the pages
// ---------------------------------------------------------------------------------------------------------------------------------------------------

export interface MyOrgRow {
  readonly orgUserId: string;
  /** The org's billing account id: what the composer sends as Bill to. */
  readonly billingAccountId: string;
  readonly name: string;
  readonly role: OrgRole;
  /** Credits on the org's billing account (billing's number, shown as is). */
  readonly balance: number;
  readonly status: OrgStatus;
}

const balanceOf = async (sql: SqlTag, billingAccountId: string): Promise<number> => {
  const rows = await sql`SELECT balance_credits FROM billing_accounts WHERE id = ${billingAccountId} LIMIT 1`;
  return num(rows[0]?.balance_credits);
};

/** Statement reads a list of orgs may have in flight at once. */
const STATEMENT_FANOUT = 5;

/** `map` with at most `limit` calls in flight; the result keeps the input's order and the first failure is thrown. */
async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * "Your orgs": the org accounts the person holds a role on, on this node. ONE query reads the candidates with their balance and whether the person holds a live `org:spend` row (accounts whose
 * last verified admin list names one of the person's wallets, plus accounts they hold a spend row on), LIMIT n+1 so `next` is exact. A candidate is an admin when one of the person's wallets
 * (read once, above) is in the org's CURRENT statement (`adminsOf`: the cached statement, at most five reads at a time, an unreadable one remembered briefly): no per-org database query, and a removed approver
 * never lists. The node calls `claimHolds` first, in its own transaction, so a waiting spend grant is already a row.
 */
export async function listMyOrgs(
  tx: SqlTag,
  adminsOf: ((origin: string) => Promise<readonly string[]>) | undefined,
  userId: string,
  knownWallets?: readonly string[],
  /** The previous page's `next` (an origin): the list is keyset-paged by origin, so no org is skipped or repeated. */
  after?: string | null
): Promise<{ orgs: MyOrgRow[]; next: string | null }> {
  const wallets = [...(knownWallets ?? (await walletsOf(tx, userId)))];
  const mine = new Set(wallets);
  const candidates = await tx`
    SELECT a.org_user_id, a.billing_account_id, a.node_id, a.origin, a.dao, a.admins, a.services, a.statement_version, a.statement_commit, a.disconnected_at, a.suspended_at, a.suspend_reason,
           b.balance_credits,
           EXISTS (SELECT 1 FROM agent_roles r WHERE r.principal_user_id = ${userId} AND r.resource = 'account' AND r.account_id = a.billing_account_id
                   AND r.scope = ${ORG_SPEND} AND r.approved_by IS NOT NULL AND r.revoked_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > now())) AS spends
    FROM org_accounts a JOIN billing_accounts b ON b.id = a.billing_account_id
    WHERE a.origin > ${after ?? ""}
      AND (a.admins && ${wallets}::text[]
        OR EXISTS (SELECT 1 FROM agent_roles r WHERE r.principal_user_id = ${userId} AND r.resource = 'account' AND r.account_id = a.billing_account_id
                   AND r.scope = ${ORG_SPEND} AND r.approved_by IS NOT NULL AND r.revoked_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > now())))
    ORDER BY a.origin LIMIT ${MAX_ORG_ROWS + 1}`;
  // A cold cache reads one statement per org: at most STATEMENT_FANOUT of them at a time, never one per row at once.
  const decided = await mapBounded(
    candidates.slice(0, MAX_ORG_ROWS),
    STATEMENT_FANOUT,
    async (row): Promise<MyOrgRow | null> => {
      const org = toOrg(row);
      if (!org) return null;
      let admin = false;
      if (adminsOf && mine.size > 0) {
        try {
          admin = (await adminsOf(org.origin)).some((wallet) => mine.has(wallet));
        } catch (error) {
          // LAPSE_WHEN_UNREADABLE: an unreadable statement drops only the admin role; a live spend row still lists.
          if (!(error instanceof OwnerSourceUnavailableError)) throw error;
        }
      }
      const role: OrgRole | null = admin ? "admin" : row.spends === true ? "spend" : null;
      return role ? { orgUserId: org.orgUserId, billingAccountId: org.billingAccountId, name: org.name, role, balance: num(row.balance_credits), status: org.status } : null;
    }
  );
  const lastCandidate = candidates[MAX_ORG_ROWS - 1];
  return { orgs: decided.filter((row): row is MyOrgRow => row !== null), next: candidates.length > MAX_ORG_ROWS && lastCandidate ? String(lastCandidate.origin) : null };
}

export interface OrgPersonRow {
  /** Wallet address, or a service slug. */
  readonly who: string;
  readonly kind: "person" | "service";
  readonly role: OrgRole | "service";
  /** A spend grant held for a wallet that has not signed in yet. */
  readonly held: boolean;
  /** An admin may remove it: a spend grant, never an admin (they come from the statement) or a service. */
  readonly removable: boolean;
}

export interface OrgEventRow {
  readonly act: OrgAct;
  /** A short label of the actor: a wallet, an org host, or a name. */
  readonly actor: string;
  readonly reason: string | null;
  readonly at: string;
}

export interface OrgAccountView {
  readonly orgUserId: string;
  readonly name: string;
  readonly role: OrgRole;
  readonly status: OrgStatus;
  readonly suspendReason: string | null;
  readonly balance: number;
  /** The org's billing account id in the SINGLE-ORG view: present only when the viewer is `org:admin` (the one role that may fund it). (The org LIST gives a spender the id too, by design: Bill to needs it.) */
  readonly billingAccountId?: string;
  /** Only an admin manages and reads the history. */
  readonly canManage: boolean;
  readonly adminLapsed: boolean;
  readonly people: readonly OrgPersonRow[];
  /** The cursor of the next page of grants (pass back as `peopleAfter`), or null on the last page. The admins and services are on the first page only. */
  readonly peopleNext: string | null;
  readonly history: readonly OrgEventRow[];
  /** The cursor of the next, older page of history (pass back as `historyBefore`), or null on the last page. */
  readonly historyNext: string | null;
}

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Events per page of an org's history. */
export const ORG_EVENTS_PAGE = 50;

/**
 * The org's history, newest first, one page. The history is an audit trail and a complete view never truncates: `next` is the cursor of the next (older) page, to pass back as `before`
 * (null on the last page). The caller has already checked the person is an admin of the org.
 */
export async function listOrgEvents(sql: SqlTag, orgUserId: string, input: { before?: string | null; limit?: number } = {}): Promise<{ events: OrgEventRow[]; next: string | null }> {
  const take = Math.min(input.limit ?? ORG_EVENTS_PAGE, MAX_ORG_ROWS);
  // The cursor is `<created_at as the database prints it, microseconds kept>|<id>`: strictly older than that row, ties broken by id. A malformed cursor is the first page.
  const [beforeAt, beforeId] = typeof input.before === "string" && input.before.includes("|") ? (input.before.split("|", 2) as [string, string]) : [null, null];
  const cursorOk = !!beforeAt && !!beforeId && CURSOR_AT.test(beforeAt) && CURSOR_ID.test(beforeId);
  const rows =
    cursorOk
      ? await sql`SELECT id, act, actor, reason, created_at, created_at::text AS cursor_at FROM org_events WHERE org_user_id = ${orgUserId} AND (created_at, id) < (${beforeAt}::text::timestamptz, ${beforeId}::text::uuid) ORDER BY created_at DESC, id DESC LIMIT ${take + 1}`
      : await sql`SELECT id, act, actor, reason, created_at, created_at::text AS cursor_at FROM org_events WHERE org_user_id = ${orgUserId} ORDER BY created_at DESC, id DESC LIMIT ${take + 1}`;
  const page = rows.slice(0, take);
  // ONE query labels every actor: a wallet when the user has one, else the user's name; an org actor is its origin's host.
  const ids = [...new Set(page.map((row) => String(row.actor)).filter((actor) => !actor.startsWith("org:")))];
  const labels = new Map<string, string>();
  if (ids.length > 0) {
    const users = await sql`
      SELECT u.id, u.name, (SELECT ub.external_id FROM user_bindings ub WHERE ub.user_id = u.id AND ub.provider = 'wallet' ORDER BY ub.external_id LIMIT 1) AS wallet
      FROM users u WHERE u.id = ANY(${ids}::text[])`;
    for (const u of users) labels.set(String(u.id), str(u.wallet)?.toLowerCase() ?? str(u.name) ?? "unknown");
  }
  const label = (actor: string): string => {
    if (!actor.startsWith("org:")) return labels.get(actor) ?? "unknown";
    try {
      return new URL(actor.slice(4)).host;
    } catch {
      return "unknown";
    }
  };
  const last = page[page.length - 1];
  return {
    events: page.map((row) => ({ act: String(row.act) as OrgAct, actor: label(String(row.actor)), reason: str(row.reason), at: iso(row.created_at) ?? "" })),
    next: rows.length > take && last ? `${String(last.cursor_at)}|${String(last.id)}` : null,
  };
}

/** Spend grants and waiting holds per page of the people list. */
export const ORG_PEOPLE_PAGE = 100;

/**
 * The org account page for one person: null (one non-disclosing answer) when they hold no role. A spender sees the summary; an admin also sees the people and the history. A complete view never
 * truncates: the people (grants and waiting holds) and the history are paged, `peopleNext` and `historyNext` are the cursors to pass back as `peopleAfter` and `historyBefore`. A request with a
 * cursor returns only that list's next page (the other list is empty), so "More" costs one read.
 */
export async function orgAccountView(
  tx: SqlTag,
  input: {
    owners: OrgOwners | undefined;
    statementServices?: (origin: string) => Promise<readonly string[]>;
    userId: string;
    orgUserId: string;
    historyBefore?: string | null;
    peopleAfter?: string | null;
  }
): Promise<OrgAccountView | null> {
  const org = await orgByUserId(tx, input.orgUserId);
  if (!org) return null;
  const { role, adminLapsed } = await orgRoleOf(tx, input.owners, { userId: input.userId, org });
  if (!role) return null;
  const base = { orgUserId: org.orgUserId, name: org.name, role, status: org.status, suspendReason: org.suspendReason, balance: await balanceOf(tx, org.billingAccountId), adminLapsed };
  if (role !== "admin") return { ...base, canManage: false, people: [], peopleNext: null, history: [], historyNext: null };
  // The people cursor is `<at as the database prints it>|<ord>` (keyset on (at, ord)); a malformed one is the first page.
  const [afterAt, afterOrd] = typeof input.peopleAfter === "string" && input.peopleAfter.includes("|") ? (input.peopleAfter.split("|", 2) as [string, string]) : [null, null];
  const peopleCursor = !!afterAt && !!afterOrd && CURSOR_AT.test(afterAt) && CURSOR_ID.test(afterOrd);
  const firstPage = !peopleCursor;
  const wantsPeople = input.historyBefore == null;
  const wantsHistory = input.peopleAfter == null;
  // The reads are independent: one round of waiting, not one per list.
  const [services, grants, history] = await Promise.all([
    wantsPeople && firstPage ? (input.statementServices ? input.statementServices(org.origin).catch(() => org.services) : Promise.resolve(org.services)) : Promise.resolve([] as readonly string[]),
    wantsPeople
      ? peopleCursor
  ? tx`
          SELECT kind, wallet, occurred_at::text AS cursor_at, ord FROM (
            SELECT 'spend' AS kind,
                   (SELECT external_id FROM user_bindings ub WHERE ub.user_id = r.principal_user_id AND ub.provider = 'wallet' ORDER BY external_id LIMIT 1) AS wallet,
                   r.granted_at AS occurred_at, r.id::text AS ord
            FROM agent_roles r
            WHERE r.resource = 'account' AND r.account_id = ${org.billingAccountId} AND r.scope = ${ORG_SPEND} AND r.approved_by IS NOT NULL AND r.revoked_at IS NULL
              AND (r.expires_at IS NULL OR r.expires_at > now())
            UNION ALL
            SELECT 'hold' AS kind, h.wallet, h.created_at AS occurred_at, h.id::text AS ord
            FROM org_wallet_holds h
            WHERE h.org_user_id = ${org.orgUserId} AND h.scope = ${ORG_SPEND} AND h.claimed_at IS NULL AND h.revoked_at IS NULL
          ) g
          WHERE g.wallet IS NOT NULL AND (g.occurred_at, g.ord) > (${afterAt}::text::timestamptz, ${afterOrd}::text)
          ORDER BY g.occurred_at, g.ord LIMIT ${ORG_PEOPLE_PAGE + 1}`
      : tx`
          SELECT kind, wallet, occurred_at::text AS cursor_at, ord FROM (
            SELECT 'spend' AS kind,
                   (SELECT external_id FROM user_bindings ub WHERE ub.user_id = r.principal_user_id AND ub.provider = 'wallet' ORDER BY external_id LIMIT 1) AS wallet,
                   r.granted_at AS occurred_at, r.id::text AS ord
            FROM agent_roles r
            WHERE r.resource = 'account' AND r.account_id = ${org.billingAccountId} AND r.scope = ${ORG_SPEND} AND r.approved_by IS NOT NULL AND r.revoked_at IS NULL
              AND (r.expires_at IS NULL OR r.expires_at > now())
            UNION ALL
            SELECT 'hold' AS kind, h.wallet, h.created_at AS occurred_at, h.id::text AS ord
            FROM org_wallet_holds h
            WHERE h.org_user_id = ${org.orgUserId} AND h.scope = ${ORG_SPEND} AND h.claimed_at IS NULL AND h.revoked_at IS NULL
          ) g
          WHERE g.wallet IS NOT NULL
          ORDER BY g.occurred_at, g.ord LIMIT ${ORG_PEOPLE_PAGE + 1}`
      : Promise.resolve([] as Array<Record<string, unknown>>),
    wantsHistory ? listOrgEvents(tx, org.orgUserId, { before: input.historyBefore ?? null }) : Promise.resolve({ events: [] as OrgEventRow[], next: null as string | null }),
  ]);
  const grantRows = grants.slice(0, ORG_PEOPLE_PAGE).map((r): OrgPersonRow => (r.kind === "hold" ? { who: String(r.wallet), kind: "person", role: "spend", held: true, removable: true } : { who: String(r.wallet).toLowerCase(), kind: "person", role: "spend", held: false, removable: true }));
  const people: OrgPersonRow[] =
    wantsPeople && firstPage
      ? [
          ...org.admins.map((who): OrgPersonRow => ({ who, kind: "person", role: "admin", held: false, removable: false })),
          ...grantRows,
          ...services.map((who): OrgPersonRow => ({ who, kind: "service", role: "service", held: false, removable: false })),
        ]
      : grantRows;
  return {
    ...base,
    billingAccountId: org.billingAccountId,
    canManage: true,
    people,
    peopleNext: wantsPeople && grants.length > ORG_PEOPLE_PAGE ? `${String(grants[ORG_PEOPLE_PAGE - 1]?.cursor_at)}|${String(grants[ORG_PEOPLE_PAGE - 1]?.ord)}` : null,
    history: history.events,
    historyNext: history.next,
  };
}

export interface AdminOrgRow {
  readonly orgUserId: string;
  readonly name: string;
  readonly status: OrgStatus;
  readonly reason: string | null;
}

/** Org accounts per page of `/admin`. */
export const ADMIN_ORG_PAGE = 50;

/** One page of the org accounts on this node, by origin, for `/admin` (`after` is the previous page's `next`). The caller already checked the node-admin session. */
export async function listOrgAccountsForAdmin(sql: SqlTag, input: { after?: string | null } = {}): Promise<{ orgs: AdminOrgRow[]; next: string | null }> {
  const after = input.after ?? "";
  const rows = await sql`SELECT org_user_id, billing_account_id, node_id, origin, dao, admins, services, statement_version, statement_commit, disconnected_at, suspended_at, suspend_reason FROM org_accounts WHERE origin > ${after} ORDER BY origin LIMIT ${ADMIN_ORG_PAGE + 1}`;
  const orgs = rows.slice(0, ADMIN_ORG_PAGE).flatMap((row): AdminOrgRow[] => {
    const org = toOrg(row);
    return org ? [{ orgUserId: org.orgUserId, name: org.name, status: org.status, reason: org.suspendReason }] : [];
  });
  const last = rows[ADMIN_ORG_PAGE - 1];
  return { orgs, next: rows.length > ADMIN_ORG_PAGE && last ? String(last.origin) : null };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// ONE_RESOLVER: who pays
// ---------------------------------------------------------------------------------------------------------------------------------------------------

/** The org account a billing account belongs to, as the resolver reads it. */
export type BillToOrg = Pick<OrgAccountRow, "orgUserId" | "billingAccountId" | "origin" | "status" | "suspendReason">;

export interface BillToDeps<A extends { readonly id: string; readonly ownerUserId?: string | undefined }> extends RunPayerDeps<A> {
  /** The org account of a billing account, or null when it is not a CONNECTED org's. */
  orgOfAccount(billingAccountId: string): Promise<BillToOrg | null>;
  /** Is this billing account owned by ANY org principal (a connected org, or a legacy repo-spec org)? Such an account is never billed through a payer binding. */
  isOrgAccount(billingAccountId: string): Promise<boolean>;
  /** The org a calling service principal belongs to (its issuer is the org's origin) and the service slug, or null. */
  orgOfServicePrincipal(userId: string): Promise<{ org: BillToOrg; service: string } | null>;
  /** The person's role on the org (`orgRoleOf`). */
  roleOf(userId: string, org: BillToOrg): Promise<{ role: OrgRole | null; adminLapsed: boolean }>;
  /** Does the org's CURRENT statement enable this service? An unreadable statement is false (the service lapses). */
  serviceEnabled(org: BillToOrg, service: string): Promise<boolean>;
}

export type BillToSource = "org" | "service" | "binding" | "own";

export interface BillTo<A> {
  readonly account: A;
  readonly source: BillToSource;
  /** The user whose row-level-security scope reads and charges the account: the org's user for an org account, else the caller. */
  readonly chargeScopeUserId: string;
  readonly orgUserId?: string;
}

/** Suspended, disconnected, or a service the org's CURRENT statement no longer enables (or cannot be read) is an explicit refusal. */
async function requireServiceBillable<A extends { readonly id: string; readonly ownerUserId?: string | undefined }>(deps: BillToDeps<A>, org: BillToOrg, service: string): Promise<void> {
  if (org.status === "suspended") refuseSuspended(org);
  if (org.status === "disconnected") throw new OrgAccountError("org_disconnected", "the org is disconnected");
  if (!(await deps.serviceEnabled(org, service))) throw new OrgAccountError("org_disconnected", "the org's statement does not enable this service");
}

const refuseSuspended = (org: BillToOrg): never => {
  throw new OrgAccountError("org_suspended", org.suspendReason ?? "suspended");
};

/**
 * ONE_RESOLVER. The paying account for a run:
 * 1. `chosenAccountId` (the person picked Bill to: an org): it must be an org account the person holds `org:spend` or `org:admin` on, else `not_allowed` (never a silent fallback to
 *    another payer). A suspended org is `org_suspended`.
 * 2. A calling service of an org (its principal's issuer is the org's origin) whose service the org's current statement enables: that org's account. Suspended or disconnected is refused.
 * 3. A live payer binding of a person's account (story.0038; never an org's), else 4. the caller's own account.
 * Billing checks the balance and limits after this names the account.
 */
export async function resolveBillTo<A extends { readonly id: string; readonly ownerUserId?: string | undefined }>(
  deps: BillToDeps<A>,
  input: { subjectUserId: string; own: A; chosenAccountId?: string | undefined }
): Promise<BillTo<A>> {
  const { subjectUserId, own } = input;
  if (input.chosenAccountId && input.chosenAccountId !== own.id) {
    const org = await deps.orgOfAccount(input.chosenAccountId);
    if (!org) throw new OrgAccountError("not_allowed", "not allowed to bill this account");
    const { role, adminLapsed } = await deps.roleOf(subjectUserId, org);
    // An unreadable statement is not "not allowed": the person may well be an admin, so it is a 503, never a verdict.
    if (!role) throw adminLapsed ? new OrgAccountError("statement_unavailable", "the org's statement cannot be read") : new OrgAccountError("not_allowed", "not allowed to bill this account");
    if (org.status === "suspended") refuseSuspended(org);
    const account = await deps.getAccount(org.billingAccountId);
    if (!account) throw new OrgAccountError("not_allowed", "not allowed to bill this account");
    return { account, source: "org", chargeScopeUserId: org.orgUserId, orgUserId: org.orgUserId };
  }
  const calling = await deps.orgOfServicePrincipal(subjectUserId);
  if (calling) {
    // EXPLICIT_REFUSAL: a calling service of an org is billed to that org or refused, never to the service principal's own account.
    await requireServiceBillable(deps, calling.org, calling.service);
    const account = await deps.getAccount(calling.org.billingAccountId);
    if (!account) throw new OrgAccountError("not_allowed", "not allowed to bill this account");
    return { account, source: "service", chargeScopeUserId: calling.org.orgUserId, orgUserId: calling.org.orgUserId };
  }
  // A person's own payer binding (story.0038). A binding to an ORG account (connected or legacy repo-spec) is never honored and none can be asked for any more: an old row is REFUSED
  // explicitly (turn it Off), never billed and never silently replaced by another payer. An org is billed by members with org:spend or by its enabled service.
  const boundId = await deps.payerFor(subjectUserId);
  if (boundId && boundId !== own.id) {
    if (await deps.isOrgAccount(boundId)) throw new OrgAccountError("not_allowed", "a payer binding to an org account is not honored; turn it Off");
    const bound = await deps.getAccount(boundId);
    if (bound) return { account: bound, source: "binding", chargeScopeUserId: subjectUserId };
  }
  return { account: own, source: "own", chargeScopeUserId: subjectUserId };
}

/** What `resolveFundingAccount` reads. */
export interface FundingDeps {
  /** The person's own billing account id: the host's `ensureBillingAccount` (which creates it) when the node passes one, else the person's existing account (`not_allowed` when there is none). */
  ownAccountId(userId: string): Promise<string>;
  /** The user that owns this billing account, or null when there is no such account. */
  accountOwner(billingAccountId: string): Promise<string | null>;
  orgOfAccount(billingAccountId: string): Promise<BillToOrg | null>;
  roleOf(userId: string, org: BillToOrg): Promise<{ role: OrgRole | null; adminLapsed: boolean }>;
}

/**
 * The account a person may FUND and the user whose scope credits it. Absent account = the person's own. An ORG account only for an org ADMIN by the org's current statement (`org:spend` alone
 * never funds); an account that is not the person's own and not an org's is refused the same way as an unknown one (`not_allowed`, never disclosing which). A non-admin is `not_allowed` before
 * anything about the org (a suspension) is said; an admin of a suspended org gets `org_suspended` with its reason; an unreadable statement is `statement_unavailable` (the person may be an admin).
 * It opens no transaction: the owners are read here, before the caller's own.
 */
export async function resolveFundingAccount(
  deps: FundingDeps,
  input: { userId: string; billingAccountId?: string | undefined }
): Promise<{ billingAccountId: string; chargeScopeUserId: string }> {
  if (!input.billingAccountId) return { billingAccountId: await deps.ownAccountId(input.userId), chargeScopeUserId: input.userId };
  const org = await deps.orgOfAccount(input.billingAccountId);
  if (org) {
    const { role, adminLapsed } = await deps.roleOf(input.userId, org);
    if (role !== "admin") throw adminLapsed ? new OrgAccountError("statement_unavailable", "the org's statement cannot be read") : new OrgAccountError("not_allowed", "not allowed to fund this account");
    if (org.status === "suspended") refuseSuspended(org);
    return { billingAccountId: org.billingAccountId, chargeScopeUserId: org.orgUserId };
  }
  if ((await deps.accountOwner(input.billingAccountId)) === input.userId) return { billingAccountId: input.billingAccountId, chargeScopeUserId: input.userId };
  throw new OrgAccountError("not_allowed", "not allowed to fund this account");
}

const MAX_PAYMENT_REF_CHARS = 200;
const PAYMENT_REF = /^[\x20-\x7e]+$/;

/**
 * Append `org.funded` to the org's history for a payment that credited its account (run it in its own transaction), EXACTLY ONCE per (org, `paymentRef`): a unique partial index makes a repeated
 * payment id write nothing and answer `recorded: false`. Refuses, writing nothing: an amount that is not a positive whole number (`invalid_amount`); a `paymentRef` that is empty after trimming,
 * longer than 200 characters or not ASCII-printable (`invalid_payment_ref`, never truncated); an account that is not an org's, or an actor that is no user (`not_allowed`, the actor read in
 * this same transaction). Returns whether a row was written, with the org's user id.
 */
export async function recordOrgFunded(
  tx: SqlTag,
  input: { orgBillingAccountId: string; actorUserId: string; amountCredits: number; paymentRef: string }
): Promise<{ recorded: boolean; orgUserId: string }> {
  if (!Number.isSafeInteger(input.amountCredits) || input.amountCredits <= 0) throw new OrgAccountError("invalid_amount", "amountCredits must be a positive whole number");
  const paymentRef = typeof input.paymentRef === "string" ? input.paymentRef.trim() : "";
  if (paymentRef.length === 0 || paymentRef.length > MAX_PAYMENT_REF_CHARS || !PAYMENT_REF.test(paymentRef))
    throw new OrgAccountError("invalid_payment_ref", "paymentRef must be 1 to 200 printable ASCII characters");
  const org = await orgByBillingAccount(tx, input.orgBillingAccountId);
  if (!org) throw new OrgAccountError("not_allowed", "not an org account");
  const actor = await tx`SELECT 1 AS present FROM users WHERE id = ${input.actorUserId} LIMIT 1`;
  if (actor.length === 0) throw new OrgAccountError("not_allowed", "no such actor");
  // A bare ON CONFLICT DO NOTHING: the one unique index that can fire is `org_events_funded_payment_unique`.
  const rows = await tx`
    INSERT INTO org_events (org_user_id, act, actor, detail)
    VALUES (${org.orgUserId}, 'org.funded', ${input.actorUserId}, ${JSON.stringify({ amountCredits: input.amountCredits, paymentRef })}::text::jsonb)
    ON CONFLICT DO NOTHING
    RETURNING id`;
  return { recorded: rows.length > 0, orgUserId: org.orgUserId };
}

/**
 * The user whose row-level-security scope reads and charges `billingAccountId` for a run the actor executes: for an org account the org's own user, but only when the actor is entitled
 * to it right now (an org admin or spender, or the org's enabled calling service) and the account is not suspended (`org_suspended`); for a bound account the owner (story.0038); else the
 * actor, so any other account stays invisible.
 */
export async function billToScopeUserFor<A extends { readonly id: string; readonly ownerUserId?: string | undefined }>(
  deps: BillToDeps<A>,
  input: { actorUserId: string; billingAccountId: string }
): Promise<string> {
  const org = await deps.orgOfAccount(input.billingAccountId);
  if (org) {
    if (org.status === "suspended") refuseSuspended(org);
    const { role, adminLapsed } = await deps.roleOf(input.actorUserId, org);
    if (role) return org.orgUserId;
    const calling = await deps.orgOfServicePrincipal(input.actorUserId);
    if (calling && calling.org.orgUserId === org.orgUserId) {
      await requireServiceBillable(deps, org, calling.service);
      return org.orgUserId;
    }
    if (adminLapsed) throw new OrgAccountError("statement_unavailable", "the org's statement cannot be read");
    return input.actorUserId;
  }
  const account = await deps.getAccount(input.billingAccountId);
  if (!account?.ownerUserId || account.ownerUserId === input.actorUserId) return input.actorUserId;
  if ((await deps.payerFor(input.actorUserId)) !== input.billingAccountId) return input.actorUserId;
  // A binding that names an org's account (a legacy repo-spec org) is refused, never opened.
  if (await deps.isOrgAccount(input.billingAccountId)) throw new OrgAccountError("not_allowed", "a payer binding to an org account is not honored; turn it Off");
  return account.ownerUserId;
}

/** The SQL-backed lookups of `BillToDeps` (everything but the node's own account read and the payer binding read). */
export function createPostgresBillToLookups(
  sql: SqlTag,
  owners: OrgOwners | undefined,
  statementServices: ((origin: string) => Promise<readonly string[]>) | undefined
): Pick<BillToDeps<{ id: string }>, "orgOfAccount" | "isOrgAccount" | "orgOfServicePrincipal" | "roleOf" | "serviceEnabled"> {
  return {
    async isOrgAccount(billingAccountId) {
      const rows = await sql`SELECT 1 AS org FROM billing_accounts b JOIN agent_principals ap ON ap.user_id = b.owner_user_id AND ap.kind = 'org' WHERE b.id = ${billingAccountId} LIMIT 1`;
      return rows.length > 0;
    },
    async orgOfAccount(billingAccountId) {
      return orgByBillingAccount(sql, billingAccountId);
    },
    async orgOfServicePrincipal(userId) {
      // One primary-key read of the row written at connect and refresh. A person's id matches none.
      const rows = await sql`
        SELECT a.org_user_id, a.billing_account_id, a.node_id, a.origin, a.dao, a.admins, a.services, a.statement_version, a.statement_commit, a.disconnected_at, a.suspended_at, a.suspend_reason, sp.service
        FROM org_service_principals sp JOIN org_accounts a ON a.org_user_id = sp.org_user_id
        WHERE sp.service_user_id = ${userId} LIMIT 1`;
      const org = toOrg(rows[0]);
      return org && rows[0] ? { org, service: String(rows[0].service) } : null;
    },
    async roleOf(userId, org) {
      return orgRoleOf(sql, owners, { userId, org });
    },
    async serviceEnabled(org, service) {
      if (!statementServices) return org.status === "connected";
      try {
        return (await statementServices(org.origin)).includes(service);
      } catch {
        return false;
      }
    },
  };
}
