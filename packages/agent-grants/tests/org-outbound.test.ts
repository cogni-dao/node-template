// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * The outbound side of a link (task.0181), through the package entry: the admin enters only the link code; the target's origin, node id and the org id come from the code; a preview is
 * a POST with the code in the body, must name the origin the code names, and a link is signed only if a fresh preview still names the org the admin confirmed; only the secret is signed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOrgOutbound, encodeLinkCode, LINK_PATH, LINK_PREVIEW_PATH, type OutboundSent } from "../src";
import { createServiceAssertionSignerFromSeed, peekUnverifiedClaims } from "../src/service-auth";

const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const Y = "https://node-template.example.org";
const SECRET = "S".repeat(43);
const CODE = encodeLinkCode({ origin: Y, nodeId: "node-template", orgUserId: "org-1", secret: SECRET });
const ok = (body: unknown, status = 200) => ({ status, body: JSON.stringify(body) });

describe("outbound link: the code names the target", () => {
  let http: ReturnType<typeof vi.fn>;
  let sent: ReturnType<typeof vi.fn>;
  const build = async (opts: { signer?: boolean } = {}) => {
    const signer = opts.signer === false ? null : await createServiceAssertionSignerFromSeed({ issuer: "https://toks5.example.org", seedHex: SEED });
    return createOrgOutbound({ http: http as never, getSigner: async () => signer, onSent: sent as (s: OutboundSent) => void });
  };

  beforeEach(() => {
    http = vi.fn(async () => ok({ orgName: "toks5 org", origin: Y }));
    sent = vi.fn();
  });

  it("a preview POSTs the code in the BODY (never a URL) to the origin the code names, and returns the org name and origin", async () => {
    const outbound = await build();
    expect(await outbound.preview(CODE)).toEqual({ ok: true, preview: { orgName: "toks5 org", origin: Y } });
    const [url, init] = http.mock.calls[0] as [string, { method: string; body: string; headers: Record<string, string> }];
    expect(url).toBe(`${Y}${LINK_PREVIEW_PATH}`);
    expect(url).not.toContain(SECRET);
    expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(JSON.parse(init.body)).toEqual({ code: CODE });
  });

  it("a code that is not a link code is refused before any request; so is a bare secret", async () => {
    const outbound = await build();
    for (const bad of ["", "nope", SECRET, "a.b"]) expect(await outbound.preview(bad), bad).toEqual({ ok: false, reason: "invalid_code" });
    expect(await outbound.sign({ act: "unlink", code: "nope" })).toEqual({ ok: false, reason: "invalid_code" });
    expect(http).not.toHaveBeenCalled();
  });

  it("a node that answers for another origin, a 404, a bad body or a failure is refused with its own reason", async () => {
    const outbound = await build();
    http.mockResolvedValueOnce(ok({ orgName: "x", origin: "https://evil.example.org" }));
    expect(await outbound.preview(CODE)).toEqual({ ok: false, reason: "preview_mismatch" });
    http.mockResolvedValueOnce(ok({ error: "not_found" }, 404));
    expect(await outbound.preview(CODE)).toEqual({ ok: false, reason: "code_not_found" });
    http.mockResolvedValueOnce({ status: 200, body: "<html>" });
    expect(await outbound.preview(CODE)).toEqual({ ok: false, reason: "unreachable" });
    http.mockResolvedValueOnce(ok({ orgName: "", origin: Y }));
    expect(await outbound.preview(CODE)).toEqual({ ok: false, reason: "preview_mismatch" });
    http.mockRejectedValueOnce(new Error("private_address"));
    expect(await outbound.preview(CODE)).toEqual({ ok: false, reason: "unreachable" });
  });

  it("a link signs only the secret, as node-connect, for the node and org the code names, and posts once to the fixed path", async () => {
    const outbound = await build();
    http.mockResolvedValueOnce(ok({ orgName: "toks5 org", origin: Y })); // the fresh preview
    http.mockResolvedValueOnce(ok({ act: "link", orgUserId: "org-1", services: ["node-ai"], linkId: "l1" }, 201));
    const result = await outbound.sign({ act: "link", code: CODE, services: ["node-ai"], expectOrgName: "toks5 org" });
    expect(result).toEqual({ ok: true, httpStatus: 201, error: null, act: "link" });
    expect(http).toHaveBeenCalledTimes(2);
    const [url, init] = http.mock.calls[1] as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe(`${Y}${LINK_PATH}`);
    expect(init).toMatchObject({ method: "POST", body: "{}" });
    const claims = peekUnverifiedClaims((init.headers.authorization as string).replace(/^Bearer /, ""));
    expect(claims).toMatchObject({ sub: "node-connect", aud: "urn:cogni:node:node-template", iss: "https://toks5.example.org", act: "link", org: "org-1", code: SECRET, services: "node-ai" });
    expect(sent).toHaveBeenCalledWith({ act: "link", targetOrigin: Y, httpStatus: 201, error: null });
    expect(JSON.stringify(sent.mock.calls)).not.toContain(SECRET);
  });

  it("a link is not signed when the name changed since the admin confirmed it, or when a link has no services or no confirmed name", async () => {
    const outbound = await build();
    http.mockResolvedValueOnce(ok({ orgName: "a different org", origin: Y }));
    expect(await outbound.sign({ act: "link", code: CODE, services: ["node-ai"], expectOrgName: "toks5 org" })).toEqual({ ok: false, reason: "preview_changed" });
    expect(http).toHaveBeenCalledTimes(1); // only the preview: nothing signed, nothing posted
    expect(await outbound.sign({ act: "link", code: CODE, services: [], expectOrgName: "toks5 org" })).toEqual({ ok: false, reason: "invalid_input" });
    expect(await outbound.sign({ act: "link", code: CODE, services: ["node-ai"] })).toEqual({ ok: false, reason: "invalid_input" });
    expect(http).toHaveBeenCalledTimes(1);
    expect(sent).not.toHaveBeenCalled();
  });

  it("with no signing key nothing is posted; an unlink needs no preview and signs only act and org", async () => {
    const none = await build({ signer: false });
    http.mockResolvedValueOnce(ok({ orgName: "toks5 org", origin: Y }));
    expect(await none.sign({ act: "link", code: CODE, services: ["node-ai"], expectOrgName: "toks5 org" })).toEqual({ ok: false, reason: "no_signer" });
    expect(http).toHaveBeenCalledTimes(1);
    const outbound = await build();
    http.mockClear();
    http.mockResolvedValueOnce(ok({ act: "unlink", orgUserId: "org-1", services: ["node-ai"], linkId: "l1" }));
    expect(await outbound.sign({ act: "unlink", code: CODE })).toEqual({ ok: true, httpStatus: 200, error: null, act: "unlink" });
    expect(http).toHaveBeenCalledTimes(1);
    const [, init] = http.mock.calls[0] as [string, { headers: Record<string, string> }];
    const claims = peekUnverifiedClaims((init.headers.authorization as string).replace(/^Bearer /, ""));
    expect(claims).toMatchObject({ act: "unlink", org: "org-1" });
    expect(claims).not.toHaveProperty("code");
  });

  it("the target's refusal is passed on as its short code, a hostile body is dropped, and an unreachable target is reported", async () => {
    const outbound = await build();
    http.mockResolvedValueOnce(ok({ error: "link_code_invalid" }, 400));
    expect(await outbound.sign({ act: "unlink", code: CODE })).toEqual({ ok: true, httpStatus: 400, error: "link_code_invalid", act: null });
    http.mockResolvedValueOnce(ok({ error: "<script>alert(1)</script>" }, 400));
    expect(await outbound.sign({ act: "unlink", code: CODE })).toMatchObject({ error: null });
    http.mockRejectedValueOnce(new Error("timeout"));
    expect(await outbound.sign({ act: "unlink", code: CODE })).toEqual({ ok: false, reason: "unreachable" });
  });
});
