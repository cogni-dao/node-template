// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/connected-orgs/page`
 * Purpose: PROVIDER side of connect from home (story.0038): the customer nodes that connected to this node, where its admin funds them and can Suspend them (ADMIN_ACTS_IN_ADMIN).
 *   Helps an admin decide how much each connected node may spend and whether to stop one.
 * Scope: Server component. Access gated upstream by `(admin)/layout.tsx` (non-admins redirect to /dashboard); the routes behind the table run the same admin check. Adds no authority logic.
 * Invariants: HUMAN_ROUTES_SESSION_ONLY, NON_ADMIN_SEES_NOTHING.
 * Side-effects: none (server render only)
 * Links: story.0038, src/app/api/v1/admin/connected-orgs/route.ts
 * @public
 */

import type { ReactElement } from "react";

import { PageContainer } from "@/components";

import { ConnectedOrgsClient } from "./ConnectedOrgs.client";

export default function ConnectedOrgsPage(): ReactElement {
	return (
		<PageContainer maxWidth="2xl">
			<p className="max-w-prose text-muted-foreground">
				Nodes that connected to this node can run AI here, paid from the allowance you grant them.
			</p>
			<ConnectedOrgsClient />
		</PageContainer>
	);
}
