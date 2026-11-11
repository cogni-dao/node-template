// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/secret-args`
 * Purpose: Pure helpers that hide declared secret tool arguments (`secretArgs`) from every record the runner writes.
 * Scope: Path parsing, value collection, scrubbed input copy, exact-match scrub. No I/O, no logging, no hashing.
 * Invariants:
 *   - MARKER_IS_FIXED: the replacement is always `[REDACTED]`; never a hash, a length or a prefix of the value
 *   - EXACT_MATCH_ONLY: a value is removed by exact match (raw and JSON-escaped); values under 8 characters are removed
 *     only when a whole string equals them, so a short value cannot mangle unrelated text
 *   - PURE: inputs are never mutated; results are new objects
 * Limits: a secret that needs JSON escaping is removed in its raw and singly-escaped spellings, not a doubly-escaped
 *   one; a Map, Set or class instance is scrubbed as a plain object of its own enumerable fields (tool output is JSON).
 * Side-effects: none
 * Links: runtime-adapter.ts, agent-run-authority (hub) "Secret tool arguments"
 * @public
 */

/** The only thing written in place of a declared secret value. */
export const REDACTION_MARKER = "[REDACTED]";

/** Values shorter than this are scrubbed only on whole-string equality. */
export const MIN_SUBSTRING_SCRUB_LENGTH = 8;

/** True when a contract declares at least one secret argument. */
export function declaresSecretArgs(contract: {
  readonly secretArgs?: readonly string[] | undefined;
}): boolean {
  return (contract.secretArgs?.length ?? 0) > 0;
}

/** One parsed path segment: an object key, then zero or more `[]` array steps. */
interface PathSegment {
  readonly key: string;
  readonly arrays: number;
}

/** Parse `auth.tokens[]` or `rows[].pass`: dots for objects, `[]` for every item of an array. */
export function parseSecretPath(path: string): readonly PathSegment[] {
  return path.split(".").map((part) => {
    const match = /^([^[\]]+)((?:\[\])*)$/.exec(part);
    if (!match) throw new Error(`secretArgs: bad path segment "${part}"`);
    return {
      key: match[1] as string,
      arrays: (match[2] as string).length / 2,
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Apply `visit` to each value at `path` and return a copy with the visited values replaced. Missing branches are
 * left as they are. `onValue` sees the original value.
 */
function mapAtPath(
  node: unknown,
  segments: readonly PathSegment[],
  onValue: (value: unknown) => unknown
): unknown {
  const [head, ...rest] = segments;
  if (!head) return onValue(node);
  if (!isRecord(node) || !(head.key in node)) return node;
  const descend = (value: unknown, arrays: number): unknown => {
    if (arrays > 0) {
      return Array.isArray(value)
        ? value.map((item) => descend(item, arrays - 1))
        : value;
    }
    return rest.length === 0 ? onValue(value) : mapAtPath(value, rest, onValue);
  };
  return { ...node, [head.key]: descend(node[head.key], head.arrays) };
}

/** Every non-empty string at the declared paths of `input`. */
export function collectSecretValues(
  input: unknown,
  paths: readonly string[]
): readonly string[] {
  const found = new Set<string>();
  for (const path of paths) {
    mapAtPath(input, parseSecretPath(path), (value) => {
      if (typeof value === "string" && value.length > 0) found.add(value);
      return value;
    });
  }
  return [...found];
}

/** A copy of `input` with each string at a declared path replaced by the marker. */
export function maskDeclaredPaths(
  input: unknown,
  paths: readonly string[]
): unknown {
  let copy = input;
  for (const path of paths) {
    copy = mapAtPath(copy, parseSecretPath(path), (value) =>
      typeof value === "string" ? REDACTION_MARKER : value
    );
  }
  return copy;
}

/** The raw and JSON-escaped spellings of a value, longest first so an overlap cannot leave a tail behind. */
function spellings(secrets: readonly string[]): string[] {
  const out = new Set<string>();
  for (const secret of secrets) {
    if (secret.length < MIN_SUBSTRING_SCRUB_LENGTH) continue;
    out.add(secret);
    out.add(JSON.stringify(secret).slice(1, -1));
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Replace each secret in one string. */
export function scrubString(text: string, secrets: readonly string[]): string {
  if (secrets.includes(text)) return REDACTION_MARKER;
  let result = text;
  for (const spelling of spellings(secrets)) {
    if (spelling.length > 0 && result.includes(spelling)) {
      result = result.split(spelling).join(REDACTION_MARKER);
    }
  }
  return result;
}

/**
 * Replace each secret in every string leaf and key of a JSON-like value. Returns a new value.
 * `seen` holds only the objects on the current path, so a shared (non-cyclic) object is copied each time it
 * appears and only a true cycle becomes the marker.
 */
export function scrubValue(
  value: unknown,
  secrets: readonly string[],
  seen: WeakSet<object> = new WeakSet()
): unknown {
  if (typeof value === "string") return scrubString(value, secrets);
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) return REDACTION_MARKER;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => scrubValue(item, secrets, seen));
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        scrubString(key, secrets),
        scrubValue(item, secrets, seen),
      ])
    );
  } finally {
    seen.delete(value);
  }
}

/** Freeze a JSON-like value and everything under it. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
