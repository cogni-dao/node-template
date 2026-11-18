// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/auth/siwe-verify`
 * Purpose: The one server-side SIWE verification. NextAuth login (`@/auth`) and the wallet bind route both call it, so a signature
 *   means the same thing on every door.
 * Scope: Parses the message and checks the domain, the signature and (when given) the nonce. No database, no session, no nonce store:
 *   whoever calls it decides where the nonce came from and consumes it.
 * Invariants:
 *   - ONE_SIWE_VERIFY: no other module constructs a `SiweMessage` to verify a login or a bind.
 *   - NEVER_THROWS: a malformed message or bad signature is `{ ok: false }`, never an exception.
 * Side-effects: none
 * @public
 */

import { SiweMessage } from "siwe";

export type SiweVerifyResult =
	| {
			readonly ok: true;
			/** EIP-55 checksummed address the signature proves control of. */
			readonly address: string;
			/** The nonce inside the signed message. */
			readonly nonce: string;
	  }
	| { readonly ok: false; readonly error: string };

function nodeUrl(): URL {
	return new URL(process.env.NEXTAUTH_URL ?? "http://localhost:3000");
}

/** The host this node signs for: the same value NextAuth login has always verified against. */
export function siweDomain(): string {
	return nodeUrl().host;
}

/** The origin a challenge names as the message `uri`. */
export function siweOrigin(): string {
	return nodeUrl().origin;
}

/**
 * Verify a SIWE message and signature. Pass `nonce` to require an exact match (login: the CSRF token); omit it when the
 * caller redeems the nonce from its own store afterwards (wallet bind).
 */
export async function verifySiwe(input: {
	message: string;
	signature: string;
	domain: string;
	nonce?: string;
}): Promise<SiweVerifyResult> {
	try {
		const siwe = new SiweMessage(input.message);
		const result = await siwe.verify({
			signature: input.signature,
			domain: input.domain,
			...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
		});
		if (!result.success) {
			return {
				ok: false,
				error: String(result.error?.type ?? "verification_failed"),
			};
		}
		const { address, nonce } = result.data;
		return { ok: true, address, nonce };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : "invalid_message",
		};
	}
}
