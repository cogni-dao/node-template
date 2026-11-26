// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/connections/OrgConnections.client`
 * Purpose: Client mount of the package's `OrgConnectionsPage` with the admin-area connections route.
 * Scope: Binding only. The route runs the one admin check; this decides nothing.
 * Side-effects: IO (the page's fetches)
 * Links: src/app/api/v1/admin/org-connections/route.ts
 * @internal
 */

"use client";

import { OrgConnectionsPage } from "@cogni/knowledge-base-ui/orgs";
import type { ReactElement } from "react";

export function OrgConnections(): ReactElement {
  return <OrgConnectionsPage endpoint="/api/v1/admin/org-connections" />;
}
