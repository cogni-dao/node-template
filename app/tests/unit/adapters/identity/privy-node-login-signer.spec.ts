// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { SiweMessage } from "siwe";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import {
	type PrivyLoginClient,
	PrivyNodeLoginSigner,
	privyLoginClient,
} from "@/adapters/server/identity/privy-node-login-signer.adapter";
import {
	bindNodeAiWallet,
	NodeLoginRefusedError,
} from "@/ports/node-login-signer.port";

const NODE_DOMAIN = "node.example.com";
const AI = privyAddress();
const OPERATOR = privyAddress();

function privyAddress(): string {
	return privateKeyToAccount(generatePrivateKey()).address;
}

function siwe(domain: string, address = AI): string {
	return new SiweMessage({
		domain,
		address,
		statement: "Sign in",
		uri: `https://${domain}`,
		version: "1",
		chainId: 1,
		nonce: "abcdefgh12345678",
	}).prepareMessage();
}

function fakeClient(wallets: Array<{ id: string; address: string }>) {
	const signMessage = vi.fn(async () => "0xsig");
	const client: PrivyLoginClient = {
		listWallets: async function* () {
			yield* wallets;
		},
		signMessage,
	};
	return { client, signMessage };
}

function signer(forbidden: string[] = [OPERATOR]) {
	const fake = fakeClient([
		{ id: "op-wallet", address: OPERATOR },
		{ id: "ai-wallet", address: AI },
	]);
	return {
		...fake,
		signer: new PrivyNodeLoginSigner({
			client: fake.client,
			walletAddress: AI,
			domain: NODE_DOMAIN,
			forbiddenAddresses: forbidden,
		}),
	};
}

describe("node AI login signer", () => {
	it("refuses a SIWE message for another domain, so a phishing site cannot get a login signature (and Privy is never asked)", async () => {
		const { signer: s, signMessage } = signer();
		await expect(s.signLogin(siwe("evil.example.org"))).rejects.toMatchObject({
			name: NodeLoginRefusedError.name,
			reason: "foreign_domain",
		});
		expect(signMessage).not.toHaveBeenCalled();
	});

	it("signs a message for this node's own domain with the dedicated wallet", async () => {
		const { signer: s, signMessage } = signer();
		const out = await s.signLogin(siwe(NODE_DOMAIN));
		expect(out).toEqual({ address: AI, signature: "0xsig" });
		expect(signMessage).toHaveBeenCalledWith("ai-wallet", expect.any(String));
	});

	it("refuses a message that names a different address than the AI wallet, so it cannot sign as someone else", async () => {
		const { signer: s } = signer();
		await expect(
			s.signLogin(siwe(NODE_DOMAIN, OPERATOR)),
		).rejects.toMatchObject({ reason: "address_mismatch" });
	});

	it("refuses to be built on the operator wallet address, so the payout wallet can never become a login wallet", () => {
		const { client } = fakeClient([{ id: "op-wallet", address: OPERATOR }]);
		expect(
			() =>
				new PrivyNodeLoginSigner({
					client,
					walletAddress: OPERATOR.toLowerCase(),
					domain: NODE_DOMAIN,
					forbiddenAddresses: [OPERATOR],
				}),
		).toThrow(/NOT_THE_OPERATOR_WALLET/);
	});

	it("refuses to use the operator's Privy authorization key", () => {
		expect(() =>
			privyLoginClient({
				appId: "app",
				appSecret: "secret",
				signingKey: "wallet-auth:operator",
				forbiddenSigningKeys: ["wallet-auth:operator"],
			}),
		).toThrow(/NOT_THE_OPERATOR_WALLET/);
	});

	it("binds through the shared verify with a signature only for the node's own challenge", async () => {
		const { signer: s } = signer();
		const verifyAndBind = vi.fn(async () => ({ bound: true }));
		const binder = {
			challenge: async () => siwe("evil.example.org"),
			verifyAndBind,
		};
		await expect(bindNodeAiWallet(s, binder, "user-1")).rejects.toBeInstanceOf(
			NodeLoginRefusedError,
		);
		expect(verifyAndBind).not.toHaveBeenCalled();
	});
});
