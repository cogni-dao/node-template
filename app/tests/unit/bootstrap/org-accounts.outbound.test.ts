// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/org-accounts.outbound`
 * Purpose: This node as the OTHER node in a link (task.0181): the admin enters only the link code; the target's origin, node id and the org id come from the code; a preview is fetched
 *   through the pinned request path and must name the origin the code names; a link is signed only if a fresh preview still names the org the admin confirmed; only the secret is signed.
 * Scope: The real `createOrgAccounts` over a fake sql and an injected request function; no database, no network.
 * Side-effects: none
 */

import { encodeLinkCode } from "@cogni/agent-grants";
import { createServiceAssertionSignerFromSeed, peekUnverifiedClaims } from "@cogni/agent-grants/service-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAuthoritySql } from "@/bootstrap/agent-authority";
import { createOrgAccounts } from "@/bootstrap/org-accounts";

const SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const Y = "https://node-template.example.org";
const SECRET = "S".repeat(43);
const CODE = encodeLinkCode({ origin: Y, nodeId: "node-template", orgUserId: "org-1", secret: SECRET });

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const sql = (() => Promise.resolve([])) as unknown as AgentAuthoritySql;
const ok = (body: unknown, status = 200) => ({ status, body: JSON.stringify(body) });

describe("outbound link: the code names the target", () => {
  let http: ReturnType<typeof vi.fn>;
  const build = async (opts: { signer?: boolean } = {}) => {
    const signer = opts.signer === false ? null : await createServiceAssertionSignerFromSeed({ issuer: "https://toks5.example.org", seedHex: SEED });
    return createOrgAccounts({ sql, log: log as never, nodeId: "toks5", selfOrigin: "https://toks5.example.org", getSigner: async () => signer, http: http as never });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    http = vi.fn(async () => ok({ orgName: "toks5 org", origin: Y }));
  });

  it("a preview asks the origin the code names, with the code, and returns the org name and origin", async () => {
    const accounts = await build();
    expect(await accounts.previewOutbound(CODE)).toEqual({ ok: true, preview: { orgName: "toks5 org", origin: Y } });
    const [url] = http.mock.calls[0] as [string];
    expect(url).toBe(`${Y}/api/v1/orgs/link-preview?code=${encodeURIComponent(CODE)}`);
  });

  it("a code that is not a link code is refused before any request; so is a bare secret", async () => {
    const accounts = await build();
    for (const bad of ["", "nope", SECRET, "a.b"]) expect(await accounts.previewOutbound(bad), bad).toEqual({ ok: false, reason: "invalid_code" });
    expect(await accounts.signOutbound({ act: "unlink", code: "nope" })).toEqual({ ok: false, reason: "invalid_code" });
    expect(http).not.toHaveBeenCalled();
  });

  it("a node that answers for another origin, a 404, a bad body or a failure is refused with its own reason", async () => {
    const accounts = await build();
    http.mockResolvedValueOnce(ok({ orgName: "x", origin: "https://evil.example.org" }));
    expect(await accounts.previewOutbound(CODE)).toEqual({ ok: false, reason: "preview_mismatch" });
    http.mockResolvedValueOnce(ok({ error: "not_found" }, 404));
    expect(await accounts.previewOutbound(CODE)).toEqual({ ok: false, reason: "code_not_found" });
    http.mockResolvedValueOnce({ status: 200, body: "<html>" });
    expect(await accounts.previewOutbound(CODE)).toEqual({ ok: false, reason: "unreachable" });
    http.mockResolvedValueOnce(ok({ orgName: "", origin: Y }));
    expect(await accounts.previewOutbound(CODE)).toEqual({ ok: false, reason: "preview_mismatch" });
    http.mockRejectedValueOnce(new Error("private_address"));
    expect(await accounts.previewOutbound(CODE)).toEqual({ ok: false, reason: "unreachable" });
  });

  it("a link signs only the secret, as node-connect, for the node and org the code names, and posts once to the fixed path", async () => {
    const accounts = await build();
    http.mockResolvedValueOnce(ok({ orgName: "toks5 org", origin: Y })); // the fresh preview
    http.mockResolvedValueOnce(ok({ act: "link", orgUserId: "org-1", services: ["node-ai"], linkId: "l1" }, 201));
    const result = await accounts.signOutbound({ act: "link", code: CODE, services: ["node-ai"], expectOrgName: "toks5 org" });
    expect(result).toEqual({ ok: true, httpStatus: 201, error: null, act: "link" });
    expect(http).toHaveBeenCalledTimes(2);
    const [url, init] = http.mock.calls[1] as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe(`${Y}/api/v1/orgs/link`);
    expect(init).toMatchObject({ method: "POST", body: "{}" });
    const claims = peekUnverifiedClaims((init.headers.authorization as string).replace(/^Bearer /, ""));
    expect(claims).toMatchObject({ sub: "node-connect", aud: "urn:cogni:node:node-template", iss: "https://toks5.example.org", act: "link", org: "org-1", code: SECRET, services: "node-ai" });
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(SECRET);
  });

  it("a link is not signed when the name changed since the admin confirmed it, or when a link has no services or no confirmed name", async () => {
    const accounts = await build();
    http.mockResolvedValueOnce(ok({ orgName: "a different org", origin: Y }));
    expect(await accounts.signOutbound({ act: "link", code: CODE, services: ["node-ai"], expectOrgName: "toks5 org" })).toEqual({ ok: false, reason: "preview_changed" });
    expect(http).toHaveBeenCalledTimes(1); // only the preview: nothing signed, nothing posted
    expect(await accounts.signOutbound({ act: "link", code: CODE, services: [], expectOrgName: "toks5 org" })).toEqual({ ok: false, reason: "invalid_input" });
    expect(await accounts.signOutbound({ act: "link", code: CODE, services: ["node-ai"] })).toEqual({ ok: false, reason: "invalid_input" });
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("with no signing key nothing is posted; an unlink needs no preview and signs only act and org", async () => {
    const none = await build({ signer: false });
    http.mockResolvedValueOnce(ok({ orgName: "toks5 org", origin: Y }));
    expect(await none.signOutbound({ act: "link", code: CODE, services: ["node-ai"], expectOrgName: "toks5 org" })).toEqual({ ok: false, reason: "no_signer" });
    expect(http).toHaveBeenCalledTimes(1);
    const accounts = await build();
    http.mockClear();
    http.mockResolvedValueOnce(ok({ act: "unlink", orgUserId: "org-1", services: ["node-ai"], linkId: "l1" }));
    expect(await accounts.signOutbound({ act: "unlink", code: CODE })).toEqual({ ok: true, httpStatus: 200, error: null, act: "unlink" });
    expect(http).toHaveBeenCalledTimes(1);
    const [, init] = http.mock.calls[0] as [string, { headers: Record<string, string> }];
    const claims = peekUnverifiedClaims((init.headers.authorization as string).replace(/^Bearer /, ""));
    expect(claims).toMatchObject({ act: "unlink", org: "org-1" });
    expect(claims).not.toHaveProperty("code");
  });

  it("the target's refusal is passed on as its short code, a hostile body is dropped, and an unreachable target is reported", async () => {
    const accounts = await build();
    http.mockResolvedValueOnce(ok({ error: "link_code_invalid" }, 400));
    expect(await accounts.signOutbound({ act: "unlink", code: CODE })).toEqual({ ok: true, httpStatus: 400, error: "link_code_invalid", act: null });
    http.mockResolvedValueOnce(ok({ error: "<script>alert(1)</script>" }, 400));
    expect(await accounts.signOutbound({ act: "unlink", code: CODE })).toMatchObject({ error: null });
    http.mockRejectedValueOnce(new Error("timeout"));
    expect(await accounts.signOutbound({ act: "unlink", code: CODE })).toEqual({ ok: false, reason: "unreachable" });
  });

  it("a node with no https origin of its own makes no link code, and previews nothing", async () => {
    const accounts = createOrgAccounts({ sql, log: log as never, nodeId: "n", selfOrigin: null, getSigner: async () => null, http: http as never });
    expect(await accounts.previewCode("a.b")).toBeNull();
    await expect(accounts.linkCode({ actorUserId: "u", orgUserId: "o", origin: "https://x.example.org" })).rejects.toThrow("self_origin_unavailable");
  });
});
