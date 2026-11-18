// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/identity/privy-node-login-signer`
 * Purpose: Privy server-wallet adapter for the node AI's dedicated login wallet (NodeLoginSignerPort).
 * Scope: Finds the dedicated wallet in Privy by address and signs one SIWE message for this node. Does not hold key material and does not
 *   touch the operator wallet or the operator-wallet package.
 * Invariants: OWN_DOMAIN_ONLY, NOT_THE_OPERATOR_WALLET (the constructor refuses the operator address; the wallet lookup re-checks it), KEY_NEVER_IN_APP.
 * Side-effects: IO (Privy API: wallet list and personal_sign)
 * Links: app/src/ports/node-login-signer.port.ts
 * @internal
 */

import { PrivyClient } from "@privy-io/node";
import { SiweMessage } from "siwe";
import { getAddress } from "viem";

import {
	NodeLoginRefusedError,
	type NodeLoginSignerPort,
} from "@/ports/node-login-signer.port";

/** The slice of the Privy SDK this adapter uses, so a test can fake it without the network. */
export interface PrivyLoginClient {
	listWallets(): AsyncIterable<{ id: string; address: string }>;
	signMessage(walletId: string, message: string): Promise<string>;
}

export function privyLoginClient(cfg: {
	appId: string;
	appSecret: string;
	/** The node AI wallet's own authorization key. */
	signingKey: string;
	/** Authorization keys it must never use: the operator wallet's (PRIVY_SIGNING_KEY). */
	forbiddenSigningKeys: readonly (string | undefined)[];
}): PrivyLoginClient {
	if (cfg.forbiddenSigningKeys.includes(cfg.signingKey)) {
		throw new Error(
			"[NodeLoginSigner] NOT_THE_OPERATOR_WALLET: the node AI wallet must use its own authorization key, not the operator's",
		);
	}
	const client = new PrivyClient({
		appId: cfg.appId,
		appSecret: cfg.appSecret,
	});
	return {
		listWallets: () => client.wallets().list(),
		signMessage: async (walletId, message) =>
			(
				await client
					.wallets()
					.ethereum()
					.signMessage(walletId, {
						message,
						authorization_context: {
							authorization_private_keys: [cfg.signingKey],
						},
					})
			).signature,
	};
}

export interface PrivyNodeLoginSignerConfig {
	client: PrivyLoginClient;
	/** The dedicated node AI wallet (public address). */
	walletAddress: string;
	/** This node's own domain (host), the only SIWE domain it signs. */
	domain: string;
	/** Addresses it must never sign with: the operator wallet. */
	forbiddenAddresses: readonly string[];
	/** When set, the SIWE chain id must match. */
	chainId?: number;
}

export class PrivyNodeLoginSigner implements NodeLoginSignerPort {
	private readonly address: string;
	private readonly domain: string;
	private walletId: Promise<string> | undefined;

	constructor(private readonly cfg: PrivyNodeLoginSignerConfig) {
		this.address = getAddress(cfg.walletAddress);
		this.domain = cfg.domain.toLowerCase();
		if (this.isForbidden(this.address)) {
			throw new Error(
				"[NodeLoginSigner] NOT_THE_OPERATOR_WALLET: the node AI login wallet must not be the operator wallet",
			);
		}
	}

	private isForbidden(address: string): boolean {
		return this.cfg.forbiddenAddresses.some(
			(f) => f.toLowerCase() === address.toLowerCase(),
		);
	}

	async getAddress(): Promise<string> {
		return this.address;
	}

	async signLogin(
		siweMessage: string,
	): Promise<{ address: string; signature: string }> {
		let parsed: SiweMessage;
		try {
			parsed = new SiweMessage(siweMessage);
		} catch {
			throw new NodeLoginRefusedError("malformed_message");
		}
		if (parsed.domain.toLowerCase() !== this.domain)
			throw new NodeLoginRefusedError("foreign_domain");
		if (this.cfg.chainId !== undefined && parsed.chainId !== this.cfg.chainId)
			throw new NodeLoginRefusedError("foreign_chain");
		if (getAddress(parsed.address) !== this.address)
			throw new NodeLoginRefusedError("address_mismatch");
		const walletId = await this.resolveWalletId();
		const signature = await this.cfg.client.signMessage(walletId, siweMessage);
		return { address: this.address, signature };
	}

	private resolveWalletId(): Promise<string> {
		this.walletId ??= this.findWalletId().catch((error) => {
			this.walletId = undefined; // allow retry
			throw error;
		});
		return this.walletId;
	}

	private async findWalletId(): Promise<string> {
		for await (const wallet of this.cfg.client.listWallets()) {
			const found = getAddress(wallet.address);
			if (found !== this.address) continue;
			if (this.isForbidden(found))
				throw new Error("[NodeLoginSigner] NOT_THE_OPERATOR_WALLET");
			return wallet.id;
		}
		throw new Error(
			`[NodeLoginSigner] Privy has no wallet matching ${this.address}; provision the dedicated node AI wallet first`,
		);
	}
}
