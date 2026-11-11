// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * The credential route contract: every service result and typed error maps to one status, body and header set (the fleet's one mapping).
 */

import { describe, expect, it } from "vitest";
import {
  CredentialRateLimitedError,
  CredentialStoreUnavailableError,
  credentialDenialHttp,
  credentialErrorHttp,
  credentialHttp,
  storeFailureFields,
  V1SupersededError,
} from "../src/credentials";

const minted = { ok: true, credentialId: "c1", userId: "u1", apiKey: "k", pendingExpiresAt: "2026-11-11T00:00:00.000Z" } as const;

describe("credentialHttp", () => {
  it("maps a minted key to 200 with the pending shape, no-store", () => {
    for (const op of ["upgrade", "rotate"] as const) {
      const res = credentialHttp({ op, result: minted });
      expect(res).toMatchObject({ status: 200, headers: { "cache-control": "no-store" } });
      expect(res.body).toEqual({ userId: "u1", credentialId: "c1", apiKey: "k", status: "pending", pendingExpiresAt: minted.pendingExpiresAt });
    }
  });

  it("maps every upgrade refusal, rotate's single refusal, and the signed-key and input errors", () => {
    const status = (reason: string) => {
      const r = credentialHttp({ op: "upgrade", result: { ok: false, reason: reason as never } });
      return [r.status, (r.body as { error: string }).error];
    };
    expect(status("unknown_user")).toEqual([403, "not_agent_key"]);
    expect(status("wallet_user")).toEqual([403, "not_agent_key"]);
    expect(status("internal_principal")).toEqual([403, "not_agent_key"]);
    expect(status("already_upgraded")).toEqual([409, "already_upgraded"]);
    expect(status("binding_required")).toEqual([409, "binding_required"]);
    expect(credentialHttp({ op: "rotate", result: { ok: false, reason: "already_upgraded" } })).toMatchObject({ status: 409, body: { error: "not_rotatable" } });
    expect(credentialHttp({ op: "signed_key_required" })).toMatchObject({ status: 403, body: { error: "signed_key_required" } });
    expect(credentialHttp({ op: "invalid_input" })).toMatchObject({ status: 400, body: { error: "invalid input" } });
  });

  it("maps confirm: 200 with replay flag, and every refusal to 409", () => {
    const base = { ok: true, userId: "u1", expiresAt: "e", renewUntil: "r" } as const;
    expect(credentialHttp({ op: "confirm", credentialId: "c1", result: { ...base, status: "confirmed" } }).body).toMatchObject({ status: "active", replay: false, credentialId: "c1" });
    expect(credentialHttp({ op: "confirm", credentialId: "c1", result: { ...base, status: "already_active" } }).body).toMatchObject({ replay: true });
    const err = (reason: string) => credentialHttp({ op: "confirm", credentialId: "c1", result: { ok: false, reason: reason as never } });
    expect(err("revoked")).toMatchObject({ status: 409, body: { error: "superseded" } });
    expect(err("not_found")).toMatchObject({ status: 409, body: { error: "superseded" } });
    expect(err("expired")).toMatchObject({ status: 409, body: { error: "pending_expired" } });
    expect(err("predecessor_revoked")).toMatchObject({ status: 409, body: { error: "predecessor_revoked" } });
    expect(err("binding_required")).toMatchObject({ status: 409, body: { error: "binding_required" } });
  });

  it("maps revoke: 200, or 404 not_found", () => {
    expect(credentialHttp({ op: "revoke", credentialId: "c1", revoked: true })).toMatchObject({ status: 200, body: { credentialId: "c1", revoked: true } });
    expect(credentialHttp({ op: "revoke", credentialId: "c1", revoked: false })).toMatchObject({ status: 404, body: { error: "not_found" } });
  });
});

describe("denials and typed errors", () => {
  it("401 invalid_token with www-authenticate, 429 with retry-after 60, 503 with retry-after 5; all no-store", () => {
    expect(credentialDenialHttp("invalid")).toMatchObject({ status: 401, body: { error: "invalid_token" }, headers: { "www-authenticate": 'Bearer error="invalid_token"', "cache-control": "no-store" } });
    expect(credentialDenialHttp("rate_limited")).toMatchObject({ status: 429, body: { error: "rate_limited" }, headers: { "retry-after": "60", "cache-control": "no-store" } });
    expect(credentialDenialHttp("unavailable")).toMatchObject({ status: 503, body: { error: "authz_unavailable" }, headers: { "retry-after": "5", "cache-control": "no-store" } });
  });

  it("maps the three typed errors and returns null for any other error", () => {
    expect(credentialErrorHttp(new V1SupersededError("u1"))).toMatchObject({ status: 401, body: { error: "v1_superseded" } });
    expect(credentialErrorHttp(new CredentialRateLimitedError())?.status).toBe(429);
    expect(credentialErrorHttp(new CredentialStoreUnavailableError())?.status).toBe(503);
    expect(credentialErrorHttp(new Error("boom"))).toBeNull();
  });
});

describe("store failure cause", () => {
  it("carries the cause non-enumerably and exposes only the class and SQLSTATE for logging", () => {
    const pg = Object.assign(new Error('duplicate key value violates unique constraint (token_hash)=(abc)'), { code: "23505" });
    const error = new CredentialStoreUnavailableError(pg);
    expect((error as { cause?: unknown }).cause).toBe(pg);
    expect(Object.keys(error)).not.toContain("cause");
    expect(storeFailureFields(error)).toEqual({ errorClass: "Error", sqlState: "23505" });
    expect(JSON.stringify(storeFailureFields(error))).not.toContain("abc");
    expect(storeFailureFields(new CredentialStoreUnavailableError())).toEqual({});
  });
});
