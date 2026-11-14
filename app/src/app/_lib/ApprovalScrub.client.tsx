// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/ApprovalScrub.client`
 * Purpose: Mounts the shared `ApprovalFragmentScrub` in the root layout with the router's pathname, so an AI's one-time link opened (or navigated to) on any
 *   page other than `/profile` and `/admin/ai-access` leaves no `#agent-request=` behind in the address bar or history.
 * Scope: Client mount only. Touches only the `agent-request` fragment key.
 * Side-effects: history.replaceState
 * @internal
 */

"use client";

import { ApprovalFragmentScrub } from "@cogni/knowledge-base-ui";
import { usePathname } from "next/navigation";
import type { ReactElement } from "react";

export function ApprovalScrub(): ReactElement {
	return <ApprovalFragmentScrub pathname={usePathname()} />;
}
