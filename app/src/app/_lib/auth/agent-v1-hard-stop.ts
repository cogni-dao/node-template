// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/auth/agent-v1-hard-stop`
 * Purpose: The date after which no v1 agent key may be renewed (task.0069 C1).
 * Scope: Pure date math. Does not read env or the clock itself.
 * Invariants: HARD_STOP_ONLY_SHORTENS — effective = min(code default, env). A later env value is ignored (`ignoredEnv`).
 *   An unparsable env value returns null: the caller fails closed and renews nothing.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5474
 * @public
 */

/** 2027-01-31T00:00:00Z. Prod never sets the env; the candidate sets a past date to prove the 403. */
export const AGENT_V1_HARD_STOP_DEFAULT_MS = Date.parse("2027-01-31T00:00:00Z");

export function effectiveAgentV1HardStop(
  envValue: string | undefined
): { atMs: number; ignoredEnv: boolean } | null {
  if (!envValue?.trim()) {
    return { atMs: AGENT_V1_HARD_STOP_DEFAULT_MS, ignoredEnv: false };
  }
  const envMs = Date.parse(envValue.trim());
  if (Number.isNaN(envMs)) return null;
  return envMs < AGENT_V1_HARD_STOP_DEFAULT_MS
    ? { atMs: envMs, ignoredEnv: false }
    : { atMs: AGENT_V1_HARD_STOP_DEFAULT_MS, ignoredEnv: true };
}
