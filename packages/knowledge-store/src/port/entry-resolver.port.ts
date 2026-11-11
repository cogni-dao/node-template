// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/port/entry-resolver`
 * Purpose: The shape of the entry resolver that `@cogni-dao/work-items` declares as its `EntryResolver` port (task.0086).
 * Scope: Types and one error class. This package does not import work-items; the types match structurally.
 * Invariants:
 *   - STRUCTURAL_PORT: `EntryResolver` here is assignable to the work-items port and back.
 *   - ERRORS_BY_NAME: `EntryUnresolvedError` carries `name === "EntryUnresolvedError"` and `ids`; the work-items adapter matches it by name.
 * Side-effects: none
 * Links: hub change-history-design
 * @public
 */

export interface EntryCiteRef {
  readonly id: string;
  /** An open inbox (contribution) that holds the atom; absent means main. */
  readonly contribution?: string | undefined;
}

export interface ResolvedEntry {
  readonly id: string;
  readonly commit: string;
  readonly plane: "main" | "inbox";
  readonly contribution?: string | undefined;
}

export type EntryResolverRule = "cite";

export interface EntryResolver {
  resolve(
    refs: readonly EntryCiteRef[],
    rule: EntryResolverRule,
    signal: AbortSignal
  ): Promise<readonly ResolvedEntry[]>;
}

/** An unknown id, or an inbox that is closed or does not hold the id. */
export class EntryUnresolvedError extends Error {
  readonly code = "cite_unresolved" as const;
  constructor(readonly ids: readonly string[]) {
    super(`Cited entries not found: ${ids.join(", ")}`);
    this.name = "EntryUnresolvedError";
  }
}
