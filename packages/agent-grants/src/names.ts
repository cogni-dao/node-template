// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/names`
 * Purpose: One key for "the same name" so an outside agent cannot register a name that looks like this node's AI (or another agent)
 *   on the screen where an admin says yes.
 * Scope: Pure string functions. No I/O.
 * Invariants:
 *   - NAME_KEY: NFKC-normalized, hidden and direction characters removed, whitespace collapsed, lower-cased. Two names that look
 *     the same to a person have the same key.
 *   - A name that carries hidden or direction characters is refused, never cleaned and stored.
 * Side-effects: none
 * @public
 */

/** Control, format (zero-width, direction marks and overrides, isolates), and line or paragraph separators. */
const HIDDEN = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const HIDDEN_ALL = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

export function hasHiddenCharacters(name: string): boolean {
  return HIDDEN.test(name.normalize("NFKC"));
}

/** The comparison key. Case, spacing and look-alike (compatibility) forms do not make a new name. */
export function agentNameKey(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/\s+/gu, " ") // tabs, newlines and separators are spaces, not nothing
    .replace(HIDDEN_ALL, "")
    .trim()
    .toLowerCase();
}
