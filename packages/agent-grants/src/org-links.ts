// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/org-links`
 * Purpose: Link another node to an org account (task.0181). An org owner here makes a one-time code for the other node's https origin; the other node's admin makes that node sign
 *   `act: "link"` with the code as its service `node-connect`; this node verifies the signature against the origin's published keys, burns the code, records ONE open link per
 *   issuer and writes one approved `payer_bindings` row per (issuer, service) principal. Either side unlinks: the owner here, or the other node by signing `act: "unlink"`.
 * Scope: Decisions over `OrgLinkStore` plus its Postgres adapter and the signing helper. The caller owns the transaction (`inTransaction`), the verifier's replay store and fetch, and
 *   logging. No routes, no money: a link names a payer and nothing else (BILLING_CHARGES lives elsewhere).
 * Invariants:
 *   - LINK_NEEDS_BOTH_SIDES: a link needs an owner's code here and the other node's signature. Only that node's admin can make it sign; this node never acts on an unsigned claim about it.
 *   - CODE_IS_HASHED_AND_SINGLE_USE: 43 base64url characters of CSPRNG, stored as sha256, valid 15 minutes, bound to one org and one origin, burned in the same transaction that writes the link.
 *   - KEYS_ONLY_FROM_THE_BOUND_ORIGIN: a link is verified against `<origin>/.well-known/jwks.json` of the origin the code names (the assertion's `iss` must equal it), fetched through the
 *     injected `fetchJwks` (`createPinnedJwksFetch`: https, no redirect, 5 s, 64 KB, private ranges refused, address pinned).
 *   - ONE_OPEN_LINK_PER_ISSUER: a second link for an issuer is `issuer_already_linked`. A closed link is kept.
 *   - ONE_PAYER_PATH: a link writes bindings (approved by the org's own `users` id, so it never depends on which owner made the code); an unlink closes them. A service principal that
 *     appears after the link is bound when it is created (`bindLinkedService`).
 *   - NO_TOKEN_IN_ERRORS: a refusal is a short code; nothing carries the assertion or the code.
 * Side-effects: IO (SQL; the injected key fetch)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { hashLinkToken, isLinkTokenShape, newLinkToken } from "./approval";
import { type OrgAccountStore, requireRole } from "./org-accounts";
import type { SqlTag } from "./postgres";
import {
  isCanonicalHttpsOrigin,
  NODE_CONNECT_SERVICE,
  peekUnverifiedClaims,
  type ReplayStore,
  SERVICE_SLUG,
  type ServiceAssertionSigner,
  createServiceAssertionVerifier,
  servicePrincipalId,
} from "./service-auth";

/** A link code lives 15 minutes. */
export const LINK_CODE_TTL_MINUTES = 15;
/** Unconsumed, unexpired codes one org holds at most. */
export const MAX_OPEN_LINK_CODES = 10;
/** Services one link may name. */
export const MAX_LINK_SERVICES = 8;
/** The scope a link assertion carries. */
export const LINK_SCOPE = "org:link";
/** The route path on the org's node that takes a signed link or unlink (a public route: the signature is the credential). */
export const LINK_PATH = "/api/v1/orgs/link";

/** The keys of a node, always at this path of its https origin. */
export const jwksUriOfOrigin = (origin: string): string => `${origin}/.well-known/jwks.json`;

export interface OpenLink {
  readonly id: string;
  readonly orgUserId: string;
  readonly issuer: string;
  readonly services: readonly string[];
  readonly createdAt: string;
}

/** Persistence port. Every method runs on a service-role connection; the decisions that write run inside `inTransaction`. */
export interface OrgLinkStore {
  openLinkOfIssuer(issuer: string): Promise<OpenLink | null>;
  openLinksOfOrg(orgUserId: string, limit: number): Promise<OpenLink[]>;
  createCode(input: { orgUserId: string; origin: string; codeHash: string; createdBy: string; ttlMinutes: number; maxOpen: number }): Promise<{ expiresAt: string } | "too_many_codes">;
  /** The org and origin of a code that is unconsumed and unexpired, else null. */
  findCode(codeHash: string): Promise<{ orgUserId: string; origin: string } | null>;
  /** Burns the code (unconsumed and unexpired only) and returns its org, else null. */
  consumeCode(codeHash: string): Promise<string | null>;
  /** Writes the open link; null when the issuer already has one. */
  insertLink(input: { orgUserId: string; issuer: string; services: readonly string[] }): Promise<string | null>;
  /** Closes the open link and returns it, else null. */
  closeLink(input: { linkId: string; closedBy: string }): Promise<OpenLink | null>;
  /** Writes one approved binding per EXISTING external principal in `principalIds` (replacing any open binding of it), approved by the org's `users` id. Returns how many. */
  bindPrincipals(input: { linkId: string; orgUserId: string; principalIds: readonly string[] }): Promise<number>;
  /** Ends the link's open bindings. Returns how many. */
  closeBindings(input: { linkId: string; orgUserId: string }): Promise<number>;
  /** True when the org is suspended, false when not, null when the user is not an org. */
  orgSuspended(orgUserId: string): Promise<boolean | null>;
}

export type LinkRefusal =
  | "malformed"
  | "invalid_assertion"
  | "jwks_unavailable"
  | "link_code_invalid"
  | "issuer_already_linked"
  | "no_open_link"
  | "org_suspended";

export type LinkResult =
  | { readonly ok: true; readonly act: "link"; readonly orgUserId: string; readonly issuer: string; readonly services: readonly string[]; readonly linkId: string; readonly bound: number }
  | { readonly ok: true; readonly act: "unlink"; readonly orgUserId: string; readonly issuer: string; readonly services: readonly string[]; readonly linkId: string; readonly closedBindings: number }
  | { readonly ok: false; readonly code: LinkRefusal; readonly verifier?: string | undefined };

/** The services a link names: a space-separated list of service slugs, at most `MAX_LINK_SERVICES`, never `node-connect`. Null when it is not usable. */
export function parseServicesClaim(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  const list = [...new Set(value.split(" ").filter((s) => s.length > 0))];
  if (list.length === 0 || list.length > MAX_LINK_SERVICES) return null;
  return list.every((s) => SERVICE_SLUG.test(s) && s !== NODE_CONNECT_SERVICE) ? list : null;
}

/** The signed claims of a link or unlink, ready for `ServiceAssertionSigner.sign` as `{ service: "node-connect", scope: LINK_SCOPE, claims }`. */
export function linkClaims(input: { act: "link" | "unlink"; orgUserId: string; code?: string; services?: readonly string[] }): Record<string, string> {
  return {
    act: input.act,
    org: input.orgUserId,
    ...(input.code ? { code: input.code } : {}),
    ...(input.services && input.services.length > 0 ? { services: input.services.join(" ") } : {}),
  };
}

/** Signs a link or unlink as this node's `node-connect` service for the audience `audienceNodeId` (the other node's id). */
export function signLinkAssertion(
  signer: ServiceAssertionSigner,
  input: { audienceNodeId: string; act: "link" | "unlink"; orgUserId: string; code?: string; services?: readonly string[] }
): Promise<string> {
  return signer.sign({ service: NODE_CONNECT_SERVICE, audienceNodeId: input.audienceNodeId, scope: LINK_SCOPE, claims: linkClaims(input) });
}

/**
 * An org owner makes a one-time code for another node's https origin. Only an owner links or unlinks; an admin gets `not_allowed`, anyone else `not_found`. A suspended org links
 * nothing (`org_suspended`), an origin that is not a canonical https origin is `invalid_origin`, and an origin that already has an open link is `issuer_already_linked`.
 * Returns the code ONCE (only its hash is kept).
 */
export async function createLinkCode(
  deps: { orgs: OrgAccountStore; links: OrgLinkStore },
  input: { actorUserId: string; orgUserId: string; origin: string }
): Promise<{ code: string; expiresAt: string; origin: string }> {
  await requireRole(deps.orgs, input.actorUserId, input.orgUserId, "owner");
  if (!isCanonicalHttpsOrigin(input.origin)) throw new LinkError("invalid_origin");
  if ((await deps.links.orgSuspended(input.orgUserId)) !== false) throw new LinkError("org_suspended");
  if (await deps.links.openLinkOfIssuer(input.origin)) throw new LinkError("issuer_already_linked");
  const code = newLinkToken();
  const made = await deps.links.createCode({
    orgUserId: input.orgUserId,
    origin: input.origin,
    codeHash: await hashLinkToken(code),
    createdBy: input.actorUserId,
    ttlMinutes: LINK_CODE_TTL_MINUTES,
    maxOpen: MAX_OPEN_LINK_CODES,
  });
  if (made === "too_many_codes") throw new LinkError("too_many_codes");
  return { code, expiresAt: made.expiresAt, origin: input.origin };
}

/** A refusal of an owner-side link action. */
export class LinkError extends Error {
  readonly code: "invalid_origin" | "org_suspended" | "issuer_already_linked" | "too_many_codes" | "link_not_found";
  constructor(code: LinkError["code"]) {
    super(code);
    this.name = "LinkError";
    this.code = code;
  }
}

/** An org owner unlinks: the link closes and its bindings end, so the next run is refused with `org_link_closed`. `not_found` for a stranger, `not_allowed` for an admin. */
export async function closeLinkByOwner(
  deps: { orgs: OrgAccountStore; inTransaction: <T>(fn: (links: OrgLinkStore) => Promise<T>) => Promise<T> },
  input: { actorUserId: string; orgUserId: string; linkId: string }
): Promise<{ linkId: string; issuer: string; services: readonly string[]; closedBindings: number }> {
  await requireRole(deps.orgs, input.actorUserId, input.orgUserId, "owner");
  return deps.inTransaction(async (links) => {
    const open = (await links.openLinksOfOrg(input.orgUserId, 50)).find((l) => l.id === input.linkId);
    const closed = open ? await links.closeLink({ linkId: open.id, closedBy: input.actorUserId }) : null;
    if (!closed) throw new LinkError("link_not_found");
    const closedBindings = await links.closeBindings({ linkId: closed.id, orgUserId: closed.orgUserId });
    return { linkId: closed.id, issuer: closed.issuer, services: closed.services, closedBindings };
  });
}

/** The home this node trusts for an issuer that has an open link, for `createServiceAssertionVerifier({ resolveHome })`: the origin's own keys, the link's services. */
export async function linkedHome(links: OrgLinkStore, issuer: string): Promise<{ issuer: string; jwksUri: string; services: readonly string[] } | null> {
  if (!isCanonicalHttpsOrigin(issuer)) return null;
  const link = await links.openLinkOfIssuer(issuer);
  return link ? { issuer: link.issuer, jwksUri: jwksUriOfOrigin(link.issuer), services: link.services } : null;
}

/**
 * Binds a service principal that appears AFTER its issuer's link (or any time) to the link's org: one approved binding. False when the issuer has no open link or the link does not
 * name the service. Run it in the transaction that creates the principal (`requestServiceAccess`'s `onPrincipal`).
 */
export async function bindLinkedService(links: OrgLinkStore, input: { issuer: string; service: string; subjectUserId: string }): Promise<boolean> {
  const link = await links.openLinkOfIssuer(input.issuer);
  if (!link || !link.services.includes(input.service)) return false;
  return (await links.bindPrincipals({ linkId: link.id, orgUserId: link.orgUserId, principalIds: [input.subjectUserId] })) > 0;
}

class Refusal extends Error {
  constructor(readonly code: LinkRefusal) {
    super(code);
  }
}

export interface ApplyLinkDeps {
  /** A read-only view (no transaction), for the checks that come before the network. */
  readonly links: OrgLinkStore;
  /** Runs `fn` in ONE transaction on a service-role connection. A throw rolls everything back. */
  readonly inTransaction: <T>(fn: (links: OrgLinkStore) => Promise<T>) => Promise<T>;
  /** This node's id: the audience every assertion must name. */
  readonly selfNodeId: string;
  readonly replay: ReplayStore;
  readonly fetchJwks: (jwksUri: string) => Promise<unknown>;
  readonly now?: () => number;
}

/**
 * Applies a signed link or unlink that arrived as a bearer assertion from another node's `node-connect` service.
 *   link: the claims name a code; the code names the org and the origin; the assertion's `iss` must be that origin and verify against its keys; then, in ONE transaction, the code
 *     is burned, the link recorded (one open per issuer) and each existing service principal bound.
 *   unlink: the issuer's open link for the named org closes with its bindings.
 * The claims read before the signature is checked only choose which key to verify with; every value used afterwards comes from the VERIFIED claims. A refusal is a short code.
 * A key-fetch or replay-store failure that is not a domain refusal throws (the node answers 503), never trusts.
 */
export async function applyLinkAssertion(deps: ApplyLinkDeps, token: string): Promise<LinkResult> {
  const fail = (code: LinkRefusal, verifier?: string): LinkResult => ({ ok: false, code, ...(verifier ? { verifier } : {}) });
  const peek = peekUnverifiedClaims(token);
  if (!peek) return fail("malformed");
  const iss = peek.iss;
  const act = peek.act;
  if (typeof iss !== "string" || !isCanonicalHttpsOrigin(iss) || (act !== "link" && act !== "unlink") || typeof peek.org !== "string") return fail("malformed");

  let codeHash: string | null = null;
  if (act === "link") {
    if (!isLinkTokenShape(peek.code)) return fail("link_code_invalid");
    codeHash = await hashLinkToken(peek.code);
    const known = await deps.links.findCode(codeHash);
    // One answer for an unknown, used, expired or another origin's code.
    if (!known || known.origin !== iss || known.orgUserId !== peek.org) return fail("link_code_invalid");
  } else {
    const open = await deps.links.openLinkOfIssuer(iss);
    if (!open || open.orgUserId !== peek.org) return fail("no_open_link");
  }

  const verifier = createServiceAssertionVerifier({
    selfNodeId: deps.selfNodeId,
    trustedHomes: [{ issuer: iss, jwksUri: jwksUriOfOrigin(iss), services: [NODE_CONNECT_SERVICE] }],
    fetchJwks: deps.fetchJwks,
    replay: deps.replay,
    ...(deps.now ? { now: deps.now } : {}),
  });
  const verified = await verifier.verify(token);
  if (!verified.ok) return fail(verified.code === "jwks_unavailable" ? "jwks_unavailable" : "invalid_assertion", verified.code);
  const claims = verified.claims;
  if (verified.issuer !== iss || verified.scope !== LINK_SCOPE || claims.act !== act || claims.org !== peek.org) return fail("invalid_assertion");

  try {
    if (act === "link") {
      const services = parseServicesClaim(claims.services);
      if (!services || typeof claims.code !== "string" || !codeHash || (await hashLinkToken(claims.code)) !== codeHash) return fail("malformed");
      const orgUserId = peek.org as string;
      const principalIds = await Promise.all(services.map((service) => servicePrincipalId({ issuer: iss, service })));
      return await deps.inTransaction(async (links) => {
        const burned = await links.consumeCode(codeHash as string);
        if (!burned || burned !== orgUserId) throw new Refusal("link_code_invalid");
        if ((await links.orgSuspended(orgUserId)) !== false) throw new Refusal("org_suspended");
        const linkId = await links.insertLink({ orgUserId, issuer: iss, services });
        if (!linkId) throw new Refusal("issuer_already_linked");
        const bound = await links.bindPrincipals({ linkId, orgUserId, principalIds });
        return { ok: true as const, act: "link" as const, orgUserId, issuer: iss, services, linkId, bound };
      });
    }
    return await deps.inTransaction(async (links) => {
      const open = await links.openLinkOfIssuer(iss);
      if (!open || open.orgUserId !== peek.org) throw new Refusal("no_open_link");
      // Closed by the org's own `users` id: the other node's signature is the decision, and the row needs a user to name.
      const closed = await links.closeLink({ linkId: open.id, closedBy: open.orgUserId });
      if (!closed) throw new Refusal("no_open_link");
      const closedBindings = await links.closeBindings({ linkId: closed.id, orgUserId: closed.orgUserId });
      return { ok: true as const, act: "unlink" as const, orgUserId: closed.orgUserId, issuer: iss, services: closed.services, linkId: closed.id, closedBindings };
    });
  } catch (error) {
    if (error instanceof Refusal) return fail(error.code);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Postgres adapter
// ---------------------------------------------------------------------------------------------------------------------------------------------------

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const iso = (value: unknown): string => {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : "";
};

function toLink(row: Record<string, unknown> | undefined): OpenLink | null {
  const id = str(row?.id);
  const orgUserId = str(row?.org_user_id);
  const issuer = str(row?.issuer);
  const services = Array.isArray(row?.services) ? (row?.services as unknown[]).filter((s): s is string => typeof s === "string") : null;
  if (!id || !orgUserId || !issuer || !services) return null;
  return { id, orgUserId, issuer, services, createdAt: iso(row?.created_at) };
}

/** The Postgres adapter over a service-role tag (`org_links`, `org_link_codes`, `payer_bindings`). Timestamps are SQL expressions or ISO strings, never JS Dates. */
export function createPostgresOrgLinkStore(sql: SqlTag): OrgLinkStore {
  return {
    async openLinkOfIssuer(issuer) {
      const rows = await sql`SELECT id, org_user_id, issuer, services, created_at FROM org_links WHERE issuer = ${issuer} AND closed_at IS NULL LIMIT 1`;
      return toLink(rows[0]);
    },
    async openLinksOfOrg(orgUserId, limit) {
      const rows = await sql`
        SELECT id, org_user_id, issuer, services, created_at FROM org_links
        WHERE org_user_id = ${orgUserId} AND closed_at IS NULL ORDER BY created_at DESC LIMIT ${limit}`;
      return rows.flatMap((row) => {
        const link = toLink(row);
        return link ? [link] : [];
      });
    },
    async createCode({ orgUserId, origin, codeHash, createdBy, ttlMinutes, maxOpen }) {
      const open = await sql`
        SELECT count(*)::int AS n FROM org_link_codes
        WHERE org_user_id = ${orgUserId} AND consumed_at IS NULL AND expires_at > now()`;
      if (Number(open[0]?.n ?? 0) >= maxOpen) return "too_many_codes";
      const rows = await sql`
        INSERT INTO org_link_codes (org_user_id, origin, code_hash, created_by, expires_at)
        VALUES (${orgUserId}, ${origin}, ${codeHash}, ${createdBy}, now() + make_interval(mins => ${ttlMinutes}::int))
        RETURNING expires_at`;
      return { expiresAt: iso(rows[0]?.expires_at) };
    },
    async findCode(codeHash) {
      const rows = await sql`
        SELECT org_user_id, origin FROM org_link_codes
        WHERE code_hash = ${codeHash} AND consumed_at IS NULL AND expires_at > now() LIMIT 1`;
      const orgUserId = str(rows[0]?.org_user_id);
      const origin = str(rows[0]?.origin);
      return orgUserId && origin ? { orgUserId, origin } : null;
    },
    async consumeCode(codeHash) {
      const rows = await sql`
        UPDATE org_link_codes SET consumed_at = now()
        WHERE code_hash = ${codeHash} AND consumed_at IS NULL AND expires_at > now()
        RETURNING org_user_id`;
      return str(rows[0]?.org_user_id);
    },
    async insertLink({ orgUserId, issuer, services }) {
      const rows = await sql`
        INSERT INTO org_links (org_user_id, issuer, services) VALUES (${orgUserId}, ${issuer}, ${services as string[]})
        ON CONFLICT (issuer) WHERE closed_at IS NULL DO NOTHING
        RETURNING id`;
      return str(rows[0]?.id);
    },
    async closeLink({ linkId, closedBy }) {
      const rows = await sql`
        UPDATE org_links SET closed_at = now(), closed_by = ${closedBy}
        WHERE id::text = ${linkId} AND closed_at IS NULL
        RETURNING id, org_user_id, issuer, services, created_at`;
      return toLink(rows[0]);
    },
    async bindPrincipals({ linkId, orgUserId, principalIds }) {
      if (principalIds.length === 0) return 0;
      const ids = principalIds as string[];
      // An open binding the subject already holds is replaced by the link's: the owner's consent plus the other node's signature is the decision.
      await sql`
        UPDATE payer_bindings SET revoked_at = now(), revoked_by = ${orgUserId}
        WHERE subject_user_id = ANY(${ids}) AND revoked_at IS NULL AND link_id IS DISTINCT FROM ${linkId}::uuid`;
      const rows = await sql`
        INSERT INTO payer_bindings (subject_user_id, billing_account_id, approved_by, approved_at, link_id, created_at)
        SELECT ap.user_id, b.id, ${orgUserId}, now(), ${linkId}::uuid, clock_timestamp()
        FROM agent_principals ap, billing_accounts b
        WHERE ap.user_id = ANY(${ids}) AND ap.kind = 'external' AND b.owner_user_id = ${orgUserId}
        ON CONFLICT (subject_user_id) WHERE revoked_at IS NULL DO NOTHING
        RETURNING id`;
      return rows.length;
    },
    async closeBindings({ linkId, orgUserId }) {
      const rows = await sql`
        UPDATE payer_bindings SET revoked_at = now(), revoked_by = ${orgUserId}
        WHERE link_id = ${linkId}::uuid AND revoked_at IS NULL
        RETURNING id`;
      return rows.length;
    },
    async orgSuspended(orgUserId) {
      const rows = await sql`SELECT suspended_at FROM agent_principals WHERE user_id = ${orgUserId} AND kind = 'org' LIMIT 1`;
      return rows[0] ? rows[0].suspended_at !== null && rows[0].suspended_at !== undefined : null;
    },
  };
}

