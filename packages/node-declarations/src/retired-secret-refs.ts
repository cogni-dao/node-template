// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/node-declarations/retired-secret-refs`
 * Purpose: Find a retired `secret_refs` field in a node's raw `.cogni/repo-spec.yaml` text (bug.5254).
 * Scope: Pure. Reads the YAML text only; does not parse the repo-spec schema, read files or call the network.
 * Invariants:
 *   - RETIRED_NEVER_STRIPPED: `secret_refs` at the top level or on any `deployment.services[*]` entry is
 *     reported, even as `[]` or `null`. A declared field is never ignored (CD1).
 *   - SAME_MESSAGE_AS_DEPLOY: the message is the operator's `RETIRED_SECRET_REFS_MESSAGE`, byte for byte,
 *     so a node PR and a deploy refuse with the same words.
 *   - NO_SOURCE_ECHO: an issue names a path and the fixed message, never a value.
 *   - BOUNDED_INPUT: a repo-spec over 256 KiB is not scanned.
 * Side-effects: none
 * Links: packages/repo-spec/src/schema.ts (operator, `RETIRED_SECRET_REFS_MESSAGE`), bug.5254
 * @public
 */

import { parse as parseYaml } from "yaml";

/** The operator's refusal text for a retired `secret_refs` field. Keep identical to the deploy refusal. */
export const RETIRED_SECRET_REFS_MESSAGE =
  "secret_refs is retired: declare each node secret in .cogni/secrets-catalog.yaml with `workloads` (bug.5254)";

const MAX_REPO_SPEC_BYTES = 256 * 1024;

export interface RetiredSecretRefsIssue {
  readonly code: "retired_secret_refs";
  /** Dotted path of the field, e.g. `secret_refs` or `deployment.services[1].secret_refs`. */
  readonly path: string;
  readonly message: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const has = (value: Record<string, unknown>, key: string): boolean =>
  Object.hasOwn(value, key);

/**
 * Report every `secret_refs` field in a repo-spec's YAML text. Unparseable or oversized text yields no
 * issue: the repo-spec schema check owns that failure, and this function only answers the one question.
 */
export function findRetiredSecretRefs(
  repoSpecText: string
): readonly RetiredSecretRefsIssue[] {
  if (new TextEncoder().encode(repoSpecText).length > MAX_REPO_SPEC_BYTES)
    return [];
  let raw: unknown;
  try {
    raw = parseYaml(repoSpecText, { prettyErrors: false, logLevel: "error" });
  } catch {
    return [];
  }
  if (!isRecord(raw)) return [];
  const issues: RetiredSecretRefsIssue[] = [];
  const report = (path: string) =>
    issues.push({
      code: "retired_secret_refs",
      path,
      message: RETIRED_SECRET_REFS_MESSAGE,
    });
  if (has(raw, "secret_refs")) report("secret_refs");
  const deployment = raw.deployment;
  if (isRecord(deployment) && Array.isArray(deployment.services))
    deployment.services.forEach((service, index) => {
      if (isRecord(service) && has(service, "secret_refs"))
        report(`deployment.services[${index}].secret_refs`);
    });
  return issues;
}

/**
 * The repo-spec service names a node catalog's `workloads` may name: `deployment.services[].name`, or
 * `["app"]` when there is no `deployment` block (the operator's legacy one-public-app default). Returns
 * `null` when the text is not a YAML mapping, so the caller fails closed instead of guessing.
 */
export function readServiceNames(
  repoSpecText: string
): readonly string[] | null {
  let raw: unknown;
  try {
    raw = parseYaml(repoSpecText, { prettyErrors: false, logLevel: "error" });
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (raw.deployment === undefined || raw.deployment === null) return ["app"];
  const services = isRecord(raw.deployment) ? raw.deployment.services : null;
  if (!Array.isArray(services)) return [];
  return services.flatMap((service) =>
    isRecord(service) && typeof service.name === "string" ? [service.name] : []
  );
}
