// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/auth/operator-proof-verifier`
 * Purpose: Fills the `ProofVerifier` port of `@cogni-dao/agent-grants/credentials` from a signed operator answer (task.0095). The node holds NO GitHub
 *   credential: the operator reads ONE public comment with its own GitHub App and signs the facts; this adapter verifies the signature and hands the
 *   facts back as a `ProofComment`. `evaluateProofComment`, the challenge secret, one use, the principal, the edit rule and the binding stay in the node.
 * Scope: One call to `POST <operator>/api/v1/public/identity/proof-comment`, one JWT check, one mapping. No store, no decision about the proof.
 * Invariants:
 *   - NODE_IS_SOLE_AUTHORITY: the operator gives evidence; the node decides. The request never carries the challenge secret or a target origin.
 *   - PINNED_ISSUER: the URL comes from `DOMAIN` (`getOperatorIssuerUrl`), never from a header; the token `iss` must equal it. EdDSA only.
 *   - TYPE_SEPARATION: the header `typ` is `github.comment.attestation+jwt` and the claims are strict `github.comment.attestation.v1`; an identity
 *     attestation never passes here.
 *   - BOUND_TO_THIS_CALL: `aud` is `urn:cogni:node:<this node uuid>`, the echoed `requestNonce` is this call's own random value, `nodeId` and the echoed
 *     `commentId` match, and `readAt` is at most 60 s older than `iat`.
 *   - UNAVAILABLE_IS_NOT_A_FAILURE: a transport error, a non-200, a bad signature or typ, a wrong audience, nonce or echo, a stale read or an operator
 *     503 is `unavailable`. It burns no attempt. Only a signed `not_found` or a signed comment is evidence.
 *   - FETCH_RULES: one host, `redirect: "error"`, 8 s timeout, 64 KB cap.
 *   - NO_SECRETS_IN_LOGS: one `agent.proof.operator_failed` line on failure with a fixed `reasonCode`, status and duration. Never a token, nonce, login or body.
 * Side-effects: network (the operator), logs
 * Links: task.0095, packages/node-contracts/src/github.comment.attestation.v1.contract.ts, _lib/auth/operator-attestation.ts
 * @internal
 */

import { randomBytes } from "node:crypto";

import type {
	CommentRead,
	ProofVerifier,
} from "@cogni/agent-grants/credentials";
import {
	GITHUB_COMMENT_ATTESTATION_MAX_READ_AGE_SECONDS,
	GITHUB_COMMENT_ATTESTATION_TYP,
	GithubCommentAttestationClaimsSchema,
	type GithubCommentAttestationRequest,
	identityAttestationAudience,
} from "@cogni/node-contracts";
import { type JWTVerifyGetKey, jwtVerify } from "jose";

import {
	getOperatorIssuerUrl,
	getOperatorJwks,
	isTokenError,
} from "@/app/_lib/auth/operator-attestation";
import { EVENT_NAMES } from "@/shared/observability";

/** Path of the operator route. */
export const OPERATOR_PROOF_COMMENT_PATH =
	"/api/v1/public/identity/proof-comment";

const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 64 * 1024;
/** A `readAt` later than `iat` by more than this is a broken clock, not a read. */
const READ_AHEAD_TOLERANCE_SEC = 5;

/** The fixed set of `reasonCode` values of `agent.proof.operator_failed`. */
export type OperatorProofFailure =
	| "timeout"
	| "network"
	| "http_4xx"
	| "http_5xx"
	| "bad_token"
	| "bad_claims"
	| "stale"
	| "jwks_unavailable"
	| "bad_config";

export interface OperatorProofVerifierOptions {
	/** This node's UUID: the audience and the `nodeId` of the request. */
	readonly nodeId: string;
	/** The pinned operator origin (from `DOMAIN`). The route URL and the token `iss` come from it. */
	readonly issuer: string;
	/** The issuer's key set (the shared remote JWKS cache in production). */
	readonly keys: JWTVerifyGetKey;
	readonly fetch: typeof fetch;
	/** Epoch seconds. */
	readonly nowSec?: () => number;
	/** A fresh URL-safe nonce of 32..128 characters for one call. */
	readonly newNonce?: () => string;
	/** Sent as `x-request-id`: the operator logs it as `callerReqId`. */
	readonly reqId?: string;
	readonly log: { warn(fields: Record<string, unknown>, msg: string): void };
}

const unavailable: CommentRead = { kind: "unavailable" };

