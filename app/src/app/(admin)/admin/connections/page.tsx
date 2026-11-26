// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/connections/page`
 * Purpose: This node as an ORG: its page for its accounts on other nodes (task.0181): node, status (including suspended), Connect by origin, Disconnect. A mount of
 *   `OrgConnectionsPage` from `@cogni/knowledge-base-ui/orgs`.
 * Scope: Server component in the Admin area (ADMIN_ACTS_IN_ADMIN: the org's admins are this node's admins, the repo-spec approvers). Access gated upstream by `(admin)/layout.tsx`; the
 *   route runs the one admin check again. Adds no authority logic.
 * Invariants: ADMIN_ACTS_IN_ADMIN, CONNECT_IS_SERVER_TO_SERVER (the page only asks this node to send the signed connect), the node must be in the fleet directory.
 * Side-effects: none (server render only)
 * Links: https://node-template.cognidao.org/knowledge/org-fleet-identity
 * @public
 */

import type { ReactElement } from "react";

import { PageContainer } from "@/components";

import { OrgConnections } from "./OrgConnections.client";

export default function ConnectionsPage(): ReactElement {
  return (
    <PageContainer maxWidth="2xl">
      <OrgConnections />
    </PageContainer>
  );
}
