// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/identity/bindings-import.route`
 * Purpose: Negative-matrix unit tests for POST /api/v1/identity/bindings/import
 *   (task.5024) — real EdDSA verification against a mocked remote JWKS.
 * Scope: Tests the route handler + operator-attestation verifier together;
 *   session, DB import, and observability are mocked. Does not hit a network
 *   or database.
 * Invariants:
 *   - tampered/expired/wrong-issuer token → 401 invalid_token
 *   - session wallet ≠ token wallet → 403 wallet_mismatch
 *   - github id bound to different user → 409 already_linked (NO_AUTO_MERGE)
 *   - JWKS unreachable → 503 jwks_unavailable (fail closed)
 *   - happy path → 201 {bound:true}; repeat → 200 already_bound
 * Side-effects: none (global fetch stubbed)
 * Links: src/app/api/v1/identity/bindings/import/route.ts, src/app/_lib/auth/operator-attestation.ts
 * @internal
 */

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must precede imports of modules under test) ---

const ISSUER = "https://hub.test.example";
const SESSION_WALLET = "0xAbCd000000000000000000000000000000001234"; // mixed case on purpose
const TOKEN_WALLET = SESSION_WALLET.toLowerCase();
const USER_ID = "user-1111";

const mockGetSessionUser = vi.fn();
const mockImportBinding = vi.fn();

// Keep the verifier's env read isolated from full server env validation
vi.mock("@/shared/env/server", () => ({
	serverEnv: () => ({ COGNI_OPERATOR_ISSUER_URL: ISSUER }),
}));

vi.mock("@/lib/auth/server", () => ({
	getServerSessionUser: (...args: unknown[]) => mockGetSessionUser(...args),
}));

vi.mock("@/bootstrap/identity", () => ({
	importAttestedGithubBinding: (...args: unknown[]) =>
		mockImportBinding(...args),
}));

// wrapRouteHandlerWithLogging deps — keep this a true unit (no pino/prom-client)
vi.mock("@/shared/observability", () => {
	const noopLog = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		child: vi.fn().mockReturnThis(),
	};
	return {
		createRequestContext: () => ({ log: noopLog, reqId: "req-1" }),
		httpRequestDurationMs: { observe: vi.fn() },
		httpRequestsTotal: { inc: vi.fn() },
		logRequestEnd: vi.fn(),
		logRequestError: vi.fn(),
		logRequestStart: vi.fn(),
		makeLogger: () => noopLog,
		statusBucket: (status: number) => String(status),
	};
});

vi.mock("@/bootstrap/otel", () => ({
	withRootSpan: (
		_name: string,
		_attrs: Record<string, unknown>,
		fn: (args: {
			traceId: string;
			span: { setAttribute: () => void };
		}) => Promise<unknown>,
	) => fn({ traceId: "trace-1", span: { setAttribute: vi.fn() } }),
}));

vi.mock("@/bootstrap/container", () => ({
	getContainer: () => ({
		config: { unhandledErrorPolicy: "rethrow" },
		log: { child: vi.fn().mockReturnThis() },
		clock: { now: () => new Date() },
	}),
}));

// Import after mocks
import { resetOperatorAttestationJwksCacheForTests } from "@/app/_lib/auth/operator-attestation";
import { POST } from "@/app/api/v1/identity/bindings/import/route";

// --- Key + token helpers ---

