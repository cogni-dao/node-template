// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/org-accounts`
 * Purpose: An org account made by a person and run by its people (task.0181): create, invite, accept, change a role, remove, list, suspend. The org is an ordinary account
 *   (a `users` row, an `org` principal with owner source `grants`, one `billing_accounts` row); a person's role is one `agent_roles` row (`resource = 'account'`, scope
 *   `org:owner` or `org:admin`). The decisions are pure functions over `OrgAccountStore`; `createPostgresOrgAccountStore` is its Postgres adapter.
 * Scope: Decisions and one adapter over an injected service-role tag. No routes, no logging, no money: the node wraps each call in ONE transaction and logs the outcome.
 * Invariants:
 *   - ORG_IS_AN_ACCOUNT: no members table. A role is a grant row; `holdsAccountRight` (`./rights`) is the one check, and `roleOf` reads the same rows.
 *   - ANYONE_CREATES: `createOrg` needs only a signed-in identity and writes the creator's `org:owner`, approved by the org's own `users` id. It grants nothing outside the org.
 *   - BOUNDED_CREATION: one person owns at most `MAX_OWNED_ORGS` (5) orgs on a node, counted under a per-person lock, because each org mints a billing account.
 *   - INVITE_GRANTS_NOTHING: an invite names a wallet and a role and lives 7 days, single use. The grant row is written only when the person signed in with that wallet accepts, and
 *     only if the inviter still holds the right to invite that role.
 *   - ONLY_AN_OWNER_MAKES_AN_OWNER: an admin invites and removes admins; making, demoting or removing an owner (or inviting one) needs an owner.
 *   - ONE_OWNER_MINIMUM: a role change or removal first locks the org's live owner grants (`FOR UPDATE`), so the last owner can never be removed or demoted, even by two owners at once.
 *   - NO_SELF_APPROVAL: a grant row never names its own principal as approver; a person changing their own role is approved by the org's `users` id.
 *   - NON_DISCLOSING: a caller with no role on an org gets `not_found`, never `not_allowed`.
 * Side-effects: IO (SQL, through the adapter)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import type { SqlTag } from "./postgres";
import { ORG_ADMIN, ORG_OWNER, type OrgRole, roleOfScope, scopeOfRole } from "./rights";

/** One person owns at most this many orgs on a node. */
export const MAX_OWNED_ORGS = 5;
/** An invite lives this many days. */
export const INVITE_TTL_DAYS = 7;
/** Unexpired open invites one org holds at most. */
export const MAX_OPEN_INVITES = 50;
/** The most rows a list returns. */
export const MAX_ORG_ROWS = 200;

export type OrgErrorCode =
  | "not_found"
  | "not_allowed"
  | "last_owner"
  | "too_many_orgs"
  | "too_many_invites"
  | "already_member"
  | "invalid_name"
  | "invalid_wallet"
  | "invalid_role"
  | "invite_not_found"
  | "invite_void";

/** A domain refusal. The node maps the code to a status; a store failure is a plain `Error`, never this. */
export class OrgError extends Error {
  readonly code: OrgErrorCode;
  constructor(code: OrgErrorCode, message?: string) {
    super(message ?? code);
    this.name = "OrgError";
    this.code = code;
  }
}

export interface OrgRecord {
  readonly orgUserId: string;
  readonly name: string;
  readonly billingAccountId: string;
  /** ISO time the node's admin suspended the org, else null. */
  readonly suspendedAt: string | null;
}

export interface OrgMembership extends OrgRecord {
  readonly role: OrgRole;
}

export interface OrgMember {
  readonly userId: string;
  readonly name: string | null;
  readonly role: OrgRole;
  readonly since: string;
}

export interface OrgInviteView {
  readonly id: string;
  readonly orgUserId: string;
  readonly orgName: string;
  readonly role: OrgRole;
  readonly invitedBy: string;
  readonly expiresAt: string;
}

/** An invite as the store finds it for one person (the wallet matched one of theirs). */
export interface OpenInvite extends OrgInviteView {}

