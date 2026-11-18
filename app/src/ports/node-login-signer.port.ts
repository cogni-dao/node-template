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

/**
 * The shape of lane B1's shared SIWE challenge and verify-and-bind (POST /api/v1/identity/wallet/challenge and /bind).
 * B1's implementation satisfies this; this lane only consumes it. Evidence and createBinding stay inside B1.
 */
export interface NodeAiWalletBinder {
	challenge(input: {
		principalUserId: string;
		address: string;
	}): Promise<string>;
	verifyAndBind(input: {
		principalUserId: string;
		message: string;
		signature: string;
	}): Promise<{ bound: boolean }>;
}

/** Bind the node AI's wallet to its internal principal: challenge, sign (own domain only), verify and bind. */
export async function bindNodeAiWallet(
	signer: NodeLoginSignerPort,
	binder: NodeAiWalletBinder,
	principalUserId: string,
): Promise<{ bound: boolean; address: string }> {
	const address = await signer.getAddress();
	const message = await binder.challenge({ principalUserId, address });
	const signed = await signer.signLogin(message);
	const { bound } = await binder.verifyAndBind({
		principalUserId,
		message,
		signature: signed.signature,
	});
	return { bound, address: signed.address };
}
