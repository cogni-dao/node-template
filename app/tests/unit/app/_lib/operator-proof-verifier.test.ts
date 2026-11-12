// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/_lib/operator-proof-verifier`
 * Purpose: The operator-backed `ProofVerifier` at the adapter seam (task.0095): real EdDSA signatures, a scripted operator (fetch), the real
 *   `evaluateProofComment`. Covers signature, type, audience, issuer, nonce echo, comment echo, stale readAt, the unavailable mapping, the wrong_issue
 *   pass-through and case-insensitive issue URLs.
 * Scope: No network, no database. `serverEnv` is mocked; the verifier is built with an injected fetch, key set, clock and logger.
 * Invariants: any bad answer is `unavailable` and logs ONE `agent.proof.operator_failed` line with a fixed reasonCode; only a signed answer is evidence;
 *   no token, nonce or login in a log line; the request has no targetOrigin and no secret.
 * Side-effects: none
 */

import {
	type CommentRead,
	evaluateProofComment,
	parseIssueRef,
	proofLine,
} from "@cogni/agent-grants/credentials";
import {
	GITHUB_COMMENT_ATTESTATION_TYP,
	GITHUB_COMMENT_ATTESTATION_V1_PROTOCOL_SHA256,
	IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
} from "@cogni/node-contracts";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/env/server", () => ({
	serverEnv: () => ({ DOMAIN: "test.cognidao.org" }),
}));

import { createOperatorProofVerifier } from "@/app/_lib/auth/operator-proof-verifier";

const ISSUER = "https://test.cognidao.org";
const NODE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_NODE = "44444444-4444-4444-8444-444444444444";
const NOW = 1_800_000_000;
const CHALLENGE_ID = "11111111-1111-4111-8111-111111111111";
const NONCE = "abcdefghijklmnopqrstuv";
const REQUEST_NONCE = "r".repeat(43);
const sha256Hex = async (text: string): Promise<string> =>
	[
		...new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
		),
	]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
const issue = parseIssueRef("cogni-dao/node-template#341") as NonNullable<
	ReturnType<typeof parseIssueRef>
>;

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let keys: ReturnType<typeof createLocalJWKSet>;
const warn = vi.fn();
let requests: Array<{
	url: string;
	init: RequestInit;
	body: Record<string, unknown>;
}> = [];

const comment = (over: Record<string, unknown> = {}) => ({
	repo: "cogni-dao/node-template",
	issueNumber: 341,
	issueUrl: "https://api.github.com/repos/cogni-dao/node-template/issues/341",
	commentId: 7,
	userId: 295942454,
	userType: "User",
	login: "agent-account",
	createdAt: "2026-11-11T10:00:00Z",
	updatedAt: "2026-11-11T10:00:00Z",
	lastEditedAt: null,
	proofLines: [proofLine(NODE_ID, CHALLENGE_ID, NONCE)],
	...over,
});
const claims = (over: Record<string, unknown> = {}) => ({
	type: "github.comment.attestation.v1",
	protocol: GITHUB_COMMENT_ATTESTATION_V1_PROTOCOL_SHA256,
	iss: ISSUER,
	aud: `urn:cogni:node:${NODE_ID}`,
	nodeId: NODE_ID,
	requestNonce: REQUEST_NONCE,
	result: "found",
	readAt: NOW - 5,
	comment: comment(),
	iat: NOW,
	exp: NOW + 120,
	jti: "33333333-3333-4333-8333-333333333333",
	...over,
});
const sign = (
	payload: Record<string, unknown>,
	opts: { key?: CryptoKey; typ?: string; alg?: string } = {},
) =>
	new SignJWT(payload as never)
		.setProtectedHeader({
			alg: opts.alg ?? "EdDSA",
			typ: opts.typ ?? GITHUB_COMMENT_ATTESTATION_TYP,
			kid: "k1",
		})
		.sign(opts.key ?? privateKey);
const ok = (token: string) =>
	new Response(JSON.stringify({ attestation: token }), { status: 200 });

