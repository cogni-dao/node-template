// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/connections/page`
 * Purpose: CUSTOMER side of connect from home (story.0038): the other nodes this node is set up to use, where its admin connects with a cap or disconnects (ADMIN_ACTS_IN_ADMIN).
 *   Helps an admin decide which provider this node may spend on, and how much.
 * Scope: Server component. Access gated upstream by `(admin)/layout.tsx` (non-admins redirect to /dashboard); the route behind the table runs the same admin check. Adds no authority logic.
 * Invariants: HUMAN_ROUTES_SESSION_ONLY, NON_ADMIN_SEES_NOTHING.
 * Side-effects: none (server render only)
 * Links: story.0038, src/app/api/v1/admin/connections/route.ts
 * @public
 */

import type { ReactElement } from "react";

import { PageContainer } from "@/components";

import { ConnectionsClient } from "./Connections.client";

export default function ConnectionsPage(): ReactElement {
	return (
		<PageContainer maxWidth="2xl">
			<p className="max-w-prose text-muted-foreground">
				Connect this node to another node so its AI can run there, paid from your cap.
			</p>
			<ConnectionsClient />
		</PageContainer>
	);
}
