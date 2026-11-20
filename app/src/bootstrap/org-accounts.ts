// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/org-accounts`
 * Purpose: This node's wiring of the org accounts in `@cogni-dao/agent-grants` (task.0181): create an org, invite, accept, change a role, remove, list; make a link code, preview one,
 *   apply a signed link or unlink from another node, close a link; suspend an org; and, as the OTHER node, preview and sign a link for an org on a node that gave this node's admin a code.
 * Scope: Composition only. Every write runs in ONE transaction over the service-role client (`agent_roles`, `org_*` and `payer_bindings` are deny-all for the app role); every decision
 *   (who may, the owner minimum, the code rules, the key fetch rules, the bindings) lives in the package. Logs one event per outcome, never a token, a code or a wallet.
 * Invariants:
 *   - ONE_TRANSACTION: an owner-minimum check and its write share one transaction, so two owners acting at once cannot both leave.
 *   - NO_SECRET_IN_LOGS: events carry ids, roles, origins and counts; never an invite wallet, a link code or an assertion.
 *   - ONE_REQUEST_PATH: the outbound preview and the outbound signed link go through `createPinnedHttp` (https only, no redirect, the 5 s budget includes the lookup, a 64 KB response
 *     read, private ranges refused, address pinned): the code names the target, so the target is attacker-supplied until the preview confirms it.
 *   - CODE_NAMES_THE_TARGET: the other node's origin, node id and org id come from the link code, never from the admin's input. The admin confirms the org name the preview returned
 *     (`expectOrgName`); a link is signed only if a fresh preview still says the same name.
 *   - SIGNS_AS_NODE_CONNECT: the outbound link is signed as service `node-connect` for the target's audience and posted once to the fixed `LINK_PATH`.
 * Side-effects: IO (service-role database reads and writes; pinned HTTPS GET/POST for an outbound preview or link)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @internal
 */

import {
  acceptInvite,
  applyLinkAssertion,
  changeRole,
  closeLinkByOwner,
  createLinkCode,
  createOrg,
  createPostgresOrgAccountStore,
  createPostgresOrgLinkStore,
  getOrgView,
  inviteMember,
  LINK_PATH,
  type LinkPreview,
  type LinkResult,
  listMembers,
  listMyInvites,
  listOrgs,
  type OpenInvite,
  type OpenLink,
  type OrgMember,
  type OrgMembership,
  type OrgRecord,
  type OrgRole,
  type Page,
  type PageQuery,
  parseLinkCode,
  previewLinkCode,
  removeMember,
  requireRole,
  setOrgSuspended,
  signLinkAssertion,
} from "@cogni/agent-grants";
import { createPinnedHttp, createPinnedJwksFetch } from "@cogni/agent-grants/jwks-fetch";
import { createPostgresReplayStore, type ServiceAssertionSigner } from "@cogni/agent-grants/service-auth";
import type { Logger } from "pino";
import { EVENT_NAMES } from "@/shared/observability";
import type { AgentAuthoritySql } from "./agent-authority";

/** Why an outbound preview or link did not happen. A plain code, never a body. */
export type OutboundRefusal = "invalid_code" | "no_signer" | "unreachable" | "code_not_found" | "preview_mismatch" | "preview_changed" | "invalid_input";

export type OutboundResult<T> = ({ ok: true } & T) | { ok: false; reason: OutboundRefusal };

