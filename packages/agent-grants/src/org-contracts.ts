// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/org-contracts`
 * Purpose: Zod contracts for the org account routes (task.0181): create an org, list and read it, invite by wallet, accept, change a role, remove, make a link code, unlink,
 *   suspend, and the signed link a node sends another node.
 * Scope: Bodies, outputs and the list query codec only; the PUBLISHED owner of these route schemas (a node's private `@cogni/node-contracts` re-exports them, so every node
 *   gets the same shapes with the capability). The routes, session, logging and mounts stay in each node's app. Bodies and outputs only. The caller is always the authenticated session user, never a body field; the link route's credential is the signed assertion in the
 *   `Authorization` header, never the body.
 * Invariants: CONTRACTS_ARE_TRUTH. LISTS_PAGE: every list is a page, `{ items, nextCursor }`; `nextCursor` is the opaque value to send back as `?cursor=` (null on the last page), `?limit=` is 1..100.
 *   P1 has two roles only, `owner` and `admin`. A link code and an assertion appear in a body once, to the person or node that made them, and never in a
 *   log. An unknown org and an org the caller is not in are indistinguishable (`not_found`).
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { z } from "zod";

export const orgRoleSchema = z.enum(["owner", "admin"]);

/** The query every list route takes. A page is at most 100 rows; a cursor is whatever the previous page returned. */
export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(100).optional(),
});

const nextCursor = z.string().nullable();
const memberSchema = z.object({ userId: z.string(), name: z.string().nullable(), wallet: z.string().nullable(), role: orgRoleSchema, since: z.string() });
const linkSchema = z.object({ id: z.string(), issuer: z.string(), services: z.array(z.string()), createdAt: z.string() });

const orgRefSchema = z.object({
  orgUserId: z.string().min(1),
  name: z.string(),
  billingAccountId: z.string().min(1),
  /** The org account's credit balance, so a list needs no credits read per org. */
  balanceCredits: z.number(),
  /** True when the node's admin suspended the org: the next run billed to it is refused with `org_suspended`. */
  suspended: z.boolean(),
});

export const orgCreateOperation = {
  id: "orgs.create.v1",
  input: z.object({ name: z.string().min(1).max(200) }),
  output: z.object({ orgUserId: z.string().min(1), billingAccountId: z.string().min(1), name: z.string() }),
} as const;

export const orgListOperation = {
  id: "orgs.list.v1",
  output: z.object({ orgs: z.array(orgRefSchema.extend({ role: orgRoleSchema })), nextCursor }),
} as const;

/** The node admin's list of every org: `GET /api/v1/admin/orgs?limit=&cursor=` (the one admin check; 403 otherwise). */
export const orgAdminListOperation = {
  id: "orgs.admin.list.v1",
  output: z.object({ orgs: z.array(z.object({ orgUserId: z.string().min(1), name: z.string(), suspended: z.boolean() })), nextCursor }),
} as const;

export const orgViewOperation = {
  id: "orgs.view.v1",
  output: z.object({
    org: orgRefSchema,
    role: orgRoleSchema,
    members: z.object({ items: z.array(memberSchema), nextCursor }),
    links: z.object({ items: z.array(linkSchema), nextCursor }),
  }),
} as const;

export const orgMembersListOperation = {
  id: "orgs.members.list.v1",
  output: z.object({ items: z.array(memberSchema), nextCursor }),
} as const;

export const orgLinksListOperation = {
  id: "orgs.links.list.v1",
  output: z.object({ items: z.array(linkSchema), nextCursor }),
} as const;

export const orgInviteOperation = {
  id: "orgs.invite.v1",
  input: z.object({ wallet: z.string().min(1).max(100), role: orgRoleSchema }),
  output: z.object({ id: z.string(), role: orgRoleSchema, expiresAt: z.string() }),
} as const;

export const orgMyInvitesOperation = {
  id: "orgs.invites.mine.v1",
  output: z.object({
    invites: z.array(z.object({ id: z.string(), orgUserId: z.string(), orgName: z.string(), role: orgRoleSchema, expiresAt: z.string() })),
    nextCursor,
  }),
} as const;

