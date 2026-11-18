// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/service-auth`
 * Purpose: This node's composition of `@cogni-dao/agent-grants` service assertions and orgs: the optional signer (this node as a home), the verifier over the
 *   trusted homes (this node as a target), and the org owner source over the node's repo-spec parser and wallet bindings.
 * Scope: Env reading and composition only. The GitHub read, the trusted-homes parser, the signer, the verifier and every decision live in the package (the operator
 *   plugs in the same code). Never logs a token or a key.
 * Invariants:
 *   - ALL_OPTIONAL: no signing key = no signer (an outbound need is 503) and no jwks route; no trusted homes = every assertion is `untrusted_issuer`.
 *   - SIGNER_FAILS_LOUD: a partly configured or unusable signing key (bad JSON, bad shape, a public `x` that is not the private `d`'s) is no signer plus one
 *     `service_auth.signer_unavailable` warning naming the reason, never a silent null and never the key.
 *   - APPROVERS_ONLY: owners are `activity_ledger.approvers` mapped to the users that bound those wallets (`user_bindings`, provider `wallet`, lowercase).
 *   - SINGLE_REPLICA_REPLAY: the replay store is in memory; a target with several replicas needs a shared store behind the same interface.
 * Side-effects: IO (HTTPS to GitHub, service-role reads)
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment, https://node-template.cognidao.org/knowledge/node-relationships-design
 * @internal
 */

import {
  createOwnerSources,
  createRepoSpecOwnerSource,
  fetchRepoSpecFromGithub,
  type OrgOwners,
} from "@cogni/agent-grants/orgs";
import {
  assertSigningKeyMatches,
  createMemoryReplayStore,
  createServiceAssertionSigner,
  createServiceAssertionVerifier,
  type Ed25519PrivateJwk,
  parseTrustedHomes,
  type ServiceAssertionResult,
  type ServiceAssertionSigner,
  type ServiceAssertionVerifier,
} from "@cogni/agent-grants/service-auth";
import { extractLedgerApprovers, parseRepoSpec } from "@cogni/repo-spec";
import type { Logger } from "pino";
import { EVENT_NAMES } from "@/shared/observability";
import type { AgentAuthoritySql } from "./agent-authority";

export interface ServiceAuth {
  /** This node as a home: the signer, or null until the signing key and kid are configured and valid. Resolved once. */
  getSigner(): Promise<ServiceAssertionSigner | null>;
  /** This node as a target: refuses every assertion until a trusted home is configured. */
  readonly verifier: ServiceAssertionVerifier;
  /** Owner reads for org decisions (cached inside the source). */
  readonly owners: OrgOwners;
  /** Verify an assertion and log the outcome (`service_auth.verified` / `service_auth.rejected`). */
  verify(token: string): Promise<ServiceAssertionResult>;
}

interface SignerEnv {
  readonly SERVICE_ASSERTION_SIGNING_JWK?: string | undefined;
  readonly SERVICE_ASSERTION_SIGNING_KID?: string | undefined;
  readonly APP_BASE_URL?: string | undefined;
}

/**
 * The signer from the two env values and this node's own origin. Null and silent when neither signing value is set (this node is not a home); null with ONE
 * warning naming the reason when it is partly configured or the key is unusable. Never logs the key.
 */
export async function buildSigner(env: SignerEnv, log: Pick<Logger, "warn">): Promise<ServiceAssertionSigner | null> {
  if (!env.SERVICE_ASSERTION_SIGNING_JWK && !env.SERVICE_ASSERTION_SIGNING_KID) return null;
  const fail = (reason: string): null => {
    log.warn({ event: EVENT_NAMES.SERVICE_AUTH_SIGNER_UNAVAILABLE, reason }, EVENT_NAMES.SERVICE_AUTH_SIGNER_UNAVAILABLE);
    return null;
  };
  if (!env.SERVICE_ASSERTION_SIGNING_JWK) return fail("signing_jwk_missing");
  if (!env.SERVICE_ASSERTION_SIGNING_KID) return fail("signing_kid_missing");
  let origin: string;
  try {
    origin = new URL(env.APP_BASE_URL ?? "").origin;
  } catch {
    return fail("app_base_url_unusable");
  }
  let privateJwk: Ed25519PrivateJwk;
  try {
    privateJwk = JSON.parse(env.SERVICE_ASSERTION_SIGNING_JWK) as Ed25519PrivateJwk;
  } catch {
    return fail("signing_jwk_not_json");
  }
  let signer: ServiceAssertionSigner;
  try {
    signer = createServiceAssertionSigner({ issuer: origin, kid: env.SERVICE_ASSERTION_SIGNING_KID, privateJwk });
  } catch {
    return fail("signer_config_invalid");
  }
  try {
    await assertSigningKeyMatches(privateJwk);
  } catch {
    return fail("signing_key_mismatch");
  }
  return signer;
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

/** Refusals that are routine noise (an unknown caller, junk input) log at debug; every other refusal is a warning. */
const QUIET_REFUSALS: ReadonlySet<string> = new Set(["untrusted_issuer", "malformed"]);

export function createServiceAuth(deps: {
  env: SignerEnv & {
    readonly SERVICE_TRUSTED_HOMES?: string | undefined;
    readonly GITHUB_READ_TOKEN?: string | undefined;
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
      fetchRepoSpec: (ref, path) => fetchRepoSpecFromGithub(ref, path, { token: deps.env.GITHUB_READ_TOKEN }),
      extractApprovers: (yaml) => extractLedgerApprovers(parseRepoSpec(yaml)),
      usersForWallets: (wallets) => usersForWallets(deps.sql, wallets),
    }),
  ]);
  let signer: Promise<ServiceAssertionSigner | null> | undefined;
  return {
    getSigner: () => (signer ??= buildSigner(deps.env, deps.log)),
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
      else
        deps.log[QUIET_REFUSALS.has(result.code) ? "debug" : "warn"](
          { event: EVENT_NAMES.SERVICE_AUTH_REJECTED, code: result.code, issuer: result.issuer, service: result.service },
          EVENT_NAMES.SERVICE_AUTH_REJECTED
        );
      return result;
    },
  };
}