export interface OrgAccounts {
  create(userId: string, name: unknown): Promise<{ orgUserId: string; billingAccountId: string; name: string }>;
  list(userId: string, query: PageQuery): Promise<Page<OrgMembership>>;
  view(actorUserId: string, orgUserId: string, query: PageQuery): Promise<{ org: OrgRecord; role: OrgRole; members: Page<OrgMember>; links: Page<OpenLink> }>;
  members(actorUserId: string, orgUserId: string, query: PageQuery): Promise<Page<OrgMember>>;
  links(actorUserId: string, orgUserId: string, query: PageQuery): Promise<Page<OpenLink>>;
  invite(input: { actorUserId: string; orgUserId: string; wallet: unknown; role: unknown }): Promise<{ id: string; expiresAt: string; role: OrgRole }>;
  myInvites(userId: string, query: PageQuery): Promise<Page<OpenInvite>>;
  accept(userId: string, inviteId: string): Promise<{ orgUserId: string; role: OrgRole }>;
  changeRole(input: { actorUserId: string; orgUserId: string; targetUserId: string; role: unknown }): Promise<{ changed: boolean; from: OrgRole; to: OrgRole }>;
  remove(input: { actorUserId: string; orgUserId: string; targetUserId: string }): Promise<{ removed: boolean }>;
  linkCode(input: { actorUserId: string; orgUserId: string; origin: string }): Promise<{ code: string; origin: string; expiresAt: string }>;
  /** The public preview of a link code THIS node made: the org's name and this node's origin, or null (unknown, used, expired, another node's, malformed). */
  previewCode(code: unknown): Promise<LinkPreview | null>;
  closeLink(input: { actorUserId: string; orgUserId: string; linkId: string }): Promise<{ closedBindings: number }>;
  /** A signed link or unlink from another node (the assertion is the credential). A failed key fetch or replay store throws; a refusal is a code. */
  applyLink(token: string): Promise<LinkResult>;
  /** The caller proved node-admin first (the one admin check). False when the user is not an org. */
  setSuspended(input: { adminUserId: string; orgUserId: string; suspended: boolean }): Promise<boolean>;
  /** This node as the OTHER node: ask the node named in `code` for the code's preview, so the admin can confirm the org name before anything is signed. */
  previewOutbound(code: string): Promise<OutboundResult<{ preview: LinkPreview }>>;
  /** Sign `act: link` (after a fresh preview still names `expectOrgName`) or `act: unlink` for the org and node the code names, and post it once. The caller proved node-admin first. */
  signOutbound(input: {
    act: "link" | "unlink";
    code: string;
    services?: readonly string[] | undefined;
    expectOrgName?: string | undefined;
  }): Promise<OutboundResult<{ httpStatus: number; error: string | null; act: "link" | "unlink" | null }>>;
}

/** The short error code a node answers with, kept only when it looks like one (letters, digits and underscore). */
const SHORT_CODE = /^[a-z0-9_]{1,40}$/;

