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
 *   - SIGNER_FAILS_LOUD: a malformed signing seed (not 64 hex characters) or an unusable origin is no signer plus one
 *     `service_auth.signer_unavailable` warning naming the reason, never a silent null and never the key.
 *   - APPROVERS_ONLY: owners are `activity_ledger.approvers` mapped to the users that bound those wallets (`user_bindings`, provider `wallet`, lowercase).
 *   - DURABLE_REPLAY (0.9.0): the replay store is the Postgres `service_assertion_jtis` table (unique `jti`, pruned after `exp`), so a replayed assertion is refused after a restart and by every
 *     replica. A store failure rejects the check (the route answers 503); it is never a pass.
 * Side-effects: IO (HTTPS to GitHub, service-role reads)
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment, https://node-template.cognidao.org/knowledge/node-relationships-design
 * @internal
 */

import {
  createGithubRepoSpecFetcher,
  createIssuerOwnerSource,
  createOwnerSources,
  createRepoSpecOwnerSource,
  type OrgOwners,
} from "@cogni/agent-grants/orgs";
import {
  createPostgresReplayStore,
  createServiceAssertionSignerFromSeed,
  createServiceAssertionVerifier,
  type ServiceAssertionResult,
  type ServiceAssertionSigner,
  type ServiceAssertionVerifier,
  type TrustedHome,
} from "@cogni/agent-grants/service-auth";
import { readLedgerApproversFromYaml } from "@cogni/repo-spec";
import type { Logger } from "pino";
import { EVENT_NAMES, failureFields } from "@/shared/observability";
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
  readonly SERVICE_ASSERTION_SIGNING_SEED?: string | undefined;
  readonly APP_BASE_URL?: string | undefined;
}

/**
 * The signer from the 32-byte hex seed and this node's own origin. Null and silent when no seed is set (this node is not a home); null with ONE warning naming the reason
 * when the seed is malformed or the origin is unusable. Never logs the seed. The key pair and its kid derive from the seed inside the package.
 */
export async function buildSigner(env: SignerEnv, log: Pick<Logger, "warn">): Promise<ServiceAssertionSigner | null> {
  if (!env.SERVICE_ASSERTION_SIGNING_SEED) return null;
  const fail = (reason: string): null => {
    log.warn({ event: EVENT_NAMES.SERVICE_AUTH_SIGNER_UNAVAILABLE, reason }, EVENT_NAMES.SERVICE_AUTH_SIGNER_UNAVAILABLE);
    return null;
  };
  let origin: string;
  try {
    origin = new URL(env.APP_BASE_URL ?? "").origin;
  } catch {
    return fail("app_base_url_unusable");
  }
  try {
    return await createServiceAssertionSignerFromSeed({ issuer: origin, seedHex: env.SERVICE_ASSERTION_SIGNING_SEED });
  } catch {
    return fail("signing_seed_malformed");
  }
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
    readonly GITHUB_READ_TOKEN?: string | undefined;
  };
  /** The homes this deployment trusts, from `.cogni/service-links.yaml` (empty = every assertion is `untrusted_issuer`). */
  trustedHomes: readonly TrustedHome[];
  nodeId: string;
  sql: AgentAuthoritySql;
  log: Logger;
}): ServiceAuth {
  const verifier = createServiceAssertionVerifier({
    selfNodeId: deps.nodeId,
    trustedHomes: [...deps.trustedHomes],
    replay: createPostgresReplayStore(deps.sql),
  });
  const owners = createOwnerSources([
    // An issuer-keyed org (a customer node's record on this provider) has no owners: a read always throws `issuer_has_no_owners`, so no decision over it passes an owner list.
    createIssuerOwnerSource(),
    createRepoSpecOwnerSource({
      // The package reads no env var: this composition hands it a token provider over the one env value.
      fetchRepoSpec: createGithubRepoSpecFetcher({ token: async () => deps.env.GITHUB_READ_TOKEN }),
      // Another node's repo-spec may carry fields this schema retired or never had: read only its approver list.
      extractApprovers: readLedgerApproversFromYaml,
      usersForWallets: (wallets) => usersForWallets(deps.sql, wallets),
    }),
  ]);
  let signer: Promise<ServiceAssertionSigner | null> | undefined;
  return {
    getSigner: () => (signer ??= buildSigner(deps.env, deps.log)),
    verifier,
    owners,
    async verify(token) {
      let result: ServiceAssertionResult;
      try {
        result = await verifier.verify(token);
      } catch (error) {
        // The durable replay store failed: nothing was decided, so the caller answers 503 (never a pass, never a 401).
        deps.log.error(
          { event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE, routeId: "service_auth.replay_store", ...failureFields(error) },
          EVENT_NAMES.AGENT_ROLES_UNAVAILABLE
        );
        throw error;
      }
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
