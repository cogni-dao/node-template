// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/json`
 * Purpose: Compare and fingerprint JSON independently of JSONB object key order.
 * Scope: Recursive object-key ordering; array order and JSON values remain significant.
 * Invariants: STRUCTURAL_JSON_EQUALITY.
 * Side-effects: none
 * @public
 */
export function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? Object.fromEntries(
            Object.keys(entry)
              .sort()
              .map((key) => [key, entry[key]])
          )
        : entry
    ) ?? "null"
  );
}
