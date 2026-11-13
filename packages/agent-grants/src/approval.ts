// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/approval`
 * Purpose: The unique approval link of ONE ask, and the claim link of one claim. An agent hands the link to the human who decides.
 * Scope: Pure path builders. A link is a DEEP LINK into a page that already exists (the owner's profile, or the Admin AI-access page): the page highlights and scrolls to that one row.
 *   Never a page of its own.
 * Invariants:
 *   - APPROVER_FOLLOWS_RESOURCE: a personal row (the owner's, for an owned agent) is decided on the owner's profile; every other row is a node-admin's, in the Admin area.
 *   - The id in the link is the row's random UUID. It names the request and grants nothing: the page still needs the right session, and lists only what that session may decide.
 * Side-effects: none
 * @public
 */

export const OWNER_PAGE_PATH = "/profile" as const;
export const ADMIN_PAGE_PATH = "/admin/ai-access" as const;

/** The link of one request: the owner's profile (`personal`) or the Admin page (`node`), with `?request=<id>`. */
export function approvalPath(requestId: string, plane: "personal" | "node"): string {
  return `${plane === "personal" ? OWNER_PAGE_PATH : ADMIN_PAGE_PATH}?request=${requestId}`;
}

/** The link of one claim: the owner's profile with `?claim=<id>`. */
export function claimPath(claimId: string): string {
  return `${OWNER_PAGE_PATH}?claim=${claimId}`;
}
