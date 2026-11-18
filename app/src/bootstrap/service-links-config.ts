// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/service-links-config`
 * Purpose: Load this deployment's section of `.cogni/service-links.yaml` (story.0038): the homes whose signed assertions this node trusts, and the nodes its AI may call.
 *   Public URLs belong in Git config; the signing key is the only secret (`SERVICE_ASSERTION_SIGNING_SEED`).
 * Scope: One file read at boot, keyed by `DEPLOY_ENVIRONMENT`, through the pure parser in `@cogni/repo-spec` and the strict parsers in `@cogni/agent-grants/service-auth`.
 * Invariants:
 *   - FAIL_CLOSED: a missing file, an unreadable or malformed file, a missing `DEPLOY_ENVIRONMENT` or an environment with no key is no homes and no targets (every assertion is
 *     `untrusted_issuer`, every alias is unknown). Another environment's section is never used.
 *   - STRICT_PER_ENTRY: a malformed home or target is dropped by the package parsers; the rest are kept.
 * Side-effects: IO (one synchronous file read at boot)
 * Links: .cogni/service-links.yaml, https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @internal
 */

import fs from "node:fs";
import path from "node:path";
import { type LinkTarget, parseLinkTargets, parseTrustedHomes, type TrustedHome } from "@cogni/agent-grants/service-auth";
import { parseServiceLinksFile } from "@cogni/repo-spec";
import type { Logger } from "pino";

export interface ServiceLinksConfig {
  readonly trustedHomes: readonly TrustedHome[];
  readonly targets: readonly LinkTarget[];
}

const NONE: ServiceLinksConfig = { trustedHomes: [], targets: [] };

export const SERVICE_LINKS_FILE = path.join(".cogni", "service-links.yaml");

/** This deployment's homes and targets from the committed file, or none (fail closed). `read` is injectable for tests. */
export function loadServiceLinksConfig(deps: {
  readonly environment: string | undefined;
  readonly repoRoot: string | undefined;
  readonly log: Pick<Logger, "debug" | "warn">;
  readonly read?: (file: string) => string;
}): ServiceLinksConfig {
  if (!deps.environment || !deps.repoRoot) return NONE;
  let text: string;
  try {
    text = (deps.read ?? ((file) => fs.readFileSync(file, "utf8")))(path.join(deps.repoRoot, SERVICE_LINKS_FILE));
  } catch {
    deps.log.debug({ reason: "service_links_file_unreadable" }, "service_links.config");
    return NONE;
  }
  const section = parseServiceLinksFile(text, deps.environment);
  const config: ServiceLinksConfig = { trustedHomes: parseTrustedHomes(section.trustedHomes), targets: parseLinkTargets(section.targets) };
  deps.log.debug(
    { environment: deps.environment, trustedHomes: config.trustedHomes.length, targets: config.targets.length },
    "service_links.config"
  );
  return config;
}
