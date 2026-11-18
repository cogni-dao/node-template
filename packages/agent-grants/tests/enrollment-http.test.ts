// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** The wire contract of the two public enrollment routes (story.0038): statuses, bodies and `no-store` on every answer. */

import { describe, expect, it } from "vitest";
import { enrollmentHttp, pollServiceEnrollmentOperation, requestServiceEnrollmentOperation } from "../src/enrollment";

const requested = {
  ok: true,
  deviceCode: "d".repeat(43),
  expiresIn: 86_400,
  interval: 5,
  principalUserId: "u",
  enrollmentId: "e",
  principalCreated: true,
  service: "git-review",
  issuer: "https://home.example",
  scope: "knowledge:read",
} as const;

describe("enrollmentHttp", () => {
  it("a request answers 200 { deviceCode, expires_in: 86400, interval: 5 } and nothing else", () => {
    const res = enrollmentHttp({ op: "request", result: requested });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deviceCode: "d".repeat(43), expires_in: 86_400, interval: 5 });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(requestServiceEnrollmentOperation.output.parse(res.body)).toEqual(res.body);
  });

  it.each([
    ["invalid_token", 401],
    ["replayed_token", 401],
    ["invalid_scope", 400],
    ["too_many_enrollments", 429],
    ["too_many_agents", 429],
    ["node_full", 429],
    ["jwks_unavailable", 503],
  ] as const)("request refusal %s is %i with a fixed body and no-store", (reason, status) => {
    const res = enrollmentHttp({ op: "request", result: { ok: false, reason } });
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: reason });
    expect(res.refusal).toBe(reason);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("a poll that issued the key answers 200 with the sealed key, ids and status pending", () => {
    const res = enrollmentHttp({
      op: "poll",
      result: { ok: true, sealedKey: "a.b.c.d.e", credentialId: "c", userId: "u", enrollmentId: "e", pendingExpiresAt: "2026-11-11T12:15:00.000Z" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sealedKey: "a.b.c.d.e", credentialId: "c", userId: "u", status: "pending", pendingExpiresAt: "2026-11-11T12:15:00.000Z" });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(pollServiceEnrollmentOperation.output.parse(res.body)).toEqual(res.body);
  });

  it.each(["authorization_pending", "slow_down", "access_denied", "expired_token"] as const)("poll error %s is 400 { error } (RFC 8628)", (error) => {
    const res = enrollmentHttp({ op: "poll", result: { ok: false, error } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("an invalid body is 400", () => {
    expect(enrollmentHttp({ op: "invalid_input" })).toMatchObject({ status: 400, body: { error: "invalid input" } });
    expect(requestServiceEnrollmentOperation.input.safeParse({}).success).toBe(false);
    expect(pollServiceEnrollmentOperation.input.safeParse({ deviceCode: "" }).success).toBe(false);
  });
});
