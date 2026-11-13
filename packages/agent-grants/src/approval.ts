// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/approval`
 * Purpose: The unique approval page of ONE ask. An agent hands this URL to the human who decides; the page shows only that request.
 * Scope: Pure path builders. The node's routes own the pages; the package only fixes where each kind of row is decided.
 * Invariants:
 *   - APPROVER_FOLLOWS_RESOURCE: a personal row (the owner's, for an owned agent) is decided on the owner's profile; every other row is a node-admin's, in the Admin area.
 *     Never a generic page: the id in the path is the row.
 *   - The id is the row's random UUID. It names the request and grants nothing: the page still needs the right session.
 * Side-effects: none
 * @public
 */

export const OWNER_REQUEST_PATH_PREFIX = "/profile/ai/requests/" as const;
export const ADMIN_REQUEST_PATH_PREFIX = "/admin/ai-access/requests/" as const;

/** The path of one request's approval page. `personal` rows go to the owner's profile; `node` rows go to Admin. */
export function approvalPath(requestId: string, plane: "personal" | "node"): string {
  return `${plane === "personal" ? OWNER_REQUEST_PATH_PREFIX : ADMIN_REQUEST_PATH_PREFIX}${requestId}`;
}
