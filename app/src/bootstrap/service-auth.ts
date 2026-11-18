// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/service-auth`
 * Purpose: This node's thin wiring of `@cogni-dao/agent-grants` service assertions and orgs: the optional signer (this node as a home), the verifier over the
 *   trusted homes (this node as a target), and the org owner source over the node's repo-spec parser and wallet bindings.
 * Scope: Composition only. Reads three optional env values and one GitHub contents URL; every decision lives in the package. Never logs a token or a key.
 * Invariants:
 *   - ALL_OPTIONAL: no signing key = no signer (an outbound need is 503) and no jwks route; no trusted homes = every assertion is `untrusted_issuer`.
 *   - OWNER_READ_VIA_CONTENTS_API: the repo-spec is read from `api.github.com/.../contents/<path>` (default `.cogni/repo-spec.yaml`) (`Accept: application/vnd.github.raw`), never from
 *     the raw.githubusercontent.com CDN, whose five-minute cache would double the owners' staleness. 10 s timeout, 64 KiB cap, github.com repos only. A 403 or 429
 *     (rate limit) or any other failure is `OwnerSourceUnavailableError`.
 *   - APPROVERS_ONLY: owners are `activity_ledger.approvers` mapped to the users that bound those wallets (`user_bindings`, provider `wallet`, lowercase).
 *   - SINGLE_REPLICA_REPLAY: the replay store is in memory; a target with several replicas needs a shared store behind the same interface.
 * Side-effects: IO (HTTPS to GitHub, service-role reads)
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment, https://node-template.cognidao.org/knowledge/node-relationships-design
 * @internal
 */

import {
  canonicalRepoRef,
  createOwnerSources,
  DEFAULT_REPO_SPEC_PATH,
  createRepoSpecOwnerSource,
  OwnerSourceUnavailableError,
} from "@cogni/agent-grants/orgs";
import {
  createMemoryReplayStore,
  createServiceAssertionSigner,
  createServiceAssertionVerifier,
  type Ed25519PrivateJwk,
  isCanonicalHttpsOrigin,
  type ServiceAssertionResult,
  type ServiceAssertionSigner,
  type ServiceAssertionVerifier,
  type TrustedHome,
} from "@cogni/agent-grants/service-auth";
import type { OrgOwners } from "@cogni/agent-grants/orgs";
import { extractLedgerApprovers, parseRepoSpec } from "@cogni/repo-spec";
import type { Logger } from "pino";
import { EVENT_NAMES } from "@/shared/observability";
import type { AgentAuthoritySql } from "./agent-authority";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_REPO_SPEC_BYTES = 64 * 1024;

export interface ServiceAuth {
  /** This node as a home: null until the signing key and kid are configured. */
  readonly signer: ServiceAssertionSigner | null;
  /** This node as a target: refuses every assertion until a trusted home is configured. */
  readonly verifier: ServiceAssertionVerifier;
  /** Owner reads for org decisions (cached inside the source). */
  readonly owners: OrgOwners;
  /** Verify an assertion and log the outcome (`service_auth.verified` / `service_auth.rejected`). */
  verify(token: string): Promise<ServiceAssertionResult>;
}

/** The trusted-homes JSON, or `[]` when unset or unusable (every assertion is then `untrusted_issuer`: fail closed). */
export function parseTrustedHomes(raw: string | undefined): TrustedHome[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): TrustedHome[] => {
      const e = entry as { issuer?: unknown; jwksUri?: unknown; services?: unknown } | null;
      if (
        !e ||
        typeof e.issuer !== "string" ||
        !isCanonicalHttpsOrigin(e.issuer) ||
        typeof e.jwksUri !== "string" ||
        !e.jwksUri.startsWith("https://") ||
        !Array.isArray(e.services) ||
        !e.services.every((s) => typeof s === "string")
      )
        return [];
      return [{ issuer: e.issuer, jwksUri: e.jwksUri, services: e.services as string[] }];
    });
  } catch {
    return [];
  }
}

