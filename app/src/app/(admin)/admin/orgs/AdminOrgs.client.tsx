// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/orgs/AdminOrgs.client`
 * Purpose: Client mount of the package's `AdminOrgAccounts` with the admin-area routes.
 * Scope: Binding only. The routes run the one admin check; this decides nothing.
 * Side-effects: IO (the table's fetches)
 * Links: src/app/api/v1/admin/orgs/route.ts
 * @internal
 */

"use client";

import { AdminOrgAccounts } from "@cogni/knowledge-base-ui/orgs";
import type { ReactElement } from "react";

export function AdminOrgs(): ReactElement {
  return <AdminOrgAccounts endpoint="/api/v1/admin/orgs" suspensionEndpoint={(orgUserId) => `/api/v1/admin/orgs/${encodeURIComponent(orgUserId)}/suspension`} />;
}
