// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/orgs.v1`
 * Purpose: The org account route schemas (task.0181), re-exported from their published owner so a node's private contracts never define a second copy.
 * Scope: Re-export only. The schemas, the list query codec and their invariants live in `@cogni-dao/agent-grants/org-contracts`.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

// Named, not `export *`: the bundler turns a star re-export of an external module into a copied object, which loses the live named exports.
export {
  orgAcceptInviteOperation,
  orgAdminListOperation,
  orgChangeRoleOperation,
  orgCreateOperation,
  orgInviteOperation,
  orgLinkCodeOperation,
  orgLinkOperation,
  orgLinkPreviewOperation,
  orgLinksListOperation,
  orgListOperation,
  orgMembersListOperation,
  orgMyInvitesOperation,
  orgOutboundLinkOperation,
  orgRemoveMemberOperation,
  orgRoleSchema,
  orgSuspensionOperation,
  orgUnlinkOperation,
  orgViewOperation,
  pageQuerySchema,
} from "@cogni/agent-grants/org-contracts";