/** Persistence port. Every method runs inside the caller's one transaction on a service-role connection. */
export interface OrgAccountStore {
  /** Writes the org's rows and the creator's `org:owner`. `too_many_orgs` when the creator already owns `maxOwned`; the count and the insert run under one per-person lock. */
  createOrg(input: { creatorUserId: string; name: string; maxOwned: number }): Promise<{ orgUserId: string; billingAccountId: string } | "too_many_orgs">;
  getOrg(orgUserId: string): Promise<OrgRecord | null>;
  /** The orgs this person holds a live role on, with the highest role, newest first, bounded. */
  listOrgsOf(userId: string, limit: number): Promise<OrgMembership[]>;
  /** The highest live role this person holds on the org, or null. */
  roleOf(userId: string, orgUserId: string): Promise<OrgRole | null>;
  members(orgUserId: string, limit: number): Promise<OrgMember[]>;
  /** Locks the org's live `org:owner` rows (`FOR UPDATE`, by id) and returns their holders. Held until the transaction ends. */
  lockOwners(orgUserId: string): Promise<string[]>;
  /** Locks per person (a transaction advisory lock) and returns how many orgs they own. */
  lockAndCountOwned(userId: string): Promise<number>;
  /** Ends every live org role row of this person on the org and writes one live row for `role`, approved by `approvedBy`. */
  setRole(input: { orgUserId: string; userId: string; role: OrgRole; approvedBy: string }): Promise<void>;
  /** Ends the person's live org role rows. False when there was none. */
  removeRole(input: { orgUserId: string; userId: string }): Promise<boolean>;
  /** The user ids that bound this lowercase wallet. */
  usersOfWallet(wallet: string): Promise<string[]>;
  /** An open invite for (org, wallet) is renewed (new role, inviter and 7 days); otherwise one is written. `too_many_invites` at the org's cap. */
  upsertInvite(input: { orgUserId: string; wallet: string; role: OrgRole; invitedBy: string; ttlDays: number; maxOpen: number }): Promise<{ id: string; expiresAt: string } | "too_many_invites">;
  /** Unexpired open invites whose wallet is one of this person's bound wallets (or only `inviteId`). */
  invitesFor(userId: string, inviteId: string | null, limit: number): Promise<OpenInvite[]>;
  /** Marks the invite accepted by this person if it is still open and unexpired. False when it is not. */
  consumeInvite(input: { inviteId: string; userId: string }): Promise<boolean>;
  setSuspended(orgUserId: string, suspended: boolean): Promise<boolean>;
}

const EVM_WALLET = /^0x[0-9a-fA-F]{40}$/;

/** The org name a person may give: 1 to 64 printable characters once trimmed and single-spaced. Null when it is not usable. */
export function cleanOrgName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const clean = name.normalize("NFKC").replace(/\s+/g, " ").trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control and format characters is the point
  if (clean.length < 1 || clean.length > 64 || /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/.test(clean)) return null;
  return clean;
}

/** An EVM wallet address lowercased, or null. */
export const cleanWallet = (wallet: unknown): string | null => (typeof wallet === "string" && EVM_WALLET.test(wallet.trim()) ? wallet.trim().toLowerCase() : null);

/**
 * The caller's role on an org, or a refusal: `not_found` for a caller with no role (non-disclosing), `not_allowed` for a role below `min`. An admin satisfies `admin`; only an owner
 * satisfies `owner`.
 */
export async function requireRole(store: OrgAccountStore, userId: string, orgUserId: string, min: OrgRole): Promise<OrgRole> {
  const role = await store.roleOf(userId, orgUserId);
  if (!role) throw new OrgError("not_found");
  if (min === "owner" && role !== "owner") throw new OrgError("not_allowed");
  return role;
}

/** Create an org for a signed-in person; they become its owner. Throws `invalid_name`, `too_many_orgs`. */
export async function createOrg(store: OrgAccountStore, input: { creatorUserId: string; name: unknown }): Promise<{ orgUserId: string; billingAccountId: string; name: string }> {
  const name = cleanOrgName(input.name);
  if (!name) throw new OrgError("invalid_name");
  const created = await store.createOrg({ creatorUserId: input.creatorUserId, name, maxOwned: MAX_OWNED_ORGS });
  if (created === "too_many_orgs") throw new OrgError("too_many_orgs");
  return { ...created, name };
}

/** The orgs this person is in, with their role. */
export function listOrgs(store: OrgAccountStore, userId: string): Promise<OrgMembership[]> {
  return store.listOrgsOf(userId, MAX_ORG_ROWS);
}

/** An org's page for its owners and admins: the record, the caller's role and its people. `not_found` for anyone else. */
export async function getOrgView(
  store: OrgAccountStore,
  input: { actorUserId: string; orgUserId: string }
): Promise<{ org: OrgRecord; role: OrgRole; members: OrgMember[] }> {
  const role = await requireRole(store, input.actorUserId, input.orgUserId, "admin");
  const org = await store.getOrg(input.orgUserId);
  if (!org) throw new OrgError("not_found");
  return { org, role, members: await store.members(input.orgUserId, MAX_ORG_ROWS) };
}

