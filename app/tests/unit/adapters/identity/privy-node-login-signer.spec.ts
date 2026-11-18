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

const NODE_DOMAIN = "node.example.com";
const CHAIN = 8453;
const AI = newAddress();
const OPERATOR = newAddress();

function newAddress(): string {
	return privateKeyToAccount(generatePrivateKey()).address;
}

function siwe(
	over: {
		domain?: string;
		uri?: string;
		address?: string;
		chainId?: number;
		resources?: string[];
	} = {},
): string {
	const domain = over.domain ?? NODE_DOMAIN;
	return new SiweMessage({
		domain,
		address: over.address ?? AI,
		statement: "Sign in",
		uri: over.uri ?? `https://${domain}`,
		version: "1",
		chainId: over.chainId ?? CHAIN,
		nonce: "abcdefgh12345678",
		...(over.resources ? { resources: over.resources } : {}),
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

function signer() {
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
			chainId: CHAIN,
			forbiddenAddresses: [OPERATOR],
		}),
	};
}

describe("node AI login signer", () => {
	it("refuses a SIWE message for another domain, so a phishing site cannot get a login signature (and Privy is never asked)", async () => {
		const { signer: s, signMessage } = signer();
		await expect(
			s.signLogin(siwe({ domain: "evil.example.org" })),
		).rejects.toMatchObject({ reason: "foreign_domain" });
		expect(signMessage).not.toHaveBeenCalled();
	});

	it("refuses a message for another chain, so a signature for one chain cannot be replayed as this node's login", async () => {
		const { signer: s, signMessage } = signer();
		await expect(s.signLogin(siwe({ chainId: 1 }))).rejects.toMatchObject({
			reason: "foreign_chain",
		});
		expect(signMessage).not.toHaveBeenCalled();
	});

	it("refuses a message whose uri points at another host even when the domain line is ours", async () => {
		const { signer: s } = signer();
		await expect(
			s.signLogin(siwe({ uri: "https://evil.example.org/login" })),
		).rejects.toMatchObject({ reason: "foreign_uri" });
	});

	it("refuses a message that carries resources, which could smuggle extra grants into a login signature", async () => {
		const { signer: s } = signer();
		await expect(
			s.signLogin(siwe({ resources: ["https://evil.example.org/grant"] })),
		).rejects.toMatchObject({ reason: "unexpected_resources" });
	});

	it("signs a message for this node's own domain and chain with the dedicated wallet", async () => {
		const { signer: s, signMessage } = signer();
		const out = await s.signLogin(siwe());
		expect(out).toEqual({ address: AI, signature: "0xsig" });
		expect(signMessage).toHaveBeenCalledWith("ai-wallet", expect.any(String));
	});

	it("refuses a message that names a different address than the AI wallet, so it cannot sign as someone else", async () => {
		const { signer: s } = signer();
		await expect(s.signLogin(siwe({ address: OPERATOR }))).rejects.toMatchObject(
			{ reason: "address_mismatch" },
		);
	});

	it("refuses to be built on the operator wallet address in any casing or padding, so the payout wallet can never become a login wallet", () => {
		const { client } = fakeClient([{ id: "op-wallet", address: OPERATOR }]);
		expect(
			() =>
				new PrivyNodeLoginSigner({
					client,
					walletAddress: OPERATOR.toLowerCase(),
					domain: NODE_DOMAIN,
					chainId: CHAIN,
					forbiddenAddresses: [` ${OPERATOR.toUpperCase().replace("0X", "0x")} `],
				}),
		).toThrow(/NOT_THE_OPERATOR_WALLET/);
	});

	it("refuses the operator's Privy authorization key even with stray whitespace, and an empty key", () => {
		const base = { appId: "app", appSecret: "secret" };
		expect(() =>
			privyLoginClient({
				...base,
				signingKey: "wallet-auth:operator\n",
				forbiddenSigningKeys: ["wallet-auth:operator"],
			}),
		).toThrow(/NOT_THE_OPERATOR_WALLET/);
		expect(() =>
			privyLoginClient({ ...base, signingKey: "  ", forbiddenSigningKeys: [] }),
		).toThrow(/NOT_THE_OPERATOR_WALLET/);
	});
});
