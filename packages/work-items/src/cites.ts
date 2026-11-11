// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/cites`
 * Purpose: Cite rules and the `EntryResolver` port that pins a cited atom to a commit (task.0086).
 * Scope: Types, constants and pure functions. No I/O. `@cogni-dao/knowledge-store` implements the port; this package never imports it.
 * Invariants:
 *   - CITE_ID_COPY: `CITE_ID_PATTERN` is a copy of the knowledge id pattern; a test in the app checks the knowledge-store pattern against it.
 *   - CITES_BOUNDED: at most 8 cites, ids unique, each id and contribution matches its pattern.
 *   - RULE_IS_CLOSED: `rule` names one resolution rule; this version ships `"cite"`.
 *   - ERRORS_BY_NAME: an implementation may bundle its own copy of `EntryUnresolvedError`; the adapter matches it by name and `ids`.
 * Side-effects: none
 * Links: hub change-history-design
 * @public
 */

export const CITE_MAX = 8;
export const CITE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,255}$/;
export const CITE_CONTRIBUTION_PATTERN = /^contrib-[a-z0-9-]{1,200}$/;
/** A Dolt commit hash: 32 characters of base32 (0-9, a-v). */
export const CITE_COMMIT_PATTERN = /^[0-9a-v]{32}$/;

export interface CiteRef {
  readonly id: string;
  /** An open inbox (contribution) that holds the atom; absent means main. */
  readonly contribution?: string | undefined;
}

/** One cite pinned to the commit that held the atom when it was resolved. */
export interface ResolvedEntry {
  readonly id: string;
  readonly commit: string;
  readonly plane: "main" | "inbox";
  readonly contribution?: string | undefined;
}

export type EntryResolverRule = "cite";

export interface EntryResolver {
  /**
   * Pin each ref under `rule`. Throws `EntryUnresolvedError` for ids that do not
   * exist (or an inbox that is closed or lacks the id). Reads only; takes no
   * writer lock. `signal` aborts when the caller's deadline passes.
   */
  resolve(
    refs: readonly CiteRef[],
    rule: EntryResolverRule,
    signal: AbortSignal
  ): Promise<readonly ResolvedEntry[]>;
}

/** Problems with a request's `cites`, one line each; empty when valid or absent. */
export function citeIssues(cites: unknown): string[] {
  if (cites === undefined) return [];
  if (!Array.isArray(cites)) return ["cites must be an array"];
  const issues: string[] = [];
  if (cites.length > CITE_MAX) issues.push(`cites must hold at most ${CITE_MAX} entries`);
  const seen = new Set<string>();
  for (const [i, cite] of cites.entries()) {
    const ref = cite as { id?: unknown; contribution?: unknown } | null;
    if (typeof ref?.id !== "string" || !CITE_ID_PATTERN.test(ref.id)) {
      issues.push(`cites[${i}].id must match ${CITE_ID_PATTERN.source}`);
      continue;
    }
    if (seen.has(ref.id)) issues.push(`cites[${i}].id repeats ${ref.id}`);
    seen.add(ref.id);
    if (
      ref.contribution !== undefined &&
      (typeof ref.contribution !== "string" ||
        !CITE_CONTRIBUTION_PATTERN.test(ref.contribution))
    ) {
      issues.push(
        `cites[${i}].contribution must match ${CITE_CONTRIBUTION_PATTERN.source}`
      );
    }
  }
  return issues;
}

/** An unknown cite id, or an inbox that is closed or does not hold it. */
export class EntryUnresolvedError extends Error {
  readonly code = "cite_unresolved" as const;
  constructor(readonly ids: readonly string[]) {
    super(`Cited entries not found: ${ids.join(", ")}`);
    this.name = "EntryUnresolvedError";
  }
}

/** The resolver failed or ran past its deadline; nothing was written. */
export class EntryResolverUnavailableError extends Error {
  readonly code = "cite_resolver_unavailable" as const;
  constructor(message = "Cite resolver is unavailable; retry shortly") {
    super(message);
    this.name = "EntryResolverUnavailableError";
  }
}

/** The patch carries cites but no resolver is wired on this node; nothing was written. */
export class CitesUnsupportedError extends Error {
  readonly code = "cites_unsupported" as const;
  constructor() {
    super("cites are not supported: no entry resolver is wired on this node");
    this.name = "CitesUnsupportedError";
  }
}

/** The patch carries cites that break the cite rules (the zod schema normally says so first). */
export class CitesInvalidError extends Error {
  readonly code = "cites_invalid" as const;
  constructor(readonly issues: readonly string[]) {
    super(`Invalid cites: ${issues.join("; ")}`);
    this.name = "CitesInvalidError";
  }
}
