// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/jwks-fetch`
 * Purpose: The ONE way a node fetches another node's signing keys (`createServiceAssertionVerifier({ fetchJwks })`): https only, no redirects, a 5-second timeout, a 64 KB limit, a
 *   refusal of any host that resolves to a private, loopback or link-local range, and a connection pinned to the address that was checked.
 * Scope: Node runtime only (`node:dns`, `node:https`, `node:net`). It is its own entry point so the platform-neutral modules never import a `node:` module.
 * Invariants:
 *   - FETCH_RULES: every link and every key refetch obeys the same rules (a link's issuer is named by whoever typed an origin, so the fetch is an SSRF door).
 *   - ANY_PRIVATE_ADDRESS_REFUSES: if ANY address the host resolves to is private, loopback, link-local, multicast, carrier-grade NAT or reserved, the fetch is refused.
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

/** A refused or failed key fetch. `reason` is a short code, never a body. */
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

/** The two 16-bit groups at the end of an IPv6 address as an IPv4 string (for `::ffff:a.b.c.d` and `64:ff9b::a.b.c.d`), or null. */
function embeddedV4(address: string): string | null {
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (dotted) return dotted[1] as string;
  const hex = /:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex) return null;
  const hi = Number.parseInt(hex[1] as string, 16);
  const lo = Number.parseInt(hex[2] as string, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

function isPrivateV6(address: string): boolean {
  const a = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] as string;
  if (a === "::" || a === "::1") return true;
  if (/^::ffff:/.test(a) || /^64:ff9b::/.test(a) || /^::\d/.test(a)) {
    const v4 = embeddedV4(a);
    return v4 === null ? true : isPrivateV4(v4);
  }
  const first = Number.parseInt(a.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xff00) === 0xff00 || // multicast
    a.startsWith("2001:db8") // documentation
  );
}

/** True for any address a node must never fetch from: private, loopback, link-local, multicast, carrier-grade NAT, documentation or reserved. An unparseable address is private (fail closed). */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address.replace(/^\[|\]$/g, ""));
  if (family === 4) return isPrivateV4(address);
  if (family === 6) return isPrivateV6(address);
  return true;
}

export interface PinnedRequest {
  readonly url: URL;
  /** The checked address the socket must connect to. */
  readonly address: string;
  readonly family: 4 | 6;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

/** One HTTPS GET to a pinned address. Resolves with the status and body text; rejects on a timeout, an oversize body or a socket error. Never follows a redirect. */
export type PinnedTransport = (request: PinnedRequest) => Promise<{ readonly status: number; readonly body: string }>;

/** The default transport: `node:https` with the lookup replaced by the pinned address, so TLS still checks the host name against the certificate. */
export const nodeHttpsTransport: PinnedTransport = (req) =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const done = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };
    const call = httpsRequest(
      req.url,
      {
        method: "GET",
        headers: { accept: "application/json", "user-agent": "cogni-node" },
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
            done(() => reject(new JwksFetchError("too_large")));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => done(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })));
        res.on("error", () => done(() => reject(new JwksFetchError("read_failed"))));
      }
    );
    const timer = setTimeout(() => {
      call.destroy();
      reject(new JwksFetchError("timeout"));
    }, req.timeoutMs);
    call.on("error", () => done(() => reject(new JwksFetchError("request_failed"))));
    call.end();
  });

export interface PinnedJwksFetchOptions {
  /** Resolve a host to every address it has. Default: `node:dns` lookup with `all: true`. */
  resolve?: (host: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;
  transport?: PinnedTransport;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * A `fetchJwks` for `createServiceAssertionVerifier`: https only, no credentials in the URL, the host resolved once, every address checked (any private address refuses), the
 * connection pinned to the first one, a 5-second timeout, a 64 KB limit, a redirect refused, a non-200 refused. Throws `JwksFetchError` with a short `reason`.
 */
export function createPinnedJwksFetch(options: PinnedJwksFetchOptions = {}): (jwksUri: string) => Promise<unknown> {
  const resolve = options.resolve ?? (async (host: string) => dnsLookup(host, { all: true, verbatim: true }));
  const transport = options.transport ?? nodeHttpsTransport;
  const timeoutMs = options.timeoutMs ?? JWKS_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? JWKS_FETCH_MAX_BYTES;
  return async (jwksUri) => {
    let url: URL;
    try {
      url = new URL(jwksUri);
    } catch {
      throw new JwksFetchError("bad_uri");
    }
    if (url.protocol !== "https:") throw new JwksFetchError("not_https");
    if (url.username || url.password) throw new JwksFetchError("credentials_in_uri");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    let addresses: ReadonlyArray<{ address: string; family: number }>;
    if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
    else {
      try {
        addresses = await resolve(host);
      } catch {
        throw new JwksFetchError("unresolvable");
      }
    }
    if (addresses.length === 0) throw new JwksFetchError("unresolvable");
    if (addresses.some((a) => isPrivateAddress(a.address))) throw new JwksFetchError("private_address");
    const pinned = addresses[0] as { address: string; family: number };
    const response = await transport({ url, address: pinned.address, family: pinned.family === 6 ? 6 : 4, timeoutMs, maxBytes });
    if (response.status !== 200) throw new JwksFetchError(response.status >= 300 && response.status < 400 ? "redirect" : "bad_status");
    if (response.body.length > maxBytes) throw new JwksFetchError("too_large");
    try {
      return JSON.parse(response.body) as unknown;
    } catch {
      throw new JwksFetchError("not_json");
    }
  };
}
