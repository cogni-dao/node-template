// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/node-declarations/check`
 * Purpose: The node-side PR check for a node's secret declarations (bug.5254): the same two passes the
 *   operator's node-deploy verb runs, so a node learns of a bad declaration in its PR, not at deploy.
 * Scope: Pure. Takes file text and a node slug; does not read files, call the network or read the clock.
 * Invariants:
 *   - ONE_FUNCTION_TWO_CALLERS: deploy pass 1 (the catalog entry schema) and pass 2 (the sovereign-node
 *     policy) are `parseNodeSecretsCatalog`, imported from this package's byte-identical copy of the
 *     operator's `secrets-catalog.ts`. Pass 3 (reserved, fleet-inherited and off-cluster keys) is
 *     operator data and runs only at deploy. This check does NOT claim full deploy parity.
 *   - NODE_SLUG_IS_INPUT: the caller names the node. Nothing here derives it from a path or repo name.
 *   - NO_SOURCE_ECHO: an issue carries a code, a path and a fixed or key-naming message, never a value.
 *   - FAIL_CLOSED: an unreadable repo-spec is an issue, never an empty service list that passes.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/publish-shared-runtime-core, bug.5254
 * @public
 */

import {
  findRetiredSecretRefs,
  readServiceNames,
} from "./retired-secret-refs";
import {
  parseNodeSecretsCatalog,
  SecretsCatalogError,
} from "./secrets-catalog";

export interface NodeDeclarationIssue {
  /** Which file the issue is in. */
  readonly file: "repo-spec" | "secrets-catalog";
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface NodeDeclarationsResult {
  readonly ok: boolean;
  readonly issues: readonly NodeDeclarationIssue[];
}

export interface NodeDeclarationsInput {
  /** Text of `.cogni/repo-spec.yaml`. */
  readonly repoSpecText: string;
  /** Text of `.cogni/secrets-catalog.yaml`, or `null` when the file is absent (an empty catalog). */
  readonly catalogText: string | null;
  /** The node's slug (repo-spec `intent.name`). Never the repository name. */
  readonly nodeSlug: string;
}

/** Check a node's repo-spec and secrets catalog. Never throws on bad input; returns every issue found. */
export function checkNodeDeclarations(
  input: NodeDeclarationsInput
): NodeDeclarationsResult {
  const issues: NodeDeclarationIssue[] = [];

  for (const issue of findRetiredSecretRefs(input.repoSpecText))
    issues.push({ file: "repo-spec", ...issue });

  const serviceNames = readServiceNames(input.repoSpecText);
  if (serviceNames === null) {
    issues.push({
      file: "repo-spec",
      code: "repo_spec_unreadable",
      path: "",
      message: "repo-spec is not a YAML mapping",
    });
    return { ok: false, issues };
  }

  try {
    parseNodeSecretsCatalog(input.catalogText, {
      nodeSlug: input.nodeSlug,
      serviceNames,
    });
  } catch (error) {
    if (!(error instanceof SecretsCatalogError)) throw error;
    for (const issue of error.issues)
      issues.push({ file: "secrets-catalog", ...issue });
  }

  return { ok: issues.length === 0, issues };
}
