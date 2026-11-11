// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/enrollment-client` transport
 * Purpose: Call the enrollment routes of the node being asked: post the signed token, poll the device code, confirm the key.
 * Scope: Three bounded HTTPS calls to one origin the caller names. Needs only `fetch`. No retries, no storage, no logging.
 * Wire: the provider's `http.ts` (`requestServiceEnrollmentOperation`, `pollServiceEnrollmentOperation`). Responses are parsed with those zod shapes,
 *   so one package version holds both halves of the protocol.
 * Invariants:
 *   - HTTPS_ORIGIN_ONLY: only `https` and only the origin the caller passes (a registry-resolved origin, never a request field); redirects are never followed.
 *   - BOUNDED: a timeout (10 s) and a response cap (64 KiB, enforced while reading) per call.
 *   - RFC8628_ERRORS: `authorization_pending`, `slow_down`, `access_denied`, `expired_token` map to typed results; anything else is `bad_response`.
 *   - HOSTILE_NODE_CLAMPED: the interval and the expiry the node returns are clamped, so a node cannot stall or flood the poller.
 *   - NOTHING_SECRET_LOGGED: this module never logs a token, device code, JWE or key.
 * Side-effects: IO (HTTPS)
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

import { z } from "zod";

import { pollServiceEnrollmentOperation, requestServiceEnrollmentOperation } from "../http";
import { readBoundedText } from "./bounded-body";

export const ENROLLMENT_REQUEST_PATH = "/api/v1/public/agent/service-enrollments";
export const ENROLLMENT_TOKEN_PATH = "/api/v1/public/agent/service-enrollments/token";
export const ENROLLMENT_CONFIRM_PATH = "/api/v1/agent/credentials/confirm";

export const ENROLLMENT_CLIENT_LIMITS = {
  timeoutMs: 10_000,
  maxResponseBytes: 64 * 1024,
  minExpiresInS: 60,
  maxExpiresInS: 86_400,
  minIntervalS: 5,
  maxIntervalS: 60,
} as const;

export type EnrollmentClientErrorCode = "origin_unreachable" | "enrollment_rejected" | "replayed_token" | "bad_response";

/** A failure talking to the node. `status` is the HTTP status when there was one. */
export class EnrollmentClientError extends Error {
  constructor(
    readonly code: EnrollmentClientErrorCode,
    readonly status?: number
  ) {
    super(code);
    this.name = "EnrollmentClientError";
  }
}

/** What the node answered when it accepted the signed token (interval and expiry clamped). */
export interface EnrollmentAccepted {
  readonly deviceCode: string;
  readonly expiresInS: number;
  readonly intervalS: number;
}

export type EnrollmentPollResult =
  | { readonly kind: "authorization_pending" }
  | { readonly kind: "slow_down" }
  | { readonly kind: "access_denied" }
  | { readonly kind: "expired_token" }
  | { readonly kind: "issued"; readonly sealedKey: string; readonly credentialId: string; readonly pendingExpiresAt: string };

export interface EnrollmentTransport {
  /** POST the signed token to the node's `service-enrollments` route. */
  postEnrollment(origin: string, token: string): Promise<EnrollmentAccepted>;
  /** POST the device code to the node's `service-enrollments/token` route. */
  pollToken(origin: string, deviceCode: string): Promise<EnrollmentPollResult>;
  /** Confirm the freshly stored key with the node (`POST /api/v1/agent/credentials/confirm`, bearer = the key). */
  confirmKey(origin: string, apiKey: string): Promise<{ readonly ok: boolean; readonly status: number }>;
}

export interface EnrollmentTransportOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

const PollErrorSchema = z.object({ error: z.enum(["authorization_pending", "slow_down", "access_denied", "expired_token"]) });
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

export function createEnrollmentTransport(options: EnrollmentTransportOptions = {}): EnrollmentTransport {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? ENROLLMENT_CLIENT_LIMITS.timeoutMs;
  const maxBytes = options.maxResponseBytes ?? ENROLLMENT_CLIENT_LIMITS.maxResponseBytes;

  async function call(origin: string, path: string, init: { body?: unknown; bearer?: string }): Promise<{ status: number; json: Record<string, unknown> }> {
    let url: URL;
    try {
      url = new URL(path, origin);
      if (url.protocol !== "https:" || url.origin !== new URL(origin).origin) throw new Error("origin");
    } catch {
      throw new EnrollmentClientError("origin_unreachable");
    }
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
        },
        body: JSON.stringify(init.body ?? {}),
      });
    } catch {
      throw new EnrollmentClientError("origin_unreachable");
    }
    if (response.status >= 500) throw new EnrollmentClientError("origin_unreachable", response.status);
    let json: Record<string, unknown> = {};
    try {
      const body = await readBoundedText(response, maxBytes);
      if (!body.ok) throw new EnrollmentClientError("bad_response", response.status);
      if (body.text.length > 0) {
        const parsed: unknown = JSON.parse(body.text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
      }
    } catch (error) {
      if (error instanceof EnrollmentClientError) throw error;
      // A stream failure or a non-JSON body: the status alone decides.
      json = {};
    }
    return { status: response.status, json };
  }

  return {
    async postEnrollment(origin, token) {
      const { status, json } = await call(origin, ENROLLMENT_REQUEST_PATH, { body: { token } });
      if (status === 401) {
        const code = typeof json.error === "string" ? json.error : json.errorCode;
        throw new EnrollmentClientError(code === "replayed_token" ? "replayed_token" : "enrollment_rejected", status);
      }
      if (status < 200 || status >= 300) throw new EnrollmentClientError("enrollment_rejected", status);
      const accepted = requestServiceEnrollmentOperation.output.safeParse(json);
      if (!accepted.success) throw new EnrollmentClientError("bad_response", status);
      return {
        deviceCode: accepted.data.deviceCode,
        expiresInS: clamp(accepted.data.expires_in, ENROLLMENT_CLIENT_LIMITS.minExpiresInS, ENROLLMENT_CLIENT_LIMITS.maxExpiresInS),
        intervalS: clamp(accepted.data.interval, ENROLLMENT_CLIENT_LIMITS.minIntervalS, ENROLLMENT_CLIENT_LIMITS.maxIntervalS),
      };
    },

    async pollToken(origin, deviceCode) {
      const { status, json } = await call(origin, ENROLLMENT_TOKEN_PATH, { body: { deviceCode } });
      if (status >= 200 && status < 300) {
        const issued = pollServiceEnrollmentOperation.output.safeParse(json);
        if (issued.success) {
          return { kind: "issued", sealedKey: issued.data.sealedKey, credentialId: issued.data.credentialId, pendingExpiresAt: issued.data.pendingExpiresAt };
        }
      }
      if (status === 429) return { kind: "slow_down" };
      const failure = PollErrorSchema.safeParse(json);
      if (failure.success) return { kind: failure.data.error };
      throw new EnrollmentClientError("bad_response", status);
    },

    async confirmKey(origin, apiKey) {
      const { status } = await call(origin, ENROLLMENT_CONFIRM_PATH, { bearer: apiKey });
      return { ok: status === 200, status };
    },
  };
}
