// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/auth/service-enrollment-verifier`
 * Purpose: This node's trusted-home list and the verifier of service enrollment tokens (`@cogni-dao/agent-grants/enrollment`).
 * Scope: Composition of the package verifier with the issuer key set this node already trusts for GitHub attestations. No store, no decision of its own.
 * Invariants:
 *   - TRUSTED_HOMES_DEFAULT: the list defaults to the operator issuer resolved from `DOMAIN` (the same pin as GitHub attestations) with the one
 *     service `git-review` and the one scope `knowledge:read`. A second home (Beacon) is one more entry; nothing else changes.
 *   - SAME_KEYS_AS_ATTESTATION: the verifier reads the issuer's remote JWKS through the cached reader `operator-attestation.ts` owns, so one key
 *     rotation covers both token kinds. The two kinds cannot be swapped: each verifier refuses the other's `typ` and `kind`.
 *   - FAIL_CLOSED: a node whose `DOMAIN` or node id cannot be read answers every enrollment `jwks_unavailable` (503); it never accepts a token.
 * Side-effects: IO only through the cached remote JWKS
 * Links: packages/agent-grants/src/enrollment/verify.ts, https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @internal
 */

import {
  createEnrollmentTokenVerifier,
  type EnrollmentTokenVerifier,
  nodeTupleSchema,
  type TrustedHome,
} from "@cogni/agent-grants/enrollment";
import { z } from "zod";
import { getJwks } from "@/app/_lib/auth/operator-attestation";
import { serviceHomeTuple } from "@/bootstrap/service-links";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env";

/** The services a home may sign for, and the one permission each may ask. v0: the operator's git-review reads the knowledge base. */

/** The home nodes this node trusts to sign enrollment tokens. Default: the operator issuer of this deployment's `DOMAIN`. */
export function getTrustedHomes(): readonly TrustedHome[] {
  const raw = serverEnv().SERVICE_ENROLLMENT_TRUSTED_HOMES;
  if (!raw) throw new Error("trusted_home_configuration_unavailable");
  return z
    .array(
      nodeTupleSchema.extend({
        kids: z.array(z.string().min(1)).min(1),
        services: z.record(z.string(), z.array(z.string()).min(1)),
      })
    )
    .min(1)
    .parse(JSON.parse(raw));
}

let verifier: EnrollmentTokenVerifier | undefined;

export function getEnrollmentTokenVerifier(): EnrollmentTokenVerifier {
  try {
    verifier ??= createEnrollmentTokenVerifier({
      nodeId: getNodeId(),
      homes: getTrustedHomes(),
      receiver: serviceHomeTuple(),
      keysFor: (origin) => getJwks(origin),
    });
    return verifier;
  } catch {
    return async () => ({ ok: false, reason: "jwks_unavailable" });
  }
}
