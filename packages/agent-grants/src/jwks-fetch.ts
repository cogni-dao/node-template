// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/jwks-fetch`
 * Purpose: The ONE way a node makes an HTTPS request to another node's origin: its signing keys (`createServiceAssertionVerifier({ fetchJwks })`), a link code's preview and a signed
 *   link. https only, no redirects, a 5-second budget that includes the DNS lookup, a 64 KB response limit, a refusal of any host that resolves to a private, loopback, link-local or
 *   otherwise non-global address, and a connection pinned to the address that was checked.
 * Scope: Node runtime only (`node:dns`, `node:https`, `node:net`). It is its own entry point so the platform-neutral modules never import a `node:` module.
 * Invariants:
 *   - FETCH_RULES: every link, preview and key refetch obeys the same rules (the origin is named by whoever typed a code or an origin, so the request is an SSRF door).
 *   - ANY_PRIVATE_ADDRESS_REFUSES: if ANY address the host resolves to is private, loopback, link-local, site-local, multicast, carrier-grade NAT, documentation, 6to4, Teredo,
 *     IPv4-compatible or otherwise outside the global unicast range, the request is refused. An IPv6 address that embeds an IPv4 address (mapped, NAT64) is judged by that address.
 *   - ONE_BUDGET: the lookup and the request share `timeoutMs` (5 s); a slow resolver cannot stretch it.
 *   - PINNED_ADDRESS: the socket connects to the first checked address; TLS still verifies the host name. A DNS answer that changes after the check changes nothing.
 *   - A literal IP host is checked as an address; a URL with credentials, a non-https scheme or a redirect status is refused. Nothing in an error carries a response body.
 * Side-effects: IO (DNS, HTTPS)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export const JWKS_FETCH_TIMEOUT_MS = 5_000;
export const JWKS_FETCH_MAX_BYTES = 64 * 1024;

/** A refused or failed request. `reason` is a short code, never a body. */
export class JwksFetchError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "JwksFetchError";
    this.reason = reason;
  }
}

const ipv4Parts = (address: string): number[] | null => {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
};

function isPrivateV4(address: string): boolean {
  const p = ipv4Parts(address);
  if (!p) return true;
  const [a, b, c] = p as [number, number, number, number];
  return (
    a === 0 || // this network
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // documentation
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast and reserved
  );
}

/** The eight 16-bit groups of an IPv6 address (an embedded dotted IPv4 tail is folded in), or null when it is not one. */
function parseV6(input: string): number[] | null {
  let a = (input.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] as string).trim();
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (dotted) {
    const p = ipv4Parts(dotted[2] as string);
    if (!p) return null;
    a = `${dotted[1]}${(((p[0] as number) << 8) | (p[1] as number)).toString(16)}:${(((p[2] as number) << 8) | (p[3] as number)).toString(16)}`;
  }
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? (halves[0] as string).split(":") : [];
  const tail = halves.length === 2 && halves[1] ? (halves[1] as string).split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  const parts = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (parts.length !== 8 || !parts.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return parts.map((g) => Number.parseInt(g, 16));
}

const v4Of = (hi: number, lo: number): string => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function isPrivateV6(address: string): boolean {
  const g = parseV6(address);
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const zeroTo4 = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // ::ffff:a.b.c.d is that IPv4 address.
  if (zeroTo4 && g5 === 0xffff) return isPrivateV4(v4Of(g6, g7));
  // ::, ::1 and every IPv4-compatible `::a.b.c.d` / `::a00:1` (the whole ::/96) are refused.
  if (zeroTo4 && g5 === 0) return true;
  // NAT64 64:ff9b::/96 is that IPv4 address; the local-use 64:ff9b:1::/48 is refused.
  if (g0 === 0x64 && g1 === 0xff9b) return g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 ? isPrivateV4(v4Of(g6, g7)) : true;
  // Only global unicast 2000::/3 can be fetched from; that already refuses unique-local fc00::/7, link-local fe80::/10, site-local fec0::/10, multicast ff00::/8 and 100::/64.
  if ((g0 & 0xe000) !== 0x2000) return true;
  if (g0 === 0x2002) return true; // 6to4 embeds an IPv4 address a node cannot vouch for
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo 2001::/32
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  return false;
}

/** True for any address a node must never fetch from: non-global, private, loopback, link-local, multicast, carrier-grade NAT, documentation or reserved. An unparseable address is private (fail closed). */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family === 4) return isPrivateV4(bare);
  if (family === 6) return isPrivateV6(bare);
  return true;
}

