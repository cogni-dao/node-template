// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/org-accounts`
 * Purpose: This node's wiring of the org accounts in `@cogni-dao/agent-grants` (task.0181): create an org, invite, accept, change a role, remove, list; make a link code, apply a
 *   signed link or unlink from another node, close a link; suspend an org; and, as the OTHER node, sign a link for an org on a node that gave this node's admin a code.
 * Scope: Composition only. Every write runs in ONE transaction over the service-role client (`agent_roles`, `org_*` and `payer_bindings` are deny-all for the app role); every decision
 *   (who may, the owner minimum, the code rules, the key fetch rules, the bindings) lives in the package. Logs one event per outcome, never a token, a code or a wallet.
 * Invariants:
 *   - ONE_TRANSACTION: an owner-minimum check and its write share one transaction, so two owners acting at once cannot both leave.
 *   - NO_SECRET_IN_LOGS: events carry ids, roles, origins and counts; never an invite wallet, a link code or an assertion.
 *   - SIGNS_AS_NODE_CONNECT: the outbound link is signed as service `node-connect` for the target's audience and posted once to the fixed `LINK_PATH`, without following a redirect.
 * Side-effects: IO (service-role database reads and writes; one signed HTTPS POST for an outbound link)
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
  type LinkResult,
  listMyInvites,
  listOrgs,
  type OpenInvite,
  type OrgMember,
  type OrgMembership,
  type OrgRecord,
  type OrgRole,
  type OpenLink,
  removeMember,
  setOrgSuspended,
  signLinkAssertion,
} from "@cogni/agent-grants";
import { createPinnedJwksFetch } from "@cogni/agent-grants/jwks-fetch";
import { createPostgresReplayStore, isCanonicalHttpsOrigin, type ServiceAssertionSigner } from "@cogni/agent-grants/service-auth";
import type { Logger } from "pino";
import { EVENT_NAMES } from "@/shared/observability";
import type { AgentAuthoritySql } from "./agent-authority";

export interface OrgAccounts {
  create(userId: string, name: unknown): Promise<{ orgUserId: string; billingAccountId: string; name: string }>;
  list(userId: string): Promise<OrgMembership[]>;
  view(actorUserId: string, orgUserId: string): Promise<{ org: OrgRecord; role: OrgRole; members: OrgMember[]; links: OpenLink[] }>;
  invite(input: { actorUserId: string; orgUserId: string; wallet: unknown; role: unknown }): Promise<{ id: string; expiresAt: string; role: OrgRole }>;
  myInvites(userId: string): Promise<OpenInvite[]>;
  accept(userId: string, inviteId: string): Promise<{ orgUserId: string; role: OrgRole }>;
  changeRole(input: { actorUserId: string; orgUserId: string; targetUserId: string; role: unknown }): Promise<{ changed: boolean; from: OrgRole; to: OrgRole }>;
  remove(input: { actorUserId: string; orgUserId: string; targetUserId: string }): Promise<{ removed: boolean }>;
  linkCode(input: { actorUserId: string; orgUserId: string; origin: string }): Promise<{ code: string; origin: string; expiresAt: string }>;
  closeLink(input: { actorUserId: string; orgUserId: string; linkId: string }): Promise<{ closedBindings: number }>;
  /** A signed link or unlink from another node (the assertion is the credential). A failed key fetch or replay store throws; a refusal is a code. */
  applyLink(token: string): Promise<LinkResult>;
  /** The caller proved node-admin first (the one admin check). False when the user is not an org. */
  setSuspended(input: { adminUserId: string; orgUserId: string; suspended: boolean }): Promise<boolean>;
  /** This node as the OTHER node: sign a link or unlink for an org on `targetNodeId` at `targetOrigin` and post it. The caller proved node-admin first. */
  signOutbound(input: {
    act: "link" | "unlink";
    targetOrigin: string;
    targetNodeId: string;
    orgUserId: string;
    code?: string | undefined;
    services?: readonly string[] | undefined;
  }): Promise<{ ok: true; httpStatus: number; error: string | null; act: "link" | "unlink" | null } | { ok: false; reason: "no_signer" | "invalid_origin" | "unreachable" | "invalid_input" }>;
}

