// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/connected-orgs/ConnectedOrgs.mount`
 * Purpose: Client mount for the shared `ConnectedOrgsSection` (`@cogni-dao/knowledge-base-ui`) with this node's route. The table, its hook and its paging live in the package.
 * Scope: Renders the section only. Does not decide who is an admin.
 * Invariants: HUMAN_ROUTES_SESSION_ONLY, NON_ADMIN_SEES_NOTHING.
 * Side-effects: IO (the section's fetches to the admin routes)
 * Links: story.0038
 * @internal
 */

"use client";

import { ConnectedOrgsSection } from "@cogni/knowledge-base-ui";
import type { ReactElement } from "react";

import { CONNECTION_MONEY } from "../connection-money";
import { CONNECTED_ORGS_ENDPOINTS } from "./connected-orgs-endpoints";

export function ConnectedOrgsMount(): ReactElement {
	return <ConnectedOrgsSection endpoints={CONNECTED_ORGS_ENDPOINTS} money={CONNECTION_MONEY} />;
}
