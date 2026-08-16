// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/identity`
 * Purpose: Composition helper binding the service-role DB to the identity
 *   adapter for operator-attested GitHub binding imports (task.5024).
 * Scope: Owns the already_bound / already_linked / created decision against
 *   user_bindings and delegates the write to createBinding. Does NOT verify
 *   attestations (see app/_lib/auth/operator-attestation) or handle HTTP.
 * Invariants:
 *   - NO_AUTO_MERGE: a github id bound to a different user is never re-pointed;
 *     callers surface it as 409 already_linked. Re-checked after insert so a
 *     lost ON CONFLICT race cannot report "created" for a foreign binding.
 *   - BINDINGS_ARE_EVIDENCED: writes go through createBinding (binding +
 *     identity_events in one transaction); evidence carries method
 *     `operator_attestation` + issuer + jti.
 * Side-effects: IO (service-role database reads/writes)
 * Links: src/adapters/server/identity/create-binding.ts, src/app/api/v1/identity/bindings/import/route.ts
 * @public
 */

import { and, eq } from "drizzle-orm";

import { getServiceDb } from "@/adapters/server/db/drizzle.service-client";
import { createBinding } from "@/adapters/server/identity/create-binding";
import { userBindings } from "@/shared/db/schema";

export type ImportAttestedBindingResult =
	| "created"
	| "already_bound"
	| "already_linked";

/**
 * Imports an operator-attested GitHub binding for `userId`.
 * Idempotent: same (github, id) → already_bound; foreign owner → already_linked.
 */
export async function importAttestedGithubBinding(params: {
	userId: string;
	githubId: string;
	githubLogin: string;
	issuer: string;
	jti: string;
	iat: number;
}): Promise<ImportAttestedBindingResult> {
	const db = getServiceDb();
	const { userId, githubId, githubLogin } = params;

	const ownedBy = () =>
		db.query.userBindings.findFirst({
			where: and(
				eq(userBindings.provider, "github"),
				eq(userBindings.externalId, githubId),
			),
		});

	const existing = await ownedBy();
	if (existing) {
		if (existing.userId !== userId) return "already_linked";
		// Refresh login metadata (non-critical, mirrors auth.ts OAuth path)
		await db
			.update(userBindings)
			.set({ providerLogin: githubLogin })
			.where(eq(userBindings.id, existing.id));
		return "already_bound";
	}

	await createBinding(db, userId, "github", githubId, {
		method: "operator_attestation",
		issuer: params.issuer,
		jti: params.jti,
		login: githubLogin,
		iat: params.iat,
	});

	// createBinding is ON CONFLICT DO NOTHING — re-read to detect a lost race
	// against a concurrent bind of the same github id (NO_AUTO_MERGE).
	const bound = await ownedBy();
	if (!bound || bound.userId !== userId) return "already_linked";

	await db
		.update(userBindings)
		.set({ providerLogin: githubLogin })
		.where(eq(userBindings.id, bound.id));

	return "created";
}