/** The signer from the two env values and this node's own origin; null when any is missing or unusable. */
export function buildSigner(env: {
  readonly SERVICE_ASSERTION_SIGNING_JWK?: string | undefined;
  readonly SERVICE_ASSERTION_SIGNING_KID?: string | undefined;
  readonly APP_BASE_URL?: string | undefined;
}): ServiceAssertionSigner | null {
  if (!env.SERVICE_ASSERTION_SIGNING_JWK || !env.SERVICE_ASSERTION_SIGNING_KID || !env.APP_BASE_URL) return null;
  try {
    return createServiceAssertionSigner({
      issuer: new URL(env.APP_BASE_URL).origin,
      kid: env.SERVICE_ASSERTION_SIGNING_KID,
      privateJwk: JSON.parse(env.SERVICE_ASSERTION_SIGNING_JWK) as Ed25519PrivateJwk,
    });
  } catch {
    return null;
  }
}

/** The repo-spec of `ref` at `path` on its default branch, through the GitHub contents API. Throws `OwnerSourceUnavailableError` on any failure. */
export async function fetchRepoSpecFromGithub(
  ref: string,
  path: string = DEFAULT_REPO_SPEC_PATH,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const canonical = canonicalRepoRef(ref, path);
  if (!canonical) throw new OwnerSourceUnavailableError("ref is not a github repo url or path is not a repo-spec path");
  const { pathname } = new URL(canonical.split("#")[0] as string);
  const url = `https://api.github.com/repos${pathname}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { accept: "application/vnd.github.raw", "x-github-api-version": "2022-11-28", "user-agent": "cogni-node" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (error) {
    throw new OwnerSourceUnavailableError("repo-spec fetch failed", error);
  }
  if (res.status === 403 || res.status === 429) throw new OwnerSourceUnavailableError("github rate limited");
  if (!res.ok) throw new OwnerSourceUnavailableError(`repo-spec fetch status ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_REPO_SPEC_BYTES) throw new OwnerSourceUnavailableError("repo-spec too large");
  const reader = res.body?.getReader();
  if (!reader) throw new OwnerSourceUnavailableError("repo-spec has no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REPO_SPEC_BYTES) {
      await reader.cancel();
      throw new OwnerSourceUnavailableError("repo-spec too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** The users that bound each of these lowercased wallets (`user_bindings`, provider `wallet`). */
export async function usersForWallets(sql: AgentAuthoritySql, wallets: string[]): Promise<string[]> {
  if (wallets.length === 0) return [];
  const rows = (await sql`
    SELECT DISTINCT user_id FROM user_bindings
    WHERE provider = 'wallet' AND external_id = ANY(${wallets})
    LIMIT 200`) as ReadonlyArray<{ user_id: string }>;
  return rows.map((row) => row.user_id);
}

export function createServiceAuth(deps: {
  env: {
    readonly SERVICE_ASSERTION_SIGNING_JWK?: string | undefined;
    readonly SERVICE_ASSERTION_SIGNING_KID?: string | undefined;
    readonly SERVICE_TRUSTED_HOMES?: string | undefined;
    readonly APP_BASE_URL?: string | undefined;
  };
  nodeId: string;
  sql: AgentAuthoritySql;
  log: Logger;
}): ServiceAuth {
  const verifier = createServiceAssertionVerifier({
    selfNodeId: deps.nodeId,
    trustedHomes: parseTrustedHomes(deps.env.SERVICE_TRUSTED_HOMES),
    replay: createMemoryReplayStore(),
  });
  const owners = createOwnerSources([
    createRepoSpecOwnerSource({
      fetchRepoSpec: (ref, path) => fetchRepoSpecFromGithub(ref, path),
      extractApprovers: (yaml) => extractLedgerApprovers(parseRepoSpec(yaml)),
      usersForWallets: (wallets) => usersForWallets(deps.sql, wallets),
    }),
  ]);
  return {
    signer: buildSigner(deps.env),
    verifier,
    owners,
    async verify(token) {
      const result = await verifier.verify(token);
      // Never the token. On a refusal the issuer and service are the unverified claims, for diagnosis only.
      if (result.ok)
        deps.log.info(
          { event: EVENT_NAMES.SERVICE_AUTH_VERIFIED, issuer: result.issuer, service: result.service },
          EVENT_NAMES.SERVICE_AUTH_VERIFIED
        );
      else deps.log.warn(
          { event: EVENT_NAMES.SERVICE_AUTH_REJECTED, code: result.code, issuer: result.issuer, service: result.service },
          EVENT_NAMES.SERVICE_AUTH_REJECTED
        );
      return result;
    },
  };
}