/**
 * An owner or admin invites a wallet to a role. Only an owner invites an owner. The invite grants nothing; it expires in 7 days and is single use. A wallet whose person already holds
 * a role is `already_member`. Throws `invalid_wallet`, `invalid_role`, `not_found`, `not_allowed`, `already_member`, `too_many_invites`.
 */
export async function inviteMember(
  store: OrgAccountStore,
  input: { actorUserId: string; orgUserId: string; wallet: unknown; role: unknown }
): Promise<{ id: string; expiresAt: string; wallet: string; role: OrgRole }> {
  if (input.role !== "owner" && input.role !== "admin") throw new OrgError("invalid_role");
  const wallet = cleanWallet(input.wallet);
  if (!wallet) throw new OrgError("invalid_wallet");
  const actorRole = await requireRole(store, input.actorUserId, input.orgUserId, "admin");
  if (input.role === "owner" && actorRole !== "owner") throw new OrgError("not_allowed");
  for (const userId of await store.usersOfWallet(wallet)) if (await store.roleOf(userId, input.orgUserId)) throw new OrgError("already_member");
  const invite = await store.upsertInvite({
    orgUserId: input.orgUserId,
    wallet,
    role: input.role,
    invitedBy: input.actorUserId,
    ttlDays: INVITE_TTL_DAYS,
    maxOpen: MAX_OPEN_INVITES,
  });
  if (invite === "too_many_invites") throw new OrgError("too_many_invites");
  return { ...invite, wallet, role: input.role };
}

/** The open invites for the wallets this person has signed in with. */
export function listMyInvites(store: OrgAccountStore, userId: string): Promise<OpenInvite[]> {
  return store.invitesFor(userId, null, MAX_ORG_ROWS);
}

/**
 * The invited person accepts, signed in with the invited wallet. Only now is the grant written, and only if the inviter still holds the right to invite that role (otherwise
 * `invite_void`). An owner invite also counts toward the 5-org cap. Throws `invite_not_found` (unknown, used, expired or another wallet's), `already_member`, `invite_void`,
 * `too_many_orgs`.
 */
export async function acceptInvite(
  store: OrgAccountStore,
  input: { userId: string; inviteId: string }
): Promise<{ orgUserId: string; role: OrgRole }> {
  const [invite] = await store.invitesFor(input.userId, input.inviteId, 1);
  if (!invite) throw new OrgError("invite_not_found");
  if (await store.roleOf(input.userId, invite.orgUserId)) throw new OrgError("already_member");
  const inviterRole = await store.roleOf(invite.invitedBy, invite.orgUserId);
  if (!inviterRole || (invite.role === "owner" && inviterRole !== "owner")) throw new OrgError("invite_void");
  if (invite.role === "owner" && (await store.lockAndCountOwned(input.userId)) >= MAX_OWNED_ORGS) throw new OrgError("too_many_orgs");
  if (!(await store.consumeInvite({ inviteId: invite.id, userId: input.userId }))) throw new OrgError("invite_not_found");
  await store.setRole({ orgUserId: invite.orgUserId, userId: input.userId, role: invite.role, approvedBy: invite.invitedBy });
  return { orgUserId: invite.orgUserId, role: invite.role };
}

/** A grant row never names its principal as approver: a person changing their own role is approved by the org's own `users` id. */
const approverFor = (actorUserId: string, targetUserId: string, orgUserId: string): string => (actorUserId === targetUserId ? orgUserId : actorUserId);

/**
 * An owner or admin changes a person's role. Only an owner makes or demotes an owner, and the last owner can never be demoted (ONE_OWNER_MINIMUM: the owner grants are locked first).
 * Returns the change, or `unchanged` for the same role. Throws `invalid_role`, `not_found` (no role, or no such member), `not_allowed`, `last_owner`, `too_many_orgs`.
 */
