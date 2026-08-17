// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/identity`
 * Purpose: Composition helper binding the service-role DB to the identity
 *   adapter for operator-attested GitHub binding imports (task.5024).
 * Scope: Owns the nonce redemption + already_bound / already_linked / created
 *   decision against user_bindings in one transaction. Does NOT verify
 *   attestations (see app/_lib/auth/operator-attestation) or handle HTTP.
 * Invariants:
 *   - NO_AUTO_MERGE: a github id bound to a different user is never re-pointed;
 *     callers surface it as 409 already_linked. Re-checked after insert so a
 *     lost ON CONFLICT race cannot report "created" for a foreign binding.
 *   - BINDINGS_ARE_EVIDENCED: writes go through createBindingInTransaction;
 *     evidence carries method
 *     `operator_attestation` + issuer + jti.
 * Side-effects: IO (service-role database reads/writes)
 * Links: src/adapters/server/identity/create-binding.ts, src/app/api/v1/identity/bindings/import/route.ts
 * @public
 */

import { randomUUID } from "node:crypto";

import { IDENTITY_ATTESTATION_TTL_SECONDS } from "@cogni/node-contracts";
import { and, eq, gt, isNull } from "drizzle-orm";

import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";
import { createBindingInTransaction } from "@/adapters/server/identity/create-binding";
import { linkTransactions, userBindings } from "@/shared/db/schema";

// Give the browser round trip five minutes before token issuance while still
// guaranteeing that any freshly-issued 10 minute attestation can be redeemed.
export const ATTESTATION_NONCE_TTL_MS =
	(IDENTITY_ATTESTATION_TTL_SECONDS + 5 * 60) * 1000;

/** Mint a session-owned, durable, opaque nonce for one attestation round trip. */
export async function createIdentityAttestationNonce(
	userId: string,
): Promise<string> {
	const nonce = randomUUID();
	await getServiceDb().insert(linkTransactions).values({
		id: nonce,
		userId,
		provider: "github",
		expiresAt: new Date(Date.now() + ATTESTATION_NONCE_TTL_MS),
	});
	return nonce;
}

export type RedeemAttestedBindingResult =
	| "created"
	| "already_bound"
	| "already_linked"
	| "invalid_nonce";

/**
 * Atomically redeems one user-owned nonce and imports an operator-attested
 * GitHub binding. Terminal outcomes (created/already_bound/already_linked)
 * commit nonce consumption; thrown infrastructure failures roll it back.
 */
export async function redeemAttestedGithubBinding(params: {
	userId: string;
	nonce: string;
	githubId: string;
	githubLogin: string | null;
	issuer: string;
	jti: string;
	iat: number;
}): Promise<RedeemAttestedBindingResult> {
	const db = getServiceDb();
	const { userId, githubId, githubLogin } = params;

	return db.transaction(async (tx) => {
		// This conditional UPDATE is the concurrency gate: at most one redemption
		// can transition this nonce from unconsumed to consumed.
		const [consumed] = await tx
			.update(linkTransactions)
			.set({ consumedAt: new Date() })
			.where(
				and(
					eq(linkTransactions.id, params.nonce),
					eq(linkTransactions.userId, userId),
					eq(linkTransactions.provider, "github"),
					isNull(linkTransactions.consumedAt),
					gt(linkTransactions.expiresAt, new Date()),
				),
			)
			.returning({ id: linkTransactions.id });
		if (!consumed) return "invalid_nonce";

		const ownedBy = () =>
			tx.query.userBindings.findFirst({
				where: and(
					eq(userBindings.provider, "github"),
					eq(userBindings.externalId, githubId),
				),
			});

		const existing = await ownedBy();
		if (existing) {
			if (existing.userId !== userId) return "already_linked";
			await tx
				.update(userBindings)
				.set({ providerLogin: githubLogin })
				.where(eq(userBindings.id, existing.id));
			return "already_bound";
		}

		await createBindingInTransaction(tx, userId, "github", githubId, {
			method: "operator_attestation",
			issuer: params.issuer,
			jti: params.jti,
			login: githubLogin,
			iat: params.iat,
		});

		// ON CONFLICT DO NOTHING may lose to a concurrent foreign bind. The
		// re-read makes that a terminal conflict without ever re-pointing it.
		const bound = await ownedBy();
		if (!bound || bound.userId !== userId) return "already_linked";

		await tx
			.update(userBindings)
			.set({ providerLogin: githubLogin })
			.where(eq(userBindings.id, bound.id));

		return "created";
	});
}
