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
	IdentityAttestationOriginSchema,
	IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
	identityAttestationStartOperation,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import { createIdentityAttestationNonce } from "@/app/_facades/identity/operator-attested-binding.server";
import { getOperatorIssuerUrl } from "@/app/_lib/auth/operator-attestation";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env/server";

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
		routeId: identityAttestationStartOperation.id,
		auth: { mode: "required", getSessionUser: getServerSessionUser },
	},
	async (_ctx, _request, sessionUser) => {
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
		const nonce = await createIdentityAttestationNonce(sessionUser.id);
		const authorizeUrl = new URL("/identity/attest", issuer);
		authorizeUrl.searchParams.set(
			"protocol",
			IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
		);
		authorizeUrl.searchParams.set("node_id", nodeId);
		authorizeUrl.searchParams.set("nonce", nonce);
		authorizeUrl.searchParams.set("target_origin", nodeOrigin);
		authorizeUrl.searchParams.set("return_to", `${nodeOrigin}/profile`);

		return NextResponse.json(
			identityAttestationStartOperation.output.parse({
				authorizeUrl: authorizeUrl.toString(),
			}),
		);
	},
);
