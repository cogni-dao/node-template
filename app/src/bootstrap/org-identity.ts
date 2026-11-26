// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/org-identity`
 * Purpose: This node as an ORG (task.0181): the origin and the repo-spec facts its statement carries (`/.well-known/cogni-org`), handed to `createAgentToolAuthority`.
 *   The package signs, verifies, caches and decides; this file only reads this node's own repo-spec.
 * Scope: Composition only. Facts are read on every signing, so an approver removed from the repo-spec is gone from the next statement.
 * Invariants:
 *   - ADMINS_ARE_LEDGER_APPROVERS: the admins are `activity_ledger.approvers` (never the steward wallet), the same list that decides this node's own admins.
 *   - NO_ORIGIN_NO_STATEMENT: without a usable `APP_BASE_URL` origin this node serves no statement.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @internal
 */

import type { OrgFacts } from "@cogni/agent-grants/org-statement";
import { REMOTE_KNOWLEDGE_SERVICE } from "@cogni/ai-tools";
import { getDaoConfig, getLedgerApprovers } from "@/shared/config/repoSpec.server";

/** The repo-spec commit the running build was cut from, or null when the build sha is not a commit id. */
const commitOf = (sha: string | undefined): string | null => (sha && /^[0-9a-f]{7,64}$/i.test(sha) ? sha : null);

export function buildOrgIdentity(env: {
  readonly APP_BASE_URL?: string | undefined;
  readonly APP_BUILD_SHA?: string | undefined;
  readonly APP_BUILD_COMMIT_TIME?: string | undefined;
}): { origin: string; version?: number; facts: () => OrgFacts } | undefined {
  let origin: string;
  try {
    origin = new URL(env.APP_BASE_URL ?? "").origin;
  } catch {
    return undefined;
  }
  // The statement version is the build's commit time (seconds): constant per build, higher for a newer build. Unset or invalid = no version, and the package signs no statement.
  const built = Number(env.APP_BUILD_COMMIT_TIME);
  const version = Number.isSafeInteger(built) && built > 0 && built <= Math.floor(Date.now() / 1000) + 60 ? built : undefined;
  return {
    origin,
    ...(version !== undefined ? { version } : {}),
    facts: () => ({
      dao: getDaoConfig()?.dao_contract ?? null,
      admins: getLedgerApprovers(),
      // The one service this node's AI signs as on other nodes; v0 enables it for every org.
      services: [REMOTE_KNOWLEDGE_SERVICE],
      commit: commitOf(env.APP_BUILD_SHA),
    }),
  };
}
