// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/node-admin-gate`
 * Purpose: The ONE node-admin check for the goal-layer privileges (story.5101,
 *   dao-goals-design): merging a `goal-*` hub change and setting work-item
 *   priority 0/1. Each runs before the side effect.
 * Scope: Pure helper. This node has no OpenFGA, so the authority is the
 *   existing node-local admin seam `isDaoAdmin` (repo-spec
 *   `activity_ledger.approvers` + steward wallet), the same check that gates
 *   `(admin)/` and attribution writes. No new role or authority. When this node
 *   adopts OpenFGA, only the body of `checkNodeAdmin` swaps to a
 *   `node.administer` check; callers and the decision shape stay put.
 * Invariants:
 *   - GOAL_CHANGE_IS_NODE_ADMIN / P0P1_IS_NODE_ADMIN.
 *   - CHECK_BEFORE_SIDE_EFFECT: callers run this before any write.
 *   - FAIL_CLOSED_WITH_DISTINCTION: deny → 403 `authz_denied`; no configured
 *     admin set → 503 `authz_unavailable`. Never conflated.
 * Side-effects: none (reads cached repo-spec config)
 * Links: https://cognidao.org/work/items/story.5101, src/shared/config/repoSpec.server.ts
 * @public
 */

import { getLedgerApprovers, isDaoAdmin } from "@/shared/config";

export type NodeAdminDenied = {
	readonly ok: false;
	readonly status: 403;
	readonly errorCode: "authz_denied";
};

export type NodeAdminUnavailable = {
	readonly ok: false;
	readonly status: 503;
	readonly errorCode: "authz_unavailable";
	readonly reason: string;
};

export type NodeAdminGate =
	| { readonly ok: true }
	| NodeAdminDenied
	| NodeAdminUnavailable;

const DENIED: NodeAdminDenied = {
	ok: false,
	status: 403,
	errorCode: "authz_denied",
};

export function nodeAdminUnavailable(reason: string): NodeAdminUnavailable {
	return { ok: false, status: 503, errorCode: "authz_unavailable", reason };
}

/** Priority 0 and 1 are the node-admin tier (P0P1_IS_NODE_ADMIN); 2+ stays open. */
export function isPrivilegedPriority(
	priority: number | null | undefined,
): boolean {
	return priority === 0 || priority === 1;
}

/** The acting principal: a SIWE session carries a wallet; an agent key does not. */
export interface NodeAdminActor {
	readonly userId: string;
	readonly walletAddress: string | null | undefined;
}

/** Decide whether `actor` is this node's admin. */
export function checkNodeAdmin(actor: NodeAdminActor): NodeAdminGate {
	if (getLedgerApprovers().length === 0) {
		return nodeAdminUnavailable("no_node_admins_configured");
	}
	return isDaoAdmin(actor.walletAddress) ? { ok: true } : DENIED;
}

/** JSON body for a failed gate — the same vocabulary as the operator's node-scoped routes. */
export function nodeAdminFailureBody(
	gate: NodeAdminDenied | NodeAdminUnavailable,
	action: string,
): { error: string; errorCode: string; action: string } {
	return gate.errorCode === "authz_denied"
		? { error: "not authorized", errorCode: gate.errorCode, action }
		: {
				error: "authorization unavailable",
				errorCode: gate.errorCode,
				action,
			};
}
