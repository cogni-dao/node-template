// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/identity/bindings/import/start`
 * Purpose: Starts the operator-attested GitHub binding round trip.
 * Scope: Mints a session-owned consume-once nonce and returns a broker URL
 *   bound to this repo-spec node UUID and this node's canonical profile URL.
 * Invariants: No client-supplied node id or return URL; configured origins only.
 * Side-effects: IO (link transaction insert)
 * @public
 */

import {
	IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
	IdentityAttestationOriginSchema,
	identityAttestationStartOperation,
} from "@cogni/node-contracts";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
	createIdentityAttestationNonce,
	createSigninChallenge,
} from "@/app/_facades/identity/operator-attested-binding.server";
import { getOperatorIssuerUrl } from "@/app/_lib/auth/operator-attestation";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env/server";
import {
	SIGNIN_CHALLENGE_COOKIE,
	SIGNIN_CHALLENGE_TTL_SECONDS,
} from "@/shared/identity/signin-challenge";
import { SIGNIN_COMPLETE_PATH } from "@/shared/identity/signin-paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function configuredNodeOrigin(): string | null {
	const configured = serverEnv().APP_BASE_URL;
	if (!configured) return null;
	const parsed = IdentityAttestationOriginSchema.safeParse(configured);
	return parsed.success ? parsed.data : null;
}

export const POST = wrapRouteHandlerWithLogging(
	{
		routeId: "identity.attestation.start.v1",
		// Optional, not required. A signed-in caller is LINKING GitHub to their existing
		// user; a signed-out caller is SIGNING IN with it. Gating this leg on a session is
		// what made a wallet the only door onto a node (task.5042) — the attestation could
		// only ever attach to a user who had already arrived some other way.
		//
		// An AI bearer key is a signed-in caller too: it gets a nonce owned by its own principal (task.0091). A bearer that does not
		// resolve is refused, never downgraded to a sign-in challenge (BEARER_CLAIMS_EXCLUSIVE).
		bearerWrite:
			"mints a one-time nonce owned by the caller and touches no one else's data; binding it still needs the operator's GitHub attestation",
		auth: { mode: "optional", getSessionUser },
	},
	async (_ctx, request, sessionUser) => {
		if (!sessionUser && request.headers.get("authorization")) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}
		const nodeOrigin = configuredNodeOrigin();
		if (!nodeOrigin) {
			return NextResponse.json(
				{ errorCode: "node_origin_unavailable" },
				{ status: 503 },
			);
		}

		const nodeId = getNodeId();
		let issuer: string;
		try {
			issuer = getOperatorIssuerUrl();
		} catch {
			return NextResponse.json(
				{ errorCode: "operator_issuer_unavailable" },
				{ status: 503 },
			);
		}
		// Two modes, one route, chosen by session presence — a second start leg would
		// drift from this one's origin + protocol checks.
		let nonce: string;
		let returnPath: string;
		if (sessionUser) {
			nonce = await createIdentityAttestationNonce(sessionUser.id);
			returnPath = "/profile";
		} else {
			const challenge = await createSigninChallenge();
			nonce = challenge.nonce;
			returnPath = SIGNIN_COMPLETE_PATH;
			(await cookies()).set(SIGNIN_CHALLENGE_COOKIE, challenge.nonce, {
				httpOnly: true,
				secure: nodeOrigin.startsWith("https://"),
				// Lax survives the operator's top-level redirect back to us.
				sameSite: "lax",
				// Origin-wide on purpose. The completion PAGE reads the fragment, but the
				// cookie has to reach NextAuth's `/api/auth/callback/<provider>` endpoint,
				// which is where authorize() compares it to the attestation's nonce claim.
				// Scoping it to the completion path would mean it is never sent at all.
				path: "/",
				maxAge: SIGNIN_CHALLENGE_TTL_SECONDS,
			});
		}
		const authorizeUrl = new URL("/identity/attest", issuer);
		authorizeUrl.searchParams.set(
			"protocol",
			IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
		);
		authorizeUrl.searchParams.set("node_id", nodeId);
		authorizeUrl.searchParams.set("nonce", nonce);
		authorizeUrl.searchParams.set("target_origin", nodeOrigin);
		authorizeUrl.searchParams.set("return_to", `${nodeOrigin}${returnPath}`);

		return NextResponse.json(
			identityAttestationStartOperation.output.parse({
				authorizeUrl: authorizeUrl.toString(),
			}),
		);
	},
);
