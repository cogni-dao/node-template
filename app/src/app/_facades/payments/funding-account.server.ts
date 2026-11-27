// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/payments/funding-account.server`
 * Purpose: The one place a payment route names the account it credits: the caller's own account, or an org account identity admits.
 * Scope: Server-only. Delegates the org decision to identity (`resolveFundingAccount`, org:admin only); holds no role logic, no payment logic.
 * Invariants: ONE_LEDGER_MANY_RAILS (every rail names its account here); the caller's own path is unchanged; an org account is written under the org user's row-level-security scope.
 * Side-effects: IO (identity lookup, billing account read)
 * Links: https://node-template.cognidao.org/knowledge/org-funding-design
 * @public
 */

import { OrgAccountError } from "@cogni/agent-grants/org-accounts";
import { toUserId, type UserId } from "@cogni/ids";
import { usdCentsToCredits } from "@cogni/node-core";
import type { SessionUser } from "@cogni/node-shared";
import type { Container } from "@/bootstrap/container";
import type { PostCreditFundingDeps } from "@/features/payments/application/confirmCreditsPurchase";
import { AuthUserNotFoundError } from "@/features/payments/errors";
import { getOrCreateBillingAccountForUser } from "@/lib/auth/mapping";

/**
 * The account a payment credits and the user whose row-level-security scope writes it.
 * No `billingAccountId`: the caller's own account (unchanged). An org account: identity's
 * `resolveFundingAccount` decides (org:admin only) and names the scope; billing holds no role logic.
 */
export async function resolvePaymentAccount(
	container: Container,
	sessionUser: SessionUser,
	billingAccountId: string | undefined,
): Promise<{
	rlsUserId: UserId;
	billingAccount: Awaited<ReturnType<typeof getOrCreateBillingAccountForUser>>;
	orgFunding: boolean;
}> {
	let scope = sessionUser.id;
	if (billingAccountId) {
		// Org funding is a person's act: a bearer agent (API key) never funds or reads an org's payments.
		if (sessionUser.via !== "session") {
			throw new OrgAccountError("not_allowed", "not allowed to fund this account");
		}
		const funding = await container.agentAuthority.resolveFundingAccount({
			userId: sessionUser.id,
			billingAccountId,
		});
		scope = funding.chargeScopeUserId;
	}
	const rlsUserId = toUserId(scope);
	const own = scope === sessionUser.id;
	try {
		const billingAccount = await getOrCreateBillingAccountForUser(
			container.accountsForUser(rlsUserId),
			{
				userId: scope,
				...(own && sessionUser.walletAddress
					? { walletAddress: sessionUser.walletAddress }
					: {}),
			},
		);
		if (billingAccountId && billingAccount.id !== billingAccountId) {
			throw new OrgAccountError("not_allowed", "not allowed to fund this account");
		}
		return { rlsUserId, billingAccount, orgFunding: !own };
	} catch (error) {
		// Check for FK constraint violation (user not found in DB)
		// Drizzle wraps Postgres errors - constraint name is in cause.message
		if (
			error &&
			typeof error === "object" &&
			((error instanceof Error &&
				error.message.includes("billing_accounts_owner_user_id_users_id_fk")) ||
				("cause" in error &&
					error.cause instanceof Error &&
					error.cause.message.includes("billing_accounts_owner_user_id_users_id_fk")))
		) {
			throw new AuthUserNotFoundError(sessionUser.id);
		}
		throw error;
	}
}

/**
 * After an org account is credited, append `org.funded` to the org's history (identity's EVERY_ACT_LOGGED).
 * The actor is the person who created the attempt, never whoever's poll triggered verification;
 * `fallbackActorUserId` (the caller) covers only an attempt created before its creator was recorded.
 */
export function orgFundedLogger(
	container: Container,
	fallbackActorUserId: string,
): NonNullable<PostCreditFundingDeps["onCredited"]> {
	return (credited) =>
		container.agentAuthority.logOrgFunded({
			orgBillingAccountId: credited.billingAccountId,
			actorUserId: credited.createdByUserId ?? fallbackActorUserId,
			amountCredits: Number(usdCentsToCredits(credited.amountUsdCents)),
			paymentRef: credited.paymentRef,
		});
}
