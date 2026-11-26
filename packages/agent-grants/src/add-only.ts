// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants` (src/add-only.ts)
 * Purpose: The one add-only merge (NODE_ADDS_ONLY). This package uses it for route maps and scope declarations; `@cogni-dao/extension-kit` re-exports it, so a node's
 *   tool ids and bindings merge with the same function and the same error shape.
 * Scope: Pure.
 * Invariants: a key declared by two sources throws, naming the key and both sources (sorted, so the message never depends on source order).
 * Side-effects: none
 * @beta
 */

/**
 * One source of entries: its name (shown in every error) and the entries by key.
 * @beta
 */
export interface Contribution<T> {
  readonly source: string;
  readonly entries: Readonly<Record<string, T>> | undefined;
}

/**
 * The add-only merge. Throws `<code>: <what> "<key>" is declared by "<A>" and again by "<B>"; a node adds, it never replaces` when a key is declared by two
 * sources. `code` defaults to `EXTENSION_CONFLICT`. `same` lets an equal repeat count as one declaration; without it any repeat throws.
 * @beta
 */
export function addOnly<T>(
  options: { readonly what: string; readonly code?: string | undefined; readonly same?: ((a: T, b: T) => boolean) | undefined },
  ...sources: ReadonlyArray<Contribution<T>>
): Record<string, T> {
  const merged: Record<string, T> = {};
  const owner: Record<string, string> = {};
  for (const { source, entries } of sources)
    for (const [key, value] of Object.entries(entries ?? {})) {
      if (Object.prototype.hasOwnProperty.call(merged, key)) {
        if (options.same?.(merged[key] as T, value)) continue;
        const [a, b] = [owner[key] as string, source].sort();
        throw new Error(`${options.code ?? "EXTENSION_CONFLICT"}: ${options.what} "${key}" is declared by "${a}" and again by "${b}"; a node adds, it never replaces`);
      }
      merged[key] = value;
      owner[key] = source;
    }
  return merged;
}