const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const { privateKey: attackerKey } = await generateKeyPair("EdDSA");
const publicJwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "EdDSA" };

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function jwksOk(): Response {
	return new Response(JSON.stringify({ keys: [publicJwk] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

async function mintToken(opts?: {
	wallet?: string;
	issuer?: string;
	expiredBy?: number;
	key?: typeof privateKey;
}): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const exp = opts?.expiredBy ? now - opts.expiredBy : now + 600;
	return await new SignJWT({
		wallet: opts?.wallet ?? TOKEN_WALLET,
		github: { id: 12345, login: "octocat" },
		jti: "jti-abc",
	})
		.setProtectedHeader({ alg: "EdDSA", kid: "k1" })
		.setIssuer(opts?.issuer ?? ISSUER)
		.setSubject(USER_ID)
		.setIssuedAt(opts?.expiredBy ? now - opts.expiredBy - 600 : now)
		.setExpirationTime(exp)
		.sign(opts?.key ?? privateKey);
}

function makeRequest(body: unknown): NextRequest {
	return new NextRequest(
		"http://localhost:3200/api/v1/identity/bindings/import",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	resetOperatorAttestationJwksCacheForTests();
	fetchMock.mockImplementation(async () => jwksOk());
	mockGetSessionUser.mockResolvedValue({
		id: USER_ID,
		walletAddress: SESSION_WALLET,
		displayName: null,
		avatarColor: null,
	});
	mockImportBinding.mockResolvedValue("created");
});

describe("POST /api/v1/identity/bindings/import", () => {
	it("201 {bound:true} on happy path; passes attested claims to import", async () => {
		const res = await POST(makeRequest({ token: await mintToken() }));

		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ bound: true });
		expect(mockImportBinding).toHaveBeenCalledWith({
			userId: USER_ID,
			githubId: "12345",
			githubLogin: "octocat",
			issuer: ISSUER,
			jti: "jti-abc",
			iat: expect.any(Number),
		});
	});

	it("200 already_bound when the same binding already exists (idempotent)", async () => {
		mockImportBinding.mockResolvedValue("already_bound");

		const res = await POST(makeRequest({ token: await mintToken() }));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ bound: true, code: "already_bound" });
	});

	it("409 already_linked when the github id is bound to a different user (NO_AUTO_MERGE)", async () => {
		mockImportBinding.mockResolvedValue("already_linked");

		const res = await POST(makeRequest({ token: await mintToken() }));

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ errorCode: "already_linked" });
	});

	it("401 invalid_token for a tampered token (signed by the wrong key)", async () => {
		const res = await POST(
			makeRequest({ token: await mintToken({ key: attackerKey }) }),
		);

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ errorCode: "invalid_token" });
		expect(mockImportBinding).not.toHaveBeenCalled();
	});

	it("401 invalid_token for an expired token", async () => {
		const res = await POST(
			makeRequest({ token: await mintToken({ expiredBy: 3600 }) }),
		);

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ errorCode: "invalid_token" });
	});

	it("401 invalid_token when iss is not the pinned issuer", async () => {
		const res = await POST(
			makeRequest({
				token: await mintToken({ issuer: "https://evil.example" }),
			}),
		);

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ errorCode: "invalid_token" });
	});

	it("403 wallet_mismatch when the token attests a different wallet", async () => {
		const res = await POST(
			makeRequest({
				token: await mintToken({
					wallet: "0x9999999999999999999999999999999999999999",
				}),
			}),
		);

		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ errorCode: "wallet_mismatch" });
		expect(mockImportBinding).not.toHaveBeenCalled();
	});

	it("403 wallet_mismatch when the session has no wallet (OAuth-only user)", async () => {
		mockGetSessionUser.mockResolvedValue({
			id: USER_ID,
			walletAddress: null,
			displayName: null,
			avatarColor: null,
		});

		const res = await POST(makeRequest({ token: await mintToken() }));

		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ errorCode: "wallet_mismatch" });
	});

	it("503 jwks_unavailable when the issuer JWKS is unreachable (fail closed)", async () => {
		fetchMock.mockRejectedValue(new TypeError("fetch failed"));

		const res = await POST(makeRequest({ token: await mintToken() }));

		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ errorCode: "jwks_unavailable" });
		expect(mockImportBinding).not.toHaveBeenCalled();
	});

	it("401 Session required without a session", async () => {
		mockGetSessionUser.mockResolvedValue(null);

		const res = await POST(makeRequest({ token: await mintToken() }));

		expect(res.status).toBe(401);
	});

	it("400 on a body without a token", async () => {
		const res = await POST(makeRequest({ nope: true }));

		expect(res.status).toBe(400);
	});
});
