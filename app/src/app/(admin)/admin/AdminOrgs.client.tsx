// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/AdminOrgs.client`
 * Purpose: Client mount of the shared `OrgAdminSection`: the node admin's org rows with Suspend.
 * Scope: Mount only. The admin list and the suspend route run the one admin check; the section renders nothing for anyone else.
 * Invariants: ADMIN_ACTS_IN_ADMIN, NON_ADMIN_SEES_NOTHING, SUSPEND_IS_FINAL (there is no Resume).
 * Side-effects: IO (the section's fetches)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @internal
 */

"use client";

import { OrgAdminSection } from "@cogni/knowledge-base-ui";
import type { ReactElement } from "react";

import { ORG_ENDPOINTS } from "@/app/(app)/orgs/org-endpoints";

export function AdminOrgsClient(): ReactElement {
	return <OrgAdminSection endpoints={ORG_ENDPOINTS} />;
}
