// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import { createPinnedJwksFetch, isPrivateAddress, JwksFetchError, type PinnedTransport } from "../src/jwks-fetch";

describe("isPrivateAddress (refuse private, loopback, link-local and reserved ranges)", () => {
  it("refuses every private IPv4 range, loopback, link-local (cloud metadata), CGNAT, multicast and reserved", () => {
    for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "127.9.9.9", "169.254.169.254", "100.64.0.1", "100.127.255.254", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.5"])
      expect(isPrivateAddress(ip), ip).toBe(true);
  });

  it("allows ordinary public IPv4 addresses, including the edges of the private ranges", () => {
    for (const ip of ["8.8.8.8", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "11.0.0.1", "169.253.0.1"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("refuses IPv6 loopback, unspecified, unique-local, link-local, multicast, documentation and v4-mapped private addresses", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:a00:1", "64:ff9b::7f00:1", "[::1]"])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("an unparseable address is private (fail closed)", () => {
    for (const ip of ["", "example.com", "999.1.1.1", "1.2.3", "gggg::1"]) expect(isPrivateAddress(ip), ip).toBe(true);
  });
});

describe("createPinnedJwksFetch", () => {
  const ok: PinnedTransport = vi.fn(async () => ({ status: 200, body: '{"keys":[]}' }));
  const build = (over: { addresses?: Array<{ address: string; family: number }>; transport?: PinnedTransport } = {}) => {
    const resolve = vi.fn(async () => over.addresses ?? [{ address: "93.184.216.34", family: 4 }]);
    const transport = over.transport ?? (vi.fn(ok) as unknown as PinnedTransport);
    return { fetchJwks: createPinnedJwksFetch({ resolve, transport }), resolve, transport: transport as ReturnType<typeof vi.fn> };
  };
  const reason = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof JwksFetchError ? e.reason : `other:${String(e)}`));
  const URI = "https://toks5.example.org/.well-known/jwks.json";

  it("fetches over https from the resolved, checked address and parses the JSON; the socket is pinned to that address with a 5 s and 64 KB budget", async () => {
    const { fetchJwks, transport } = build();
    expect(await fetchJwks(URI)).toEqual({ keys: [] });
    const request = transport.mock.calls[0]?.[0] as { url: URL; address: string; family: number; timeoutMs: number; maxBytes: number };
    expect(request.url.href).toBe(URI);
    expect(request).toMatchObject({ address: "93.184.216.34", family: 4, timeoutMs: 5_000, maxBytes: 64 * 1024 });
  });

  it("refuses http, credentials in the URL and an unparseable URI before any lookup or request", async () => {
    const { fetchJwks, resolve, transport } = build();
    expect(await reason(fetchJwks("http://toks5.example.org/.well-known/jwks.json"))).toBe("not_https");
    expect(await reason(fetchJwks("https://user:pw@toks5.example.org/.well-known/jwks.json"))).toBe("credentials_in_uri");
    expect(await reason(fetchJwks("not a uri"))).toBe("bad_uri");
    expect(resolve).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses a host that resolves to ANY private address, even when another answer is public, and never makes the request", async () => {
    for (const private_ of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "::1", "fd00::1"]) {
      const { fetchJwks, transport } = build({ addresses: [{ address: "93.184.216.34", family: 4 }, { address: private_, family: private_.includes(":") ? 6 : 4 }] });
      expect(await reason(fetchJwks(URI)), private_).toBe("private_address");
      expect(transport).not.toHaveBeenCalled();
    }
  });

  it("a literal private IP host is refused without a lookup; a literal public IP is fetched as is", async () => {
    const { fetchJwks, resolve, transport } = build();
    expect(await reason(fetchJwks("https://127.0.0.1/.well-known/jwks.json"))).toBe("private_address");
    expect(await reason(fetchJwks("https://[::1]/.well-known/jwks.json"))).toBe("private_address");
    expect(resolve).not.toHaveBeenCalled();
    expect(await reason(fetchJwks("https://93.184.216.34/.well-known/jwks.json"))).toBe("ok");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("pins the FIRST checked address: a DNS answer that changes later changes nothing", async () => {
    let answers = [{ address: "93.184.216.34", family: 4 }];
    const resolve = vi.fn(async () => answers);
    const transport = vi.fn(ok);
    const fetchJwks = createPinnedJwksFetch({ resolve, transport });
    await fetchJwks(URI);
    answers = [{ address: "10.0.0.1", family: 4 }];
    expect((transport.mock.calls[0]?.[0] as { address: string }).address).toBe("93.184.216.34");
    // The next fetch resolves again and is refused.
    expect(await reason(fetchJwks(URI))).toBe("private_address");
  });

  it("a redirect, another status, an oversize body, a non-JSON body and an unresolvable host are refused with a short reason", async () => {
    const respond = (status: number, body = "{}") => build({ transport: (async () => ({ status, body })) as PinnedTransport }).fetchJwks(URI);
    expect(await reason(respond(301))).toBe("redirect");
    expect(await reason(respond(302))).toBe("redirect");
    expect(await reason(respond(404))).toBe("bad_status");
    expect(await reason(respond(200, "x".repeat(64 * 1024 + 1)))).toBe("too_large");
    expect(await reason(respond(200, "<html>"))).toBe("not_json");
    const gone = createPinnedJwksFetch({ resolve: async () => Promise.reject(new Error("ENOTFOUND")), transport: ok });
    expect(await reason(gone(URI))).toBe("unresolvable");
    const none = createPinnedJwksFetch({ resolve: async () => [], transport: ok });
    expect(await reason(none(URI))).toBe("unresolvable");
  });

  it("a transport failure (timeout, socket error) passes through as a JwksFetchError", async () => {
    const { fetchJwks } = build({ transport: (async () => Promise.reject(new JwksFetchError("timeout"))) as PinnedTransport });
    expect(await reason(fetchJwks(URI))).toBe("timeout");
  });
});
