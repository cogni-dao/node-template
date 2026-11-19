// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/connections/Connections.mount`
 * Purpose: Client mount for the shared `ConnectionsSection` (`@cogni-dao/knowledge-base-ui`) with this node's route. The table and its hook live in the package.
 * Scope: Renders the section only. Does not decide who is an admin.
 * Invariants: HUMAN_ROUTES_SESSION_ONLY, NON_ADMIN_SEES_NOTHING.
 * Side-effects: IO (the section's fetches to the admin route)
 * Links: story.0038
 * @internal
 */

"use client";

import { ConnectionsSection } from "@cogni/knowledge-base-ui";
import type { ReactElement } from "react";

import { CONNECTION_MONEY } from "../connection-money";
import { CONNECTIONS_ENDPOINTS } from "./connections-endpoints";

export function ConnectionsMount(): ReactElement {
	return <ConnectionsSection endpoints={CONNECTIONS_ENDPOINTS} money={CONNECTION_MONEY} />;
}