/** Read at most `MAX_BODY_BYTES` of a response; null when it is larger. */
async function readCapped(res: Response): Promise<string | null> {
	if (Number(res.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
		res.body?.cancel().catch(() => undefined);
		return null;
	}
	const reader = res.body?.getReader();
	if (!reader) {
		const text = await res.text();
		return text.length > MAX_BODY_BYTES ? null : text;
	}
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_BODY_BYTES) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export function createOperatorProofVerifier(
	options: OperatorProofVerifierOptions,
): ProofVerifier {
	const nowSec = options.nowSec ?? (() => Math.floor(Date.now() / 1000));
	const newNonce =
		options.newNonce ?? (() => randomBytes(32).toString("base64url"));

	return {
		async fetchComment({ issue, commentId }): Promise<CommentRead> {
			if (!Number.isSafeInteger(commentId) || commentId <= 0)
				return { kind: "not_found" };
			const started = Date.now();
			const fail = (
				reasonCode: OperatorProofFailure,
				status = 0,
			): CommentRead => {
				options.log.warn(
					{
						event: EVENT_NAMES.AGENT_PROOF_OPERATOR_FAILED,
						dep: "operator",
						reasonCode,
						status,
						durationMs: Date.now() - started,
					},
					EVENT_NAMES.AGENT_PROOF_OPERATOR_FAILED,
				);
				return unavailable;
			};

			const requestNonce = newNonce();
			const request: GithubCommentAttestationRequest = {
				nodeId: options.nodeId,
				requestNonce,
				issue: `${issue.owner}/${issue.repo}#${issue.number}`,
				commentId,
			};

			let res: Response;
			try {
				res = await options.fetch(
					`${options.issuer}${OPERATOR_PROOF_COMMENT_PATH}`,
					{
						method: "POST",
						redirect: "error",
						signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
						headers: {
							"content-type": "application/json",
							accept: "application/json",
							...(options.reqId ? { "x-request-id": options.reqId } : {}),
						},
						body: JSON.stringify(request),
					},
				);
			} catch (error) {
				return fail(
					error instanceof Error &&
						(error.name === "TimeoutError" || error.name === "AbortError")
						? "timeout"
						: "network",
				);
			}
			if (res.status !== 200) {
				res.body?.cancel().catch(() => undefined);
				return fail(res.status >= 500 ? "http_5xx" : "http_4xx", res.status);
			}

			let token: string | undefined;
			try {
				const text = await readCapped(res);
				if (text === null) return fail("bad_token", 200);
				const body = JSON.parse(text) as {
					attestation?: unknown;
					token?: unknown;
				};
				const candidate =
					typeof body.attestation === "string" ? body.attestation : body.token;
				if (typeof candidate === "string" && candidate.length > 0)
					token = candidate;
			} catch {
				return fail("network", 200);
			}
			if (!token) return fail("bad_token", 200);

			let payload: unknown;
			try {
				({ payload } = await jwtVerify(token, options.keys, {
					issuer: options.issuer,
					audience: identityAttestationAudience(options.nodeId),
					algorithms: ["EdDSA"],
					typ: GITHUB_COMMENT_ATTESTATION_TYP,
					currentDate: new Date(nowSec() * 1000),
				}));
			} catch (error) {
				return fail(
					isTokenError(error) ? "bad_token" : "jwks_unavailable",
					200,
				);
			}

			const parsed = GithubCommentAttestationClaimsSchema.safeParse(payload);
			if (!parsed.success) return fail("bad_claims", 200);
			const claims = parsed.data;
			if (
				claims.nodeId !== options.nodeId ||
				claims.requestNonce !== requestNonce
			)
				return fail("bad_claims", 200);
			if (
				claims.iat - claims.readAt >
					GITHUB_COMMENT_ATTESTATION_MAX_READ_AGE_SECONDS ||
				claims.readAt - claims.iat > READ_AHEAD_TOLERANCE_SEC ||
				claims.iat - nowSec() > READ_AHEAD_TOLERANCE_SEC
			) {
				return fail("stale", 200);
			}

			if (claims.result === "not_found" || claims.comment === null)
				return { kind: "not_found" };
			const c = claims.comment;
			if (c.commentId !== commentId) return fail("bad_claims", 200);
			// The ACTUAL issue of the comment is passed through. A comment on another issue is not an echo mismatch: `evaluateProofComment` answers `wrong_issue`.
			return {
				kind: "found",
				comment: {
					issueUrl: c.issueUrl,
					userId: c.userId,
					login: c.login,
					userType: c.userType,
					body: c.proofLines.join("\n"),
					createdAt: c.createdAt,
					updatedAt: c.updatedAt,
					lastEditedAt: c.lastEditedAt,
				},
			};
		},
	};
}

/** The production wiring: the issuer pinned from `DOMAIN`, the shared remote JWKS cache, global `fetch`. A missing `DOMAIN` is `unavailable` (503), never a 500. */
export function createPinnedOperatorProofVerifier(input: {
	nodeId: string;
	reqId?: string;
	log: OperatorProofVerifierOptions["log"];
	fetch?: typeof fetch;
}): ProofVerifier {
	let issuer: string;
	try {
		issuer = getOperatorIssuerUrl();
	} catch {
		return {
			async fetchComment(): Promise<CommentRead> {
				input.log.warn(
					{
						event: EVENT_NAMES.AGENT_PROOF_OPERATOR_FAILED,
						dep: "operator",
						reasonCode: "bad_config" satisfies OperatorProofFailure,
						status: 0,
						durationMs: 0,
					},
					EVENT_NAMES.AGENT_PROOF_OPERATOR_FAILED,
				);
				return unavailable;
			},
		};
	}
	return createOperatorProofVerifier({
		nodeId: input.nodeId,
		issuer,
		keys: getOperatorJwks(issuer),
		fetch: input.fetch ?? fetch,
		...(input.reqId ? { reqId: input.reqId } : {}),
		log: input.log,
	});
}