export const orgAcceptInviteOperation = {
  id: "orgs.invites.accept.v1",
  output: z.object({ orgUserId: z.string(), role: orgRoleSchema }),
} as const;

export const orgChangeRoleOperation = {
  id: "orgs.members.role.v1",
  input: z.object({ role: orgRoleSchema }),
  output: z.object({ changed: z.boolean(), from: orgRoleSchema, to: orgRoleSchema }),
} as const;

export const orgRemoveMemberOperation = {
  id: "orgs.members.remove.v1",
  output: z.object({ removed: z.boolean() }),
} as const;

export const orgLinkCodeOperation = {
  id: "orgs.link-codes.create.v1",
  /** The https origin of the node to link, such as `https://toks5.cognidao.org`. */
  input: z.object({ origin: z.string().min(1).max(200) }),
  /**
   * The code is returned once and only the hash of its secret is kept. It lives 15 minutes and is single use. It carries this node's origin and id and the org's id, so the other node's
   * admin enters only the code.
   */
  output: z.object({ code: z.string(), origin: z.string(), expiresAt: z.string() }),
} as const;

export const orgUnlinkOperation = {
  id: "orgs.links.close.v1",
  output: z.object({ unlinked: z.boolean(), closedBindings: z.number().int().nonnegative() }),
} as const;

/** Suspend an org (the node's admin; final in P1: there is no Resume, so the only body is `{ suspended: true }`). */
export const orgSuspensionOperation = {
  id: "orgs.suspension.v1",
  input: z.object({ suspended: z.literal(true) }),
  output: z.object({ suspended: z.literal(true) }),
} as const;

/** What a node answers to a signed link or unlink (the assertion is the `Authorization` bearer; the body is `{}`). */
export const orgLinkOperation = {
  id: "orgs.link.v1",
  input: z.object({}).strict(),
  output: z.object({
    act: z.enum(["link", "unlink"]),
    orgUserId: z.string(),
    services: z.array(z.string()),
    linkId: z.string(),
  }),
} as const;

/**
 * The public preview of a link code (`POST /api/v1/public/orgs/link-preview` with `{ code }` in the body, never in a URL): the org's name and this node's origin, for a code that is
 * valid and unused, and nothing else. Any other case is 404 `not_found`. Public and rate limited.
 */
export const orgLinkPreviewOperation = {
  id: "orgs.link-preview.v1",
  input: z.object({ code: z.string().min(1).max(700) }).strict(),
  output: z.object({ orgName: z.string(), origin: z.string() }),
} as const;

/**
 * This node's admin makes THIS node preview and sign a link for an org on another node. The admin enters only the code: the other node's origin, node id and the org id come from it.
 * `preview` asks that node what the code is for and returns its org name and origin. `link` signs only if a fresh preview still names `expectOrgName` (the name the admin confirmed).
 * `unlink` signs the close for the org and node the original code names.
 */
export const orgOutboundLinkOperation = {
  id: "orgs.outbound-link.v1",
  input: z.discriminatedUnion("step", [
    z.object({ step: z.literal("preview"), code: z.string().min(1).max(700) }),
    z.object({
      step: z.literal("link"),
      code: z.string().min(1).max(700),
      /** The org name the preview returned and the admin confirmed. */
      expectOrgName: z.string().min(1).max(200),
      /** The services this node offers to act through, such as `node-ai`. */
      services: z.array(z.string().min(1).max(64)).min(1).max(8),
    }),
    z.object({ step: z.literal("unlink"), code: z.string().min(1).max(700) }),
  ]),
  output: z.union([
    z.object({ step: z.literal("preview"), orgName: z.string(), origin: z.string() }),
    z.object({ step: z.enum(["link", "unlink"]), httpStatus: z.number().int(), error: z.string().nullable(), act: z.enum(["link", "unlink"]).nullable() }),
  ]),
} as const;
