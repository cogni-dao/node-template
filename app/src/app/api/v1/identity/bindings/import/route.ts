// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/identity/bindings/import`
 * Purpose: Imports an operator-attested GitHub binding — lets a contributor who
 *   proved GitHub on the operator hub become claimable on this node without
 *   node-local OAuth (task.5024, fixes bug.5039 class of unresolved claimants).
 * Scope: POST-only. Verifies the attestation JWT (delegated to
 *   operator-attestation verifier), enforces session-wallet === token-wallet,
 *   then writes THIS node's own user_bindings row via bootstrap/identity.
 *   Does not issue attestations (operator's job) or run identity resolution.
 * Invariants:
 *   - SIWE_SESSION_REQUIRED: token alone is useless — a live session for the
 *     attested wallet must present it (replay-safe by construction).
 *   - FAIL_CLOSED: JWKS unreachable → 503 jwks_unavailable, never a silent bind.
 *   - NO_AUTO_MERGE: github id owned by a different user → 409 already_linked.
 *   - NODE_WRITES_OWN_LEDGER: binding + evidence rows are written locally with
 *     provenance {method: operator_attestation, issuer, jti}.
 * Side-effects: IO (remote JWKS fetch, service-role database writes)
 * Links: src/app/_lib/auth/operator-attestation.ts, src/bootstrap/identity.ts, task.5024
 * @public
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { verifyOperatorAttestation } from "@/app/_lib/auth/operator-attestation";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
	consumeIdentityAttestationNonce,
	importAttestedGithubBinding,
} from "@/bootstrap/identity";
import { getServerSessionUser } from "@/lib/auth/server";
import { getNodeId } from "@/shared/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const importBindingBodySchema = z.object({
	token: z.string().min(1),
}).strict();

export const POST = wrapRouteHandlerWithLogging(
	{
		routeId: "identity.bindings.import",
		auth: { mode: "required", getSessionUser: getServerSessionUser },
	},
	async (ctx, request, sessionUser) => {
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
		}

		const parsed = importBindingBodySchema.safeParse(body);
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "Invalid request body", details: parsed.error.issues },
				{ status: 400 },
			);
		}

		const nodeId = getNodeId();
		const verified = await verifyOperatorAttestation(parsed.data.token, nodeId);
		if (!verified.ok) {
			const status = verified.errorCode === "jwks_unavailable" ? 503 : 401;
			ctx.log.warn(
				{ errorCode: verified.errorCode },
				"Attestation verification failed",
			);
			return NextResponse.json({ errorCode: verified.errorCode }, { status });
		}

		// Token is only redeemable by a live session for the attested wallet.
		const sessionWallet = sessionUser.walletAddress?.toLowerCase() ?? null;
		if (!sessionWallet || sessionWallet !== verified.claims.wallet) {
			ctx.log.warn(
				{ errorCode: "wallet_mismatch" },
				"Attestation wallet does not match session wallet",
			);
			return NextResponse.json(
				{ errorCode: "wallet_mismatch" },
				{ status: 403 },
			);
		}

		const consumedNonce = await consumeIdentityAttestationNonce({
			nonce: verified.claims.nonce,
			userId: sessionUser.id,
		});
		if (!consumedNonce) {
			return NextResponse.json(
				{ errorCode: "invalid_token" },
				{ status: 401 },
			);
		}

		const result = await importAttestedGithubBinding({
			userId: sessionUser.id,
			githubId: verified.claims.github.id,
			githubLogin: verified.claims.github.login,
			issuer: verified.claims.issuer,
			jti: verified.claims.jti,
			iat: verified.claims.iat,
		});

		if (result === "already_linked") {
			// NO_AUTO_MERGE: bound to a different user — never re-point.
			return NextResponse.json(
				{ errorCode: "already_linked" },
				{ status: 409 },
			);
		}

		ctx.log.info(
			{
				event: "identity.binding_imported",
				result,
				issuer: verified.claims.issuer,
				jti: verified.claims.jti,
				nodeId,
			},
			"Operator-attested github binding imported",
		);

		if (result === "already_bound") {
			return NextResponse.json(
				{ bound: true, code: "already_bound" },
				{ status: 200 },
			);
		}

		return NextResponse.json({ bound: true }, { status: 201 });
	},
);