export async function changeRole(
  store: OrgAccountStore,
  input: { actorUserId: string; orgUserId: string; targetUserId: string; role: unknown }
): Promise<{ changed: boolean; from: OrgRole; to: OrgRole }> {
  if (input.role !== "owner" && input.role !== "admin") throw new OrgError("invalid_role");
  const to: OrgRole = input.role;
  const owners = await store.lockOwners(input.orgUserId);
  const actorRole = await requireRole(store, input.actorUserId, input.orgUserId, "admin");
  const from = await store.roleOf(input.targetUserId, input.orgUserId);
  if (!from) throw new OrgError("not_found");
  if (from === to) return { changed: false, from, to };
  if ((from === "owner" || to === "owner") && actorRole !== "owner") throw new OrgError("not_allowed");
  if (from === "owner" && owners.length <= 1) throw new OrgError("last_owner");
  if (to === "owner" && (await store.lockAndCountOwned(input.targetUserId)) >= MAX_OWNED_ORGS) throw new OrgError("too_many_orgs");
  await store.setRole({ orgUserId: input.orgUserId, userId: input.targetUserId, role: to, approvedBy: approverFor(input.actorUserId, input.targetUserId, input.orgUserId) });
  return { changed: true, from, to };
}

/**
 * An owner or admin removes a person (a person may remove themselves). Only an owner removes an owner, and the last owner can never be removed. Throws `not_found`,
 * `not_allowed`, `last_owner`.
 */
export async function removeMember(
  store: OrgAccountStore,
  input: { actorUserId: string; orgUserId: string; targetUserId: string }
): Promise<{ removed: boolean; role: OrgRole }> {
  const owners = await store.lockOwners(input.orgUserId);
  const actorRole = await requireRole(store, input.actorUserId, input.orgUserId, "admin");
  const role = await store.roleOf(input.targetUserId, input.orgUserId);
  if (!role) throw new OrgError("not_found");
  if (role === "owner" && actorRole !== "owner") throw new OrgError("not_allowed");
  if (role === "owner" && owners.length <= 1) throw new OrgError("last_owner");
  return { removed: await store.removeRole({ orgUserId: input.orgUserId, userId: input.targetUserId }), role };
}

/** The node admin suspends or resumes an org. The caller proved node-admin first (the one admin check). False when the user is not an org. */
export const setOrgSuspended = (store: OrgAccountStore, orgUserId: string, suspended: boolean): Promise<boolean> => store.setSuspended(orgUserId, suspended);

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Postgres adapter
// ---------------------------------------------------------------------------------------------------------------------------------------------------

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const iso = (value: unknown): string => {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : "";
};

/**
 * The Postgres adapter over an injected service-role tag, inside the caller's transaction. A live org role row is approved, unrevoked, `resource = 'account'`, scope `org:owner` or
 * `org:admin`; `agent_roles` has no policy for an org member under row-level security, so the connection must be a BYPASSRLS service role.
 */
