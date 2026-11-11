// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Frozen cross-repository conformance vectors for github.comment.attestation.v1 (task.0095). Operator and node-template hold the same vectors. */

import { createHash } from "node:crypto";

import {
	GITHUB_COMMENT_ATTESTATION_TYP,
	GITHUB_COMMENT_ATTESTATION_V1_PROTOCOL,
	GITHUB_COMMENT_ATTESTATION_V1_PROTOCOL_SHA256,
	GithubCommentAttestationClaimsSchema,
	GithubCommentAttestationRequestSchema,
	IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
	IdentityAttestationClaimsSchema,
} from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

const NODE_ID = "22222222-2222-4222-8222-222222222222";
const NONCE = "node_generated_nonce_0123456789abcdef";

const comment = {
	repo: "cogni-dao/node-template",
	issueNumber: 341,
	issueUrl: "https://api.github.com/repos/cogni-dao/node-template/issues/341",
	commentId: 4242,
	userId: 295942454,
	userType: "User",
	login: "agent-account",
	createdAt: "2026-11-11T10:00:00Z",
	updatedAt: "2026-11-11T10:00:00Z",
	lastEditedAt: null,
	proofLines: [
		"cogni-proof:v1:22222222-2222-4222-8222-222222222222:11111111-1111-4111-8111-111111111111:abcdefghijklmnopqrstuv",
	],
};
const validClaims = {
	type: "github.comment.attestation.v1",
	protocol: GITHUB_COMMENT_ATTESTATION_V1_PROTOCOL_SHA256,
	iss: "https://cognidao.org",
	aud: `urn:cogni:node:${NODE_ID}`,
	nodeId: NODE_ID,
	requestNonce: NONCE,
	result: "found",
	readAt: 1_700_000_000,
	comment,
	iat: 1_700_000_010,
	exp: 1_700_000_130,
	jti: "33333333-3333-4333-8333-333333333333",
};

describe("github.comment.attestation.v1 frozen contract", () => {
	it("matches the fleet-wide protocol fingerprint", () => {
		const digest = createHash("sha256")
			.update(JSON.stringify(GITHUB_COMMENT_ATTESTATION_V1_PROTOCOL))
			.digest("hex");
		expect(digest).toBe(GITHUB_COMMENT_ATTESTATION_V1_PROTOCOL_SHA256);
		expect(GITHUB_COMMENT_ATTESTATION_TYP).toBe(
			"github.comment.attestation+jwt",
		);
	});

	it("accepts the canonical request (no targetOrigin) and found / not_found claims", () => {
		const request = {
			nodeId: NODE_ID,
			requestNonce: NONCE,
			issue: "cogni-dao/node-template#341",
			commentId: 4242,
		};
		expect(
			GithubCommentAttestationRequestSchema.safeParse(request).success,
		).toBe(true);
		expect(
			GithubCommentAttestationClaimsSchema.safeParse(validClaims).success,
		).toBe(true);
		expect(
			GithubCommentAttestationClaimsSchema.safeParse({
				...validClaims,
				result: "not_found",
				comment: null,
			}).success,
		).toBe(true);
	});

	it.each([
		["a targetOrigin", { targetOrigin: "https://node-template.cognidao.org" }],
		["a challengeSecret", { challengeSecret: "x".repeat(43) }],
		["a body", { body: "whole comment" }],
	])("rejects a request with %s", (_name, extra) => {
		const request = {
			nodeId: NODE_ID,
			requestNonce: NONCE,
			issue: "cogni-dao/node-template#341",
			commentId: 4242,
			...extra,
		};
		expect(
			GithubCommentAttestationRequestSchema.safeParse(request).success,
		).toBe(false);
	});

	it("rejects a short nonce, a bad issue and a bad comment id", () => {
		const ok = {
			nodeId: NODE_ID,
			requestNonce: NONCE,
			issue: "cogni-dao/node-template#341",
			commentId: 4242,
		};
		for (const bad of [
			{ requestNonce: "short" },
			{ issue: "../x#1" },
			{ issue: "a/b#0" },
			{ commentId: 0 },
			{ commentId: 1.5 },
		]) {
			expect(
				GithubCommentAttestationRequestSchema.safeParse({ ...ok, ...bad })
					.success,
			).toBe(false);
		}
	});

	it("rejects cross-node audiences, extra claims, an extra comment field, more than 5 lines and a found/comment mismatch", () => {
		const bad = [
			{
				...validClaims,
				aud: "urn:cogni:node:44444444-4444-4444-8444-444444444444",
			},
			{ ...validClaims, futureClaim: true },
			{ ...validClaims, comment: { ...comment, body: "whole comment" } },
			{
				...validClaims,
				comment: {
					...comment,
					proofLines: Array.from({ length: 6 }, () => "x"),
				},
			},
			{ ...validClaims, comment: { ...comment, lastEditedAt: undefined } },
			{ ...validClaims, result: "not_found" },
			{ ...validClaims, comment: null },
			{ ...validClaims, exp: validClaims.iat },
		];
		for (const claims of bad)
			expect(
				GithubCommentAttestationClaimsSchema.safeParse(claims).success,
			).toBe(false);
	});

	it("type separation: neither claim schema accepts the other token's claims", () => {
		expect(IdentityAttestationClaimsSchema.safeParse(validClaims).success).toBe(
			false,
		);
		const identityClaims = {
			type: "identity.attestation.v1",
			protocol: IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
			iss: "https://cognidao.org",
			aud: `urn:cogni:node:${NODE_ID}`,
			nodeId: NODE_ID,
			nonce: NONCE,
			targetOrigin: "https://node-template.cognidao.org",
			github: { id: "12345", login: null },
			iat: 1_700_000_000,
			exp: 1_700_000_600,
			jti: "33333333-3333-4333-8333-333333333333",
		};
		expect(
			IdentityAttestationClaimsSchema.safeParse(identityClaims).success,
		).toBe(true);
		expect(
			GithubCommentAttestationClaimsSchema.safeParse(identityClaims).success,
		).toBe(false);
	});
});