function verifier(
	handler: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
	return createOperatorProofVerifier({
		nodeId: NODE_ID,
		issuer: ISSUER,
		keys,
		fetch: (async (url: string, init: RequestInit) => {
			requests.push({ url, init, body: JSON.parse(String(init.body)) });
			return handler(url, init);
		}) as unknown as typeof fetch,
		nowSec: () => NOW,
		newNonce: () => REQUEST_NONCE,
		reqId: "req-1",
		log: { warn },
	});
}
const read = (v: ReturnType<typeof verifier>) =>
	v.fetchComment({ issue, commentId: 7 });
const reason = () =>
	(warn.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.reasonCode;

beforeAll(async () => {
	const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
	privateKey = pair.privateKey;
	otherKey = (await generateKeyPair("EdDSA", { crv: "Ed25519" })).privateKey;
	keys = createLocalJWKSet({
		keys: [
			{
				...(await exportJWK(pair.publicKey)),
				kid: "k1",
				alg: "EdDSA",
				use: "sig",
			},
		],
	});
});
beforeEach(() => {
	warn.mockClear();
	requests = [];
});

describe("operator proof verifier", () => {
	it("a signed answer is the comment: the request is strict (no origin, no secret) and the facts map 1:1", async () => {
		const read1 = await read(verifier(async () => ok(await sign(claims()))));
		expect(read1).toEqual({
			kind: "found",
			comment: {
				issueUrl:
					"https://api.github.com/repos/cogni-dao/node-template/issues/341",
				userId: 295942454,
				login: "agent-account",
				userType: "User",
				body: proofLine(NODE_ID, CHALLENGE_ID, NONCE),
				createdAt: "2026-11-11T10:00:00Z",
				updatedAt: "2026-11-11T10:00:00Z",
				lastEditedAt: null,
			},
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(
			"https://test.cognidao.org/api/v1/public/identity/proof-comment",
		);
		expect(requests[0]?.body).toEqual({
			nodeId: NODE_ID,
			requestNonce: REQUEST_NONCE,
			issue: "cogni-dao/node-template#341",
			commentId: 7,
		});
		expect(requests[0]?.init).toMatchObject({
			method: "POST",
			redirect: "error",
		});
		expect(
			(requests[0]?.init.headers as Record<string, string> | undefined)?.[
				"x-request-id"
			],
		).toBe("req-1");
		expect(warn).not.toHaveBeenCalled();
	});

	it("a signed not_found is evidence (not_found), never unavailable", async () => {
		const out = await read(
			verifier(async () =>
				ok(await sign(claims({ result: "not_found", comment: null }))),
			),
		);
		expect(out).toEqual({ kind: "not_found" });
		expect(warn).not.toHaveBeenCalled();
	});

	it("the decision stays in the node: a found comment passes evaluateProofComment, and an edited one answers comment_edited", async () => {
		const expectation = {
			nodeId: NODE_ID,
			challengeId: CHALLENGE_ID,
			nonceHash: await sha256Hex(NONCE),
			issuedAt: "2026-11-11T09:59:00Z",
			expiresAt: "2026-11-11T10:30:00Z",
			commentSkewSec: 60,
		};
		const good = await read(verifier(async () => ok(await sign(claims()))));
		expect(await evaluateProofComment(good, issue, expectation)).toMatchObject({
			ok: true,
			githubId: "295942454",
			login: "agent-account",
		});
		const edited = await read(
			verifier(async () =>
				ok(
					await sign(
						claims({
							comment: comment({ lastEditedAt: "2026-11-11T10:00:00Z" }),
						}),
					),
				),
			),
		);
		expect(await evaluateProofComment(edited, issue, expectation)).toEqual({
			ok: false,
			reason: "comment_edited",
		});
	});

	it("a comment on another issue is passed through, so evaluateProofComment answers wrong_issue (not unavailable)", async () => {
		const other = comment({
			issueNumber: 2,
			issueUrl: "https://api.github.com/repos/cogni-dao/node-template/issues/2",
		});
		const out = await read(
			verifier(async () => ok(await sign(claims({ comment: other })))),
		);
		expect(out.kind).toBe("found");
		const expectation = {
			nodeId: NODE_ID,
			challengeId: CHALLENGE_ID,
			nonceHash: await sha256Hex(NONCE),
			issuedAt: "2026-11-11T09:59:00Z",
			expiresAt: "2026-11-11T10:30:00Z",
			commentSkewSec: 60,
		};
		expect(await evaluateProofComment(out, issue, expectation)).toEqual({
			ok: false,
			reason: "wrong_issue",
		});
		expect(warn).not.toHaveBeenCalled();
	});

	it("issue URLs compare case-insensitively (GitHub answers lowercase; a mixed-case URL still matches)", async () => {
		const mixed = comment({
			issueUrl:
				"https://api.github.com/repos/Cogni-DAO/Node-Template/issues/341",
		});
		const out = await read(
			verifier(async () => ok(await sign(claims({ comment: mixed })))),
		);
		const expectation = {
			nodeId: NODE_ID,
			challengeId: CHALLENGE_ID,
			nonceHash: await sha256Hex(NONCE),
			issuedAt: "2026-11-11T09:59:00Z",
			expiresAt: "2026-11-11T10:30:00Z",
			commentSkewSec: 60,
		};
		expect(await evaluateProofComment(out, issue, expectation)).toMatchObject({
			ok: true,
		});
	});

	const unavailable: CommentRead = { kind: "unavailable" };

	it("a bad signature (another key) is unavailable: bad_token", async () => {
		expect(
			await read(
				verifier(async () => ok(await sign(claims(), { key: otherKey }))),
			),
		).toEqual(unavailable);
		expect(reason()).toBe("bad_token");
	});

	it("a tampered payload is unavailable: bad_token", async () => {
		const token = await sign(claims());
		const [h, , s] = token.split(".");
		const forged = Buffer.from(
			JSON.stringify(claims({ comment: comment({ userId: 1 }) })),
		).toString("base64url");
		expect(await read(verifier(async () => ok(`${h}.${forged}.${s}`)))).toEqual(
			unavailable,
		);
		expect(reason()).toBe("bad_token");
	});

	it("an identity attestation (typ JWT, identity claims) never passes as a proof answer", async () => {
		const identity = {
			...claims(),
			type: "identity.attestation.v1",
			protocol: IDENTITY_ATTESTATION_V1_PROTOCOL_SHA256,
			nonce: REQUEST_NONCE,
			targetOrigin: "https://x.cognidao.org",
			github: { id: "1", login: null },
		};
		expect(
			await read(
				verifier(async () => ok(await sign(identity, { typ: "JWT" }))),
			),
		).toEqual(unavailable);
		expect(reason()).toBe("bad_token");
		warn.mockClear();
		// right typ, wrong claim type: the strict schema refuses it
		expect(
			await read(
				verifier(async () =>
					ok(await sign({ ...claims(), type: "identity.attestation.v1" })),
				),
			),
		).toEqual(unavailable);
		expect(reason()).toBe("bad_claims");
	});

	it("a wrong typ with proof claims is unavailable", async () => {
		expect(
			await read(
				verifier(async () => ok(await sign(claims(), { typ: "JWT" }))),
			),
		).toEqual(unavailable);
		expect(reason()).toBe("bad_token");
	});

	it("a wrong audience (another node) is unavailable", async () => {
		expect(
			await read(
				verifier(async () =>
					ok(
						await sign(
							claims({
								aud: `urn:cogni:node:${OTHER_NODE}`,
								nodeId: OTHER_NODE,
							}),
						),
					),
				),
			),
		).toEqual(unavailable);
		expect(reason()).toBe("bad_token");
	});

	it("a wrong issuer is unavailable", async () => {
		expect(
			await read(
				verifier(async () =>
					ok(await sign(claims({ iss: "https://evil.example.com" }))),
				),
			),
		).toEqual(unavailable);
		expect(reason()).toBe("bad_token");
	});

	it("an old answer with another requestNonce (a replay) is unavailable: bad_claims", async () => {
		expect(
			await read(
				verifier(async () =>
					ok(await sign(claims({ requestNonce: "o".repeat(43) }))),
				),
			),
		).toEqual(unavailable);
		expect(reason()).toBe("bad_claims");
	});

	it("an echoed commentId that differs from the one asked is unavailable", async () => {
		expect(
			await read(
				verifier(async () =>
					ok(await sign(claims({ comment: comment({ commentId: 8 }) }))),
				),
			),
		).toEqual(unavailable);
		expect(reason()).toBe("bad_claims");
	});

	it("a readAt more than 60 s older than iat is unavailable: stale; exactly 60 s is accepted", async () => {
		expect(
			await read(
				verifier(async () => ok(await sign(claims({ readAt: NOW - 61 })))),
			),
		).toEqual(unavailable);
		expect(reason()).toBe("stale");
		warn.mockClear();
		expect(
			(
				await read(
					verifier(async () => ok(await sign(claims({ readAt: NOW - 60 })))),
				)
			).kind,
		).toBe("found");
		expect(warn).not.toHaveBeenCalled();
	});

	it("an expired answer is unavailable", async () => {
		expect(
			await read(
				verifier(async () =>
					ok(
						await sign(
							claims({ iat: NOW - 500, exp: NOW - 380, readAt: NOW - 505 }),
						),
					),
				),
			),
		).toEqual(unavailable);
		expect(reason()).toBe("bad_token");
	});

	it("an unknown claim (strict schema) and a missing lastEditedAt are unavailable: bad_claims", async () => {
		expect(
			await read(verifier(async () => ok(await sign(claims({ extra: 1 }))))),
		).toEqual(unavailable);
		expect(reason()).toBe("bad_claims");
		warn.mockClear();
		const { lastEditedAt: _omit, ...noEdit } = comment();
		expect(
			await read(
				verifier(async () => ok(await sign(claims({ comment: noEdit })))),
			),
		).toEqual(unavailable);
		expect(reason()).toBe("bad_claims");
	});

	it("operator 503, 429, 400 and a transport error are unavailable with a fixed reasonCode and no secret in the log", async () => {
		const cases: Array<[() => Response | Promise<Response>, string]> = [
			[() => new Response("{}", { status: 503 }), "http_5xx"],
			[() => new Response("{}", { status: 429 }), "http_4xx"],
			[() => new Response("{}", { status: 400 }), "http_4xx"],
			[
				() => {
					throw new TypeError("fetch failed");
				},
				"network",
			],
			[
				() => {
					throw Object.assign(new Error("t"), { name: "TimeoutError" });
				},
				"timeout",
			],
			[() => new Response("not json", { status: 200 }), "network"],
			[() => new Response("{}", { status: 200 }), "bad_token"],
		];
		for (const [handler, code] of cases) {
			warn.mockClear();
			expect(await read(verifier(handler))).toEqual(unavailable);
			expect(reason()).toBe(code);
			expect(warn).toHaveBeenCalledTimes(1);
			const line = JSON.stringify(warn.mock.calls[0]);
			expect(line).toContain("agent.proof.operator_failed");
			expect(line).toContain('"dep":"operator"');
			expect(line).not.toContain(REQUEST_NONCE);
		}
	});

	it("a key set that cannot be read is unavailable: jwks_unavailable", async () => {
		const v = createOperatorProofVerifier({
			nodeId: NODE_ID,
			issuer: ISSUER,
			keys: async () => {
				throw new Error("jwks down");
			},
			fetch: (async () => ok(await sign(claims()))) as unknown as typeof fetch,
			nowSec: () => NOW,
			newNonce: () => REQUEST_NONCE,
			log: { warn },
		});
		expect(await read(v)).toEqual(unavailable);
		expect(reason()).toBe("jwks_unavailable");
	});

	it("a bad comment id never calls the operator", async () => {
		const v = verifier(async () => ok(await sign(claims())));
		for (const id of [0, -1, 1.5, Number.NaN])
			expect(await v.fetchComment({ issue, commentId: id })).toEqual({
				kind: "not_found",
			});
		expect(requests).toHaveLength(0);
	});
});
