// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/orgs/page`
 * Purpose: `/admin` org accounts (task.0181): every org account on this node, with Suspend and Restore (a reason each). A mount of `AdminOrgAccounts` from `@cogni/knowledge-base-ui/orgs`.
 * Scope: Server component. Access gated upstream by `(admin)/layout.tsx`; the routes run the one admin check again. Adds no authority logic.
 * Invariants: ADMIN_ACTS_IN_ADMIN, NO_TAKEOVER (the page can suspend and restore, never change an org's admins).
 * Side-effects: none (server render only)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import type { ReactElement } from "react";

import { PageContainer } from "@/components";

import { AdminOrgs } from "./AdminOrgs.client";

export default function AdminOrgsPage(): ReactElement {
  return (
    <PageContainer maxWidth="2xl">
      <AdminOrgs />
    </PageContainer>
  );
}