/** The short error code a node answers with, kept only when it looks like one (letters, digits and underscore). */
const SHORT_CODE = /^[a-z0-9_]{1,40}$/;

export function createOrgAccounts(deps: {
  sql: AgentAuthoritySql;
  log: Logger;
  nodeId: string;
  getSigner: () => Promise<ServiceAssertionSigner | null>;
  fetchImpl?: typeof fetch;
}): OrgAccounts {
  const tx = <T>(fn: (store: ReturnType<typeof createPostgresOrgAccountStore>, links: ReturnType<typeof createPostgresOrgLinkStore>) => Promise<T>): Promise<T> =>
    deps.sql.begin((t) => fn(createPostgresOrgAccountStore(t), createPostgresOrgLinkStore(t)));
  const read = createPostgresOrgAccountStore(deps.sql);
  const readLinks = createPostgresOrgLinkStore(deps.sql);
  const replay = createPostgresReplayStore(deps.sql);
  const fetchJwks = createPinnedJwksFetch();
  const info = (event: string, fields: Record<string, unknown>) => deps.log.info({ event, ...fields }, event);

  return {
    async create(userId, name) {
      const org = await tx((store) => createOrg(store, { creatorUserId: userId, name }));
      info(EVENT_NAMES.ORG_CREATED, { orgUserId: org.orgUserId, userId });
      return org;
    },
    list: (userId) => listOrgs(read, userId),
    async view(actorUserId, orgUserId) {
      // One consistent snapshot: the record, the people and the links read together.
      return tx(async (store, links) => {
        const view = await getOrgView(store, { actorUserId, orgUserId });
        return { ...view, links: await links.openLinksOfOrg(orgUserId, 50) };
      });
    },
    async invite(input) {
      const invite = await tx((store) => inviteMember(store, input));
      info(EVENT_NAMES.ORG_INVITED, { orgUserId: input.orgUserId, inviteId: invite.id, role: invite.role, invitedBy: input.actorUserId });
      return { id: invite.id, expiresAt: invite.expiresAt, role: invite.role };
    },
    myInvites: (userId) => listMyInvites(read, userId),
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
      const made = await tx((store, links) => createLinkCode({ orgs: store, links }, input));
      info(EVENT_NAMES.ORG_LINK_CODE_CREATED, { orgUserId: input.orgUserId, origin: made.origin, actorUserId: input.actorUserId });
      return made;
    },
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
    async signOutbound(input) {
      if (!isCanonicalHttpsOrigin(input.targetOrigin)) return { ok: false, reason: "invalid_origin" };
      if (input.act === "link" && (!input.code || !input.services || input.services.length === 0)) return { ok: false, reason: "invalid_input" };
      const signer = await deps.getSigner();
      if (!signer) return { ok: false, reason: "no_signer" };
      let token: string;
      try {
        token = await signLinkAssertion(signer, {
          audienceNodeId: input.targetNodeId,
          act: input.act,
          orgUserId: input.orgUserId,
          ...(input.code ? { code: input.code } : {}),
          ...(input.services ? { services: input.services } : {}),
        });
      } catch {
        return { ok: false, reason: "invalid_input" };
      }
      let response: Response;
      try {
        response = await (deps.fetchImpl ?? fetch)(`${input.targetOrigin}${LINK_PATH}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: "{}",
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        return { ok: false, reason: "unreachable" };
      }
      let body: { error?: unknown; act?: unknown } = {};
      try {
        body = (await response.json()) as typeof body;
      } catch {
        // A provider that answers no JSON is reported by its status alone.
      }
      const error = typeof body.error === "string" && SHORT_CODE.test(body.error) ? body.error : null;
      const act = body.act === "link" || body.act === "unlink" ? body.act : null;
      info(EVENT_NAMES.ORG_OUTBOUND_LINK, { act: input.act, targetOrigin: input.targetOrigin, httpStatus: response.status, error });
      return { ok: true, httpStatus: response.status, error, act };
    },
  };
}

