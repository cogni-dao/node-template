// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/identity-client/tests`
 * Purpose: Verify the public authorize URL response reader.
 * Scope: Injected responses and errors only.
 * Invariants: No external network or consumer UI is involved.
 * Side-effects: none
 * Links: ../src/index.ts
 * @internal
 */
import { describe, expect, it, vi } from "vitest";
import { requestAuthorizeUrl } from "../src/index.js";

const secret = "SENTINEL-SECRET";
const response = (body: unknown, ok = true) => ({
  ok,
  json: vi.fn().mockResolvedValue(body),
});

async function expectSafeFailure(
  request: () => Promise<{ readonly ok: boolean; json(): Promise<unknown> }>,
) {
  try {
    await requestAuthorizeUrl(request);
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain("expected failure");
    expect(error).not.toHaveProperty("cause");
  }
}

describe("requestAuthorizeUrl", () => {
  it("calls the request and decoder once and returns the original valid string", async () => {
    for (const url of [
      "https://example.com/path",
      "http://example.com",
      "  https://example.com/a b  ",
      "https:example.com",
      "https://user:pass@example.com/é",
      "https://example.com/a\tb\nc",
    ]) {
      const result = response({ authorizeUrl: url });
      const request = vi.fn().mockResolvedValue(result);
      expect(await requestAuthorizeUrl(request)).toBe(url);
      expect(request).toHaveBeenCalledTimes(1);
      expect(result.json).toHaveBeenCalledTimes(1);
    }
  });

  it("does not decode non-ok responses", async () => {
    const result = response(secret, false);
    const request = vi.fn().mockResolvedValue(result);
    await expectSafeFailure(request);
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.json).not.toHaveBeenCalled();
  });

  it("replaces thrown and rejected request and JSON errors", async () => {
    const throwing = vi.fn(() => {
      throw new Error(secret);
    });
    await expectSafeFailure(throwing);
    expect(throwing).toHaveBeenCalledTimes(1);
    const rejecting = vi.fn().mockRejectedValue(secret);
    await expectSafeFailure(rejecting);
    expect(rejecting).toHaveBeenCalledTimes(1);
    const json = vi.fn().mockRejectedValue(new Error(secret));
    await expectSafeFailure(async () => ({ ok: true, json }));
    expect(json).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    undefined,
    true,
    42,
    "text",
    [],
    {},
    { authorizeUrl: null },
    { authorizeUrl: 5 },
    { authorizeUrl: false },
    { authorizeUrl: [] },
    { authorizeUrl: {} },
    { authorizeUrl: "" },
    { authorizeUrl: " \t\n " },
  ])("rejects invalid body %# safely", async (body) => {
    await expectSafeFailure(async () => response(body));
  });

  it.each([
    "/relative",
    "//example.com",
    "http://",
    "https://[",
    `javascript:${secret}`,
    `data:text/plain,${secret}`,
    `https://${secret} invalid host`,
  ])("rejects invalid URL %# safely", async (url) => {
    await expectSafeFailure(async () => response({ authorizeUrl: url }));
  });

  it("accepts an array carrying the named field like the original decoder", async () => {
    const body: unknown[] & { authorizeUrl?: string } = [];
    body.authorizeUrl = "https://example.com";
    expect(await requestAuthorizeUrl(async () => response(body))).toBe(
      body.authorizeUrl,
    );
  });
});