export interface PinnedRequest {
  readonly url: URL;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
  /** The checked address the socket must connect to. */
  readonly address: string;
  readonly family: 4 | 6;
  /** What is left of the budget after the lookup. */
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

/** One HTTPS request to a pinned address. Resolves with the status and body text; rejects on a timeout, an oversize body or a socket error. Never follows a redirect. */
export type PinnedTransport = (request: PinnedRequest) => Promise<{ readonly status: number; readonly body: string }>;

/** The default transport: `node:https` with the lookup replaced by the pinned address, so TLS still checks the host name against the certificate. */
export const nodeHttpsTransport: PinnedTransport = (req) =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const call = httpsRequest(
      req.url,
      {
        method: req.method,
        headers: { accept: "application/json", "user-agent": "cogni-node", ...req.headers, ...(req.body !== null ? { "content-length": String(Buffer.byteLength(req.body)) } : {}) },
        // Pin: whatever the name resolves to later, the socket goes to the address that was checked.
        lookup: (_host, options, callback) => {
          const cb = callback as (err: Error | null, address: unknown, family?: number) => void;
          if ((options as { all?: boolean }).all) cb(null, [{ address: req.address, family: req.family }]);
          else cb(null, req.address, req.family);
        },
      },
      (res) => {
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > req.maxBytes) {
            call.destroy();
            settle(() => reject(new JwksFetchError("too_large")));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => settle(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })));
        res.on("error", () => settle(() => reject(new JwksFetchError("read_failed"))));
      }
    );
    const timer = setTimeout(() => {
      call.destroy();
      settle(() => reject(new JwksFetchError("timeout")));
    }, Math.max(1, req.timeoutMs));
    call.on("error", () => settle(() => reject(new JwksFetchError("request_failed"))));
    if (req.body !== null) call.write(req.body);
    call.end();
  });

export interface PinnedHttpOptions {
  /** Resolve a host to every address it has. Default: `node:dns` lookup with `all: true`. */
  resolve?: (host: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;
  transport?: PinnedTransport;
  timeoutMs?: number;
  maxBytes?: number;
  /** Epoch milliseconds, for the shared budget. Default `Date.now`. */
  now?: () => number;
}

export interface PinnedInit {
  method?: "GET" | "POST";
  headers?: Readonly<Record<string, string>>;
  body?: string;
}

/**
 * A request function for another node's origin: https only, no credentials in the URL, the host resolved once INSIDE the budget, every address checked (any non-global address
 * refuses), the connection pinned to the first one, a 5-second budget for lookup and request together, a 64 KB response limit, a redirect refused. Throws `JwksFetchError` with a
 * short `reason`; a non-2xx status is returned to the caller, which decides.
 */
export function createPinnedHttp(options: PinnedHttpOptions = {}): (uri: string, init?: PinnedInit) => Promise<{ status: number; body: string }> {
  const resolve = options.resolve ?? (async (host: string) => dnsLookup(host, { all: true, verbatim: true }));
  const transport = options.transport ?? nodeHttpsTransport;
  const timeoutMs = options.timeoutMs ?? JWKS_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? JWKS_FETCH_MAX_BYTES;
  const now = options.now ?? Date.now;
  return async (uri, init = {}) => {
    const started = now();
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      throw new JwksFetchError("bad_uri");
    }
    if (url.protocol !== "https:") throw new JwksFetchError("not_https");
    if (url.username || url.password) throw new JwksFetchError("credentials_in_uri");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    let addresses: ReadonlyArray<{ address: string; family: number }>;
    if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
    else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // The lookup shares the budget: a resolver that never answers cannot hold the request past `timeoutMs`.
        addresses = await Promise.race([
          resolve(host),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new JwksFetchError("timeout")), timeoutMs);
          }),
        ]);
      } catch (error) {
        throw error instanceof JwksFetchError ? error : new JwksFetchError("unresolvable");
      } finally {
        clearTimeout(timer);
      }
    }
    if (addresses.length === 0) throw new JwksFetchError("unresolvable");
    if (addresses.some((a) => isPrivateAddress(a.address))) throw new JwksFetchError("private_address");
    const left = timeoutMs - (now() - started);
    if (left <= 0) throw new JwksFetchError("timeout");
    const pinned = addresses[0] as { address: string; family: number };
    const response = await transport({
      url,
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body ?? null,
      address: pinned.address,
      family: pinned.family === 6 ? 6 : 4,
      timeoutMs: left,
      maxBytes,
    });
    if (response.status >= 300 && response.status < 400) throw new JwksFetchError("redirect");
    if (response.body.length > maxBytes) throw new JwksFetchError("too_large");
    return response;
  };
}

/** A `fetchJwks` for `createServiceAssertionVerifier`: `createPinnedHttp` plus a 200 status and a JSON body. Throws `JwksFetchError` with a short `reason`. */
export function createPinnedJwksFetch(options: PinnedHttpOptions = {}): (jwksUri: string) => Promise<unknown> {
  const http = createPinnedHttp(options);
  return async (jwksUri) => {
    const response = await http(jwksUri);
    if (response.status !== 200) throw new JwksFetchError("bad_status");
    try {
      return JSON.parse(response.body) as unknown;
    } catch {
      throw new JwksFetchError("not_json");
    }
  };
}

export type PinnedJwksFetchOptions = PinnedHttpOptions;
