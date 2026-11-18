// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@ports/node-login-signer`
 * Purpose: The node's own AI proves a wallet the way a human does: it signs a Sign-In-With-Ethereum message for this node.
 * Scope: Interfaces and the refusal error only. Does not verify or bind; those are the shared SIWE verify and the bind route (lane B1).
 * Invariants:
 *   - OWN_DOMAIN_ONLY: `signLogin` signs a SIWE message whose domain is this node's own domain, and refuses every other (fail closed).
 *   - NOT_THE_OPERATOR_WALLET: an implementation never signs with the operator (payout) wallet; that plane stays separate.
 *   - NO_GENERIC_SIGNING: the only signing method is `signLogin`. There is no signMessage or signTypedData here.
 * Side-effects: none (interface definition only)
 * Links: https://cognidao.org/knowledge/identity-keys-no-overload, work item task.0142
 * @public
 */

export type NodeLoginRefusal =
	| "malformed_message"
	| "foreign_domain"
	| "foreign_chain"
	| "foreign_uri"
	| "unexpected_resources"
	| "address_mismatch";

export class NodeLoginRefusedError extends Error {
	constructor(readonly reason: NodeLoginRefusal) {
		super(`node login signing refused: ${reason}`);
		this.name = "NodeLoginRefusedError";
	}
}

export interface NodeLoginSignerPort {
	/** The node AI wallet's public address (checksummed). Public data; needed to ask for a challenge. */
	getAddress(): Promise<string>;
	/** Sign a SIWE message for THIS node's domain. Throws `NodeLoginRefusedError` for anything else. */
	signLogin(
		siweMessage: string,
	): Promise<{ address: string; signature: string }>;
}