export function createOrgAccounts(deps: {
  sql: AgentAuthoritySql;
  log: Logger;
  nodeId: string;
  /** This node's own canonical https origin (from `APP_BASE_URL`), or null when it has none: no link code can be made without it. */
  selfOrigin: string | null;
  getSigner: () => Promise<ServiceAssertionSigner | null>;
  /** The request path to another node. Default `createPinnedHttp()`. */
  http?: ReturnType<typeof createPinnedHttp>;
}): OrgAccounts {
  const tx = <T>(fn: (store: ReturnType<typeof createPostgresOrgAccountStore>, links: ReturnType<typeof createPostgresOrgLinkStore>) => Promise<T>): Promise<T> =>
    deps.sql.begin((t) => fn(createPostgresOrgAccountStore(t), createPostgresOrgLinkStore(t)));
  const read = createPostgresOrgAccountStore(deps.sql);
  const readLinks = createPostgresOrgLinkStore(deps.sql);
  const replay = createPostgresReplayStore(deps.sql);
  const fetchJwks = createPinnedJwksFetch();
  const http = deps.http ?? createPinnedHttp();
  const info = (event: string, fields: Record<string, unknown>) => deps.log.info({ event, ...fields }, event);
  const self = () => {
    if (!deps.selfOrigin) throw new Error("self_origin_unavailable");
    return { origin: deps.selfOrigin, nodeId: deps.nodeId };
  };

  /** The preview the node named in `code` gives for it: its org name and its origin, which must be the origin the code names. */
  const fetchPreview = async (code: string, parsed: NonNullable<ReturnType<typeof parseLinkCode>>): Promise<OutboundResult<{ preview: LinkPreview }>> => {
    let response: { status: number; body: string };
    try {
      response = await http(`${parsed.origin}/api/v1/orgs/link-preview?code=${encodeURIComponent(code)}`);
    } catch {
      return { ok: false, reason: "unreachable" };
    }
    if (response.status === 404) return { ok: false, reason: "code_not_found" };
    if (response.status !== 200) return { ok: false, reason: "unreachable" };
    let body: { orgName?: unknown; origin?: unknown } = {};
    try {
      body = JSON.parse(response.body) as typeof body;
    } catch {
      return { ok: false, reason: "unreachable" };
    }
    if (typeof body.orgName !== "string" || body.orgName.length === 0 || body.orgName.length > 200 || typeof body.origin !== "string") return { ok: false, reason: "preview_mismatch" };
    // The node that answered must be the node the code names.
    if (body.origin !== parsed.origin) return { ok: false, reason: "preview_mismatch" };
    return { ok: true, preview: { orgName: body.orgName, origin: body.origin } };
  };

  return {
    async create(userId, name) {
      const org = await tx((store) => createOrg(store, { creatorUserId: userId, name }));
      info(EVENT_NAMES.ORG_CREATED, { orgUserId: org.orgUserId, userId });
      return org;
    },
    list: (userId, query) => listOrgs(read, userId, query),
    async view(actorUserId, orgUserId, query) {
      // One consistent snapshot: the record, the first page of the people and of the links read together.
      return tx(async (store, links) => {
        const view = await getOrgView(store, { actorUserId, orgUserId, ...query });
        return { ...view, links: await links.openLinksOfOrg(orgUserId, { limit: query.limit ?? 50, after: null }) };
      });
    },
    members: (actorUserId, orgUserId, query) => listMembers(read, { actorUserId, orgUserId, ...query }),
    async links(actorUserId, orgUserId, query) {
      await requireRole(read, actorUserId, orgUserId, "admin");
      return readLinks.openLinksOfOrg(orgUserId, { limit: query.limit ?? 50, after: query.cursor ?? null });
    },
    async invite(input) {
      const invite = await tx((store) => inviteMember(store, input));
      info(EVENT_NAMES.ORG_INVITED, { orgUserId: input.orgUserId, inviteId: invite.id, role: invite.role, invitedBy: input.actorUserId });
      return { id: invite.id, expiresAt: invite.expiresAt, role: invite.role };
    },
    myInvites: (userId, query) => listMyInvites(read, userId, query),
    async accept(userId, inviteId) {
      const accepted = await tx((store) => acceptInvite(store, { userId, inviteId }));
      info(EVENT_NAMES.ORG_INVITE_ACCEPTED, { orgUserId: accepted.orgUserId, userId, role: accepted.role, inviteId });
      return accepted;
    },
    async changeRole(input) {
      const result = await tx((store) => changeRole(store, input));
      if (result.changed)
        info(EVENT_NAMES.ORG_ROLE_CHANGED, { orgUserId: input.orgUserId, targetUserId: input.targetUserId, from: result.from, to: result.to, actorUserId: input.actorUserId });
      return result;
    },
    async remove(input) {
      const result = await tx((store) => removeMember(store, input));
      if (result.removed)
        info(EVENT_NAMES.ORG_MEMBER_REMOVED, { orgUserId: input.orgUserId, targetUserId: input.targetUserId, role: result.role, actorUserId: input.actorUserId });
      return { removed: result.removed };
    },
    async linkCode(input) {
      const me = self(); // a node with no https origin of its own makes no code, before any transaction opens
      const made = await tx((store, links) => createLinkCode({ orgs: store, links, self: me }, input));
      info(EVENT_NAMES.ORG_LINK_CODE_CREATED, { orgUserId: input.orgUserId, origin: made.origin, actorUserId: input.actorUserId });
      return made;
    },
    previewCode: (code) => (deps.selfOrigin ? previewLinkCode({ links: readLinks, self: self() }, code) : Promise.resolve(null)),
    async closeLink(input) {
      const closed = await tx((store, links) => closeLinkByOwner({ orgs: store, inTransaction: (fn) => fn(links) }, input));
      info(EVENT_NAMES.ORG_UNLINKED, { orgUserId: input.orgUserId, issuer: closed.issuer, linkId: closed.linkId, closedBindings: closed.closedBindings, by: input.actorUserId });
      if (closed.closedBindings > 0) info(EVENT_NAMES.PAYER_REVOKED, { linkId: closed.linkId, closedBindings: closed.closedBindings, by: input.actorUserId });
      return { closedBindings: closed.closedBindings };
    },
    async applyLink(token) {
      const result = await applyLinkAssertion(
        {
          links: readLinks,
          inTransaction: (fn) => deps.sql.begin((t) => fn(createPostgresOrgLinkStore(t))),
          selfNodeId: deps.nodeId,
          replay,
          fetchJwks,
        },
        token
      );
      if (result.ok && result.act === "link") {
        info(EVENT_NAMES.ORG_LINKED, { orgUserId: result.orgUserId, issuer: result.issuer, services: result.services, linkId: result.linkId, bound: result.bound });
        if (result.bound > 0) info(EVENT_NAMES.PAYER_BOUND, { linkId: result.linkId, bound: result.bound, via: "link" });
      } else if (result.ok) {
        info(EVENT_NAMES.ORG_UNLINKED, { orgUserId: result.orgUserId, issuer: result.issuer, linkId: result.linkId, closedBindings: result.closedBindings, by: "issuer" });
        if (result.closedBindings > 0) info(EVENT_NAMES.PAYER_REVOKED, { linkId: result.linkId, closedBindings: result.closedBindings, by: "issuer" });
      } else deps.log.warn({ event: EVENT_NAMES.ORG_REFUSED, routeId: "orgs.link", code: result.code, ...(result.verifier ? { verifier: result.verifier } : {}) }, EVENT_NAMES.ORG_REFUSED);
      return result;
    },
    async setSuspended({ adminUserId, orgUserId, suspended }) {
      const changed = await setOrgSuspended(read, orgUserId, suspended);
      if (changed) info(EVENT_NAMES.ORG_SUSPENDED, { orgUserId, suspended, adminUserId });
      return changed;
    },
    async previewOutbound(code) {
      const parsed = parseLinkCode(code);
      if (!parsed) return { ok: false, reason: "invalid_code" };
      return fetchPreview(code, parsed);
    },
    async signOutbound(input) {
      const parsed = parseLinkCode(input.code);
      if (!parsed) return { ok: false, reason: "invalid_code" };
      if (input.act === "link") {
        if (!input.services || input.services.length === 0 || !input.expectOrgName) return { ok: false, reason: "invalid_input" };
        // The admin confirmed a name; sign only if the node that will receive the link still says that name for this code.
        const fresh = await fetchPreview(input.code, parsed);
        if (!fresh.ok) return fresh;
        if (fresh.preview.orgName !== input.expectOrgName) return { ok: false, reason: "preview_changed" };
      }
      const signer = await deps.getSigner();
      if (!signer) return { ok: false, reason: "no_signer" };
      let token: string;
      try {
        token = await signLinkAssertion(signer, {
          audienceNodeId: parsed.nodeId,
          act: input.act,
          orgUserId: parsed.orgUserId,
          ...(input.act === "link" ? { code: parsed.secret, ...(input.services ? { services: input.services } : {}) } : {}),
        });
      } catch {
        return { ok: false, reason: "invalid_input" };
      }
      let response: { status: number; body: string };
      try {
        response = await http(`${parsed.origin}${LINK_PATH}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
      } catch {
        return { ok: false, reason: "unreachable" };
      }
      let body: { error?: unknown; act?: unknown } = {};
      try {
        body = JSON.parse(response.body) as typeof body;
      } catch {
        // A node that answers no JSON is reported by its status alone.
      }
      const error = typeof body.error === "string" && SHORT_CODE.test(body.error) ? body.error : null;
      const act = body.act === "link" || body.act === "unlink" ? body.act : null;
      info(EVENT_NAMES.ORG_OUTBOUND_LINK, { act: input.act, targetOrigin: parsed.origin, httpStatus: response.status, error });
      return { ok: true, httpStatus: response.status, error, act };
    },
  };
}
