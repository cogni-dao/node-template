// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/orgs/[orgId]/page`
 * Purpose: The org account page (task.0181): who spends for the org here, grant or remove `org:spend`, and the history. A mount of `OrgAccountPage` from `@cogni/knowledge-base-ui/orgs`.
 * Scope: Server entrypoint only; it names the org's endpoints and renders the package page. No top-level tab: it is reached from "Your orgs" in the account menu. Auth by the (app) layout guard.
 * Invariants: NOTHING_FOR_NO_ROLE (a person with no role on the org sees nothing: the route answers its one 404).
 * Side-effects: none (server render only)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import type { ReactElement } from "react";

import { PageContainer } from "@/components";

import { OrgAccount } from "./OrgAccount.client";

export const dynamic = "force-dynamic";

export default async function OrgAccountPage({ params }: { params: Promise<{ orgId: string }> }): Promise<ReactElement> {
  const { orgId } = await params;
  return (
    <PageContainer maxWidth="2xl">
      <OrgAccount orgId={orgId} />
    </PageContainer>
  );
}
