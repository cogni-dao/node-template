// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants` (internal, src/add-only.ts)
 * Purpose: The one add-only merge this package uses, for route maps and for scope declarations (NODE_ADDS_ONLY). It has the contract of
 *   `addOnly` in `@cogni-dao/extension-kit`; this package cannot import the kit, whose aggregate type imports this package's types.
 * Scope: Pure; not exported from the package.
 * Side-effects: none
 * @internal
 */

export interface Source<T> {
  readonly source: string;
  readonly entries: Readonly<Record<string, T>> | undefined;
}

/** Throws when a key is declared by two sources, naming the key and both sources (sorted). `same` lets an equal repeat count as one declaration. */
export function mergeAddOnly<T>(
  options: { readonly what: string; readonly code: string; readonly same?: ((a: T, b: T) => boolean) | undefined },
  ...sources: ReadonlyArray<Source<T>>
): Record<string, T> {
  const merged: Record<string, T> = {};
  const owner: Record<string, string> = {};
  for (const { source, entries } of sources)
    for (const [key, value] of Object.entries(entries ?? {})) {
      if (Object.prototype.hasOwnProperty.call(merged, key)) {
        if (options.same?.(merged[key] as T, value)) continue;
        const [a, b] = [owner[key] as string, source].sort();
        throw new Error(`${options.code}: ${options.what} "${key}" is declared by "${a}" and again by "${b}"; a node adds, it never replaces`);
      }
      merged[key] = value;
      owner[key] = source;
    }
  return merged;
}
