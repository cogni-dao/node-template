// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/orgs.v1`
 * Purpose: Zod contracts for the org account routes (task.0181): create an org, list and read it, invite by wallet, accept, change a role, remove, make a link code, unlink,
 *   suspend, and the signed link a node sends another node.
 * Scope: Bodies and outputs only. The caller is always the authenticated session user, never a body field; the link route's credential is the signed assertion in the
 *   `Authorization` header, never the body.
 * Invariants: CONTRACTS_ARE_TRUTH. P1 has two roles only, `owner` and `admin`. A link code and an assertion appear in a body once, to the person or node that made them, and never in a
 *   log. An unknown org and an org the caller is not in are indistinguishable (`not_found`).
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { z } from "zod";

export const orgRoleSchema = z.enum(["owner", "admin"]);

const orgRefSchema = z.object({
  orgUserId: z.string().min(1),
  name: z.string(),
  billingAccountId: z.string().min(1),
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
  output: z.object({ orgs: z.array(orgRefSchema.extend({ role: orgRoleSchema })) }),
} as const;

export const orgViewOperation = {
  id: "orgs.view.v1",
  output: z.object({
    org: orgRefSchema,
    role: orgRoleSchema,
    members: z.array(z.object({ userId: z.string(), name: z.string().nullable(), role: orgRoleSchema, since: z.string() })),
    links: z.array(z.object({ id: z.string(), issuer: z.string(), services: z.array(z.string()), createdAt: z.string() })),
  }),
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
  /** The code is returned once and only its hash is kept. It lives 15 minutes and is single use. */
  output: z.object({ code: z.string(), origin: z.string(), expiresAt: z.string() }),
} as const;

export const orgUnlinkOperation = {
  id: "orgs.links.close.v1",
  output: z.object({ unlinked: z.boolean(), closedBindings: z.number().int().nonnegative() }),
} as const;

export const orgSuspensionOperation = {
  id: "orgs.suspension.v1",
  input: z.object({ suspended: z.boolean() }),
  output: z.object({ suspended: z.boolean() }),
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

/** This node's admin makes this node sign a link or unlink for another node (the node-admin side of a link). */
export const orgOutboundLinkOperation = {
  id: "orgs.outbound-link.v1",
  input: z.object({
    act: z.enum(["link", "unlink"]),
    /** The other node's https origin and node id (its assertion audience). */
    targetOrigin: z.string().min(1).max(200),
    targetNodeId: z.string().min(1).max(100),
    orgUserId: z.string().min(1).max(100),
    /** The one-time code the org's owner made there. Required for a link. */
    code: z.string().min(1).max(100).optional(),
    /** The services this node offers to act through, such as `node-ai`. Required for a link. */
    services: z.array(z.string().min(1).max(64)).max(8).optional(),
  }),
  output: z.object({ httpStatus: z.number().int(), error: z.string().nullable(), act: z.enum(["link", "unlink"]).nullable() }),
} as const;
