// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/orgs/[orgId]/OrgAccount.client`
 * Purpose: Client mount of the package's `OrgAccountPage` with this org's session-only routes and this node's money format.
 * Scope: Binding only; it decides nothing about who may act (the routes do).
 * Invariants: HUMAN_ROUTES_SESSION_ONLY. The Fund link opens /credits for this org's account and names the org id, so the credits page reads the name from the single org view.
 * Side-effects: IO (the page's fetches)
 * Links: src/app/api/v1/orgs/[orgId]/route.ts
 * @internal
 */

"use client";

import { OrgAccountPage } from "@cogni/knowledge-base-ui/orgs";
import type { ReactElement } from "react";

import { creditsToUsd } from "@/features/payments/public";

export function OrgAccount({ orgId }: { orgId: string }): ReactElement {
  const base = `/api/v1/orgs/${encodeURIComponent(orgId)}`;
  return (
    <OrgAccountPage
      orgEndpoint={base}
      spendEndpoint={`${base}/spend`}
      formatBalance={(credits) => `$${creditsToUsd(credits).toFixed(2)}`}
      fundHref={(billingAccountId: string) => `/credits?billingAccountId=${encodeURIComponent(billingAccountId)}&orgId=${encodeURIComponent(orgId)}`}
    />
  );
}
