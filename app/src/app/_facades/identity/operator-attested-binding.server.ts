// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Thin app wiring for the operator-attested identity binding feature. */

import { resolveIdentityBindingDependencies } from "@/bootstrap/identity";
import {
	createIdentityBindingService,
	type RedeemAttestedBindingResult,
} from "@/features/identity/services/operator-attested-binding";

function service() {
	return createIdentityBindingService(resolveIdentityBindingDependencies());
}

export function createIdentityAttestationNonce(userId: string): Promise<string> {
	return service().createNonce(userId);
}

export function redeemAttestedGithubBinding(params: {
	userId: string;
	nonce: string;
	githubId: string;
	githubLogin: string | null;
	issuer: string;
	jti: string;
	iat: number;
}): Promise<RedeemAttestedBindingResult> {
	return service().redeemGithubBinding(params);
}

export type { RedeemAttestedBindingResult };