export function createPostgresOrgAccountStore(sql: SqlTag): OrgAccountStore {
  const toOrg = (row: Record<string, unknown>): OrgRecord | null => {
    const orgUserId = str(row.org_user_id);
    const billingAccountId = str(row.billing_account_id);
    if (!orgUserId || !billingAccountId) return null;
    return { orgUserId, name: str(row.name) ?? "", billingAccountId, suspendedAt: row.suspended_at ? iso(row.suspended_at) : null };
  };
  const roleFrom = (scopes: ReadonlyArray<Record<string, unknown>>): OrgRole | null => {
    const set = new Set(scopes.map((r) => str(r.scope)));
    return set.has(ORG_OWNER) ? "owner" : set.has(ORG_ADMIN) ? "admin" : null;
  };
  const ownedCount = async (userId: string): Promise<number> => {
    const rows = await sql`
      SELECT count(DISTINCT b.id)::int AS n
      FROM agent_roles r
      JOIN billing_accounts b ON b.id = r.account_id
      JOIN agent_principals p ON p.user_id = b.owner_user_id AND p.kind = 'org'
      WHERE r.principal_user_id = ${userId} AND r.resource = 'account' AND r.scope = ${ORG_OWNER}
        AND r.approved_by IS NOT NULL AND r.revoked_at IS NULL`;
    return Number(rows[0]?.n ?? 0);
  };
  return {
    async createOrg({ creatorUserId, name, maxOwned }) {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`org_person:${creatorUserId}`}))`;
      if ((await ownedCount(creatorUserId)) >= maxOwned) return "too_many_orgs";
      const orgUserId = crypto.randomUUID();
      const billingAccountId = crypto.randomUUID();
      await sql`INSERT INTO users (id, name) VALUES (${orgUserId}, ${name})`;
      await sql`
        INSERT INTO agent_principals (kind, user_id, owner_source_kind, owner_source_ref)
        VALUES ('org', ${orgUserId}, 'grants', ${orgUserId})`;
      await sql`INSERT INTO billing_accounts (id, owner_user_id, balance_credits) VALUES (${billingAccountId}, ${orgUserId}, 0)`;
      await sql`INSERT INTO virtual_keys (billing_account_id, label, is_default, active) VALUES (${billingAccountId}, 'Default', true, true)`;
      // The creator's first owner grant is approved by the org's own users id: nobody outside the org decided it.
      await sql`
        INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, resource, account_id)
        VALUES (${creatorUserId}, ${ORG_OWNER}, ${orgUserId}, now(), 'account', ${billingAccountId})`;
      return { orgUserId, billingAccountId };
    },
    async getOrg(orgUserId) {
      const rows = await sql`
        SELECT p.user_id AS org_user_id, u.name, b.id AS billing_account_id, p.suspended_at
        FROM agent_principals p
        JOIN users u ON u.id = p.user_id
        JOIN billing_accounts b ON b.owner_user_id = p.user_id
        WHERE p.user_id = ${orgUserId} AND p.kind = 'org' LIMIT 1`;
      return rows[0] ? toOrg(rows[0]) : null;
    },
    async listOrgsOf(userId, limit) {
      const rows = await sql`
        SELECT p.user_id AS org_user_id, u.name, b.id AS billing_account_id, p.suspended_at,
               bool_or(r.scope = ${ORG_OWNER}) AS is_owner, max(r.created_at) AS since
        FROM agent_roles r
        JOIN billing_accounts b ON b.id = r.account_id
        JOIN agent_principals p ON p.user_id = b.owner_user_id AND p.kind = 'org'
        JOIN users u ON u.id = p.user_id
        WHERE r.principal_user_id = ${userId} AND r.resource = 'account' AND r.scope IN (${ORG_OWNER}, ${ORG_ADMIN})
          AND r.approved_by IS NOT NULL AND r.revoked_at IS NULL
        GROUP BY p.user_id, u.name, b.id, p.suspended_at
        ORDER BY max(r.created_at) DESC
        LIMIT ${limit}`;
      return rows.flatMap((row) => {
        const org = toOrg(row);
        return org ? [{ ...org, role: (row.is_owner === true ? "owner" : "admin") as OrgRole }] : [];
      });
    },
    async roleOf(userId, orgUserId) {
      const rows = await sql`
        SELECT r.scope FROM agent_roles r
        JOIN billing_accounts b ON b.id = r.account_id
        WHERE b.owner_user_id = ${orgUserId} AND r.principal_user_id = ${userId} AND r.resource = 'account'
          AND r.scope IN (${ORG_OWNER}, ${ORG_ADMIN}) AND r.approved_by IS NOT NULL AND r.revoked_at IS NULL`;
      return roleFrom(rows);
    },
    async members(orgUserId, limit) {
      const rows = await sql`
        SELECT r.principal_user_id, u.name, r.scope, r.created_at
        FROM agent_roles r
        JOIN billing_accounts b ON b.id = r.account_id
        JOIN users u ON u.id = r.principal_user_id
        WHERE b.owner_user_id = ${orgUserId} AND r.resource = 'account' AND r.scope IN (${ORG_OWNER}, ${ORG_ADMIN})
          AND r.approved_by IS NOT NULL AND r.revoked_at IS NULL
        ORDER BY (r.scope = ${ORG_OWNER}) DESC, r.created_at
        LIMIT ${limit}`;
      return rows.flatMap((row) => {
        const userId = str(row.principal_user_id);
        const role = roleOfScope(str(row.scope) ?? "");
        return userId && role ? [{ userId, name: str(row.name), role, since: iso(row.created_at) }] : [];
      });
    },
    async lockOwners(orgUserId) {
      const rows = await sql`
        SELECT r.principal_user_id FROM agent_roles r
        JOIN billing_accounts b ON b.id = r.account_id
        WHERE b.owner_user_id = ${orgUserId} AND r.resource = 'account' AND r.scope = ${ORG_OWNER}
          AND r.approved_by IS NOT NULL AND r.revoked_at IS NULL
        ORDER BY r.id
        FOR UPDATE OF r`;
      return rows.flatMap((row) => {
        const id = str(row.principal_user_id);
        return id ? [id] : [];
      });
    },
    async lockAndCountOwned(userId) {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`org_person:${userId}`}))`;
      return ownedCount(userId);
    },
    async setRole({ orgUserId, userId, role, approvedBy }) {
      await sql`
        UPDATE agent_roles r SET revoked_at = now()
        FROM billing_accounts b
        WHERE b.id = r.account_id AND b.owner_user_id = ${orgUserId} AND r.principal_user_id = ${userId}
          AND r.resource = 'account' AND r.scope IN (${ORG_OWNER}, ${ORG_ADMIN}) AND r.revoked_at IS NULL`;
      await sql`
        INSERT INTO agent_roles (principal_user_id, scope, approved_by, granted_at, resource, account_id)
        SELECT ${userId}, ${scopeOfRole(role)}, ${approvedBy}, now(), 'account', b.id
        FROM billing_accounts b WHERE b.owner_user_id = ${orgUserId}`;
    },
    async removeRole({ orgUserId, userId }) {
      const rows = await sql`
        UPDATE agent_roles r SET revoked_at = now()
        FROM billing_accounts b
        WHERE b.id = r.account_id AND b.owner_user_id = ${orgUserId} AND r.principal_user_id = ${userId}
          AND r.resource = 'account' AND r.scope IN (${ORG_OWNER}, ${ORG_ADMIN}) AND r.revoked_at IS NULL
        RETURNING r.id`;
      return rows.length > 0;
    },
    async usersOfWallet(wallet) {
      const rows = await sql`SELECT DISTINCT user_id FROM user_bindings WHERE provider = 'wallet' AND lower(external_id) = ${wallet} LIMIT 20`;
      return rows.flatMap((row) => {
        const id = str(row.user_id);
        return id ? [id] : [];
      });
    },
    async upsertInvite({ orgUserId, wallet, role, invitedBy, ttlDays, maxOpen }) {
      const open = await sql`
        SELECT count(*)::int AS n FROM org_invites
        WHERE org_user_id = ${orgUserId} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`;
      const renewing = await sql`
        SELECT 1 AS ok FROM org_invites
        WHERE org_user_id = ${orgUserId} AND wallet = ${wallet} AND accepted_at IS NULL AND revoked_at IS NULL LIMIT 1`;
      if (renewing.length === 0 && Number(open[0]?.n ?? 0) >= maxOpen) return "too_many_invites";
      const rows = await sql`
        INSERT INTO org_invites (org_user_id, wallet, scope, invited_by, expires_at)
        VALUES (${orgUserId}, ${wallet}, ${scopeOfRole(role)}, ${invitedBy}, now() + make_interval(days => ${ttlDays}::int))
        ON CONFLICT (org_user_id, wallet) WHERE accepted_at IS NULL AND revoked_at IS NULL
        DO UPDATE SET scope = EXCLUDED.scope, invited_by = EXCLUDED.invited_by, created_at = now(), expires_at = EXCLUDED.expires_at
        RETURNING id, expires_at`;
      const id = str(rows[0]?.id);
      if (!id) throw new Error("invite_not_written");
      return { id, expiresAt: iso(rows[0]?.expires_at) };
    },
    async invitesFor(userId, inviteId, limit) {
      const rows = await sql`
        SELECT i.id, i.org_user_id, o.name AS org_name, i.scope, i.invited_by, i.expires_at
        FROM org_invites i
        JOIN users o ON o.id = i.org_user_id
        WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
          AND (${inviteId}::text IS NULL OR i.id::text = ${inviteId})
          AND EXISTS (SELECT 1 FROM user_bindings b WHERE b.user_id = ${userId} AND b.provider = 'wallet' AND lower(b.external_id) = i.wallet)
        ORDER BY i.created_at DESC
        LIMIT ${limit}`;
      return rows.flatMap((row) => {
        const id = str(row.id);
        const orgUserId = str(row.org_user_id);
        const invitedBy = str(row.invited_by);
        const role = roleOfScope(str(row.scope) ?? "");
        return id && orgUserId && invitedBy && role ? [{ id, orgUserId, orgName: str(row.org_name) ?? "", role, invitedBy, expiresAt: iso(row.expires_at) }] : [];
      });
    },
    async consumeInvite({ inviteId, userId }) {
      const rows = await sql`
        UPDATE org_invites SET accepted_at = now(), accepted_by = ${userId}
        WHERE id::text = ${inviteId} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
        RETURNING id`;
      return rows.length > 0;
    },
    async setSuspended(orgUserId, suspended) {
      const rows = suspended
        ? await sql`UPDATE agent_principals SET suspended_at = COALESCE(suspended_at, now()) WHERE user_id = ${orgUserId} AND kind = 'org' RETURNING user_id`
        : await sql`UPDATE agent_principals SET suspended_at = NULL WHERE user_id = ${orgUserId} AND kind = 'org' RETURNING user_id`;
      return rows.length > 0;
    },
  };
}
