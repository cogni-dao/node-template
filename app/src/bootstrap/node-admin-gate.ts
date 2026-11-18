// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/node-admin-gate`
 * Purpose: This node's implementation of the shared `NodeAdminAuthority` seam
 *   (`@cogni/knowledge-store`) — the one check behind the goal-layer
 *   privileges: merging a goal-layer change and setting priority <= 1.
 * Scope: Composition only. This node has no OpenFGA, so the authority is the
 *   existing node-local admin seam `isDaoAdmin` (repo-spec
 *   `activity_ledger.approvers` + steward wallet), the same check that gates
 *   `(admin)/` and attribution writes. When this node adopts OpenFGA, swap this
 *   factory for a `node.administer` authority; no caller changes.
 * Invariants:
 *   - GOAL_CHANGE_IS_NODE_ADMIN / P0P1_IS_NODE_ADMIN (enforced by callers via the seam).
 *   - FAIL_CLOSED_WITH_DISTINCTION: no wallet / non-admin → `authz_denied`;
 *     no configured admin wallets → `authz_unavailable`.
 * Side-effects: none (reads cached repo-spec config)
 * Links: https://cognidao.org/work/items/story.5101, src/shared/config/repoSpec.server.ts
 * @public
 */

import type { AdminCheck } from "@cogni/agent-grants";
import type { NodeAdminAuthority } from "@cogni/knowledge-store";
import { getLedgerApprovers, isDaoAdmin } from "@/shared/config";

/** Repo-spec admin wallets as this node's `NodeAdminAuthority`. */
export function createApproversNodeAdminAuthority(): NodeAdminAuthority {
	return {
		async check(actor) {
			if (getLedgerApprovers().length === 0) {
				return {
					ok: false,
					errorCode: "authz_unavailable",
					reason: "no_node_admins_configured",
				};
			}
			return isDaoAdmin(actor.walletAddress)
				? { ok: true }
				: { ok: false, errorCode: "authz_denied" };
		},
	};
}

/**
 * The knowledge merge and close gate as the one admin check (ONE_ADMIN_CHECK): a user passes when `adminCheck` allows its user id, which
 * reads the wallets bound to that user, so a session and a bearer holding the same listed wallet get the same answer. `adminCheck` is a
 * thunk because the agent authority is built after the knowledge service.
 */
export function createAdminCheckNodeAdminAuthority(adminCheck: () => AdminCheck): NodeAdminAuthority {
	return {
		async check(actor) {
			const decision = await adminCheck()(actor.userId);
			if (decision === "allow") return { ok: true };
			if (decision === "unavailable") {
				return { ok: false, errorCode: "authz_unavailable", reason: "admin_check_unavailable" };
			}
			return { ok: false, errorCode: "authz_denied" };
		},
	};
}
