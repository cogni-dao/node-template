// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/attribution`
 * Purpose: The record of one write: who did it, who asked, which run (hub activity-attribution, task.0133).
 * Scope: Pure type and validation. No I/O.
 * Invariants:
 *   - HOST_BUILDS_IT: only host code constructs a `WriteAttribution`, from the session or the run scope's acting principal; no request field feeds it.
 *   - ACTOR_IS_THE_CALLER: `actor` is whoever made the call. The run's subject is `requestedBy`, never the actor.
 *   - ONE_LINE_EACH: every value is one token (no whitespace, so no line break), so a value cannot forge a commit line or break the first-line form crash recovery reads.
 * Side-effects: none
 * Links: hub activity-attribution, change-history-design
 * @public
 */

/** The run record's kinds, as `graph_runs.run_kind` carries them. */
export const WRITE_RUN_KINDS = [
  "user_immediate",
  "system_scheduled",
  "system_webhook",
] as const;
export type WriteRunKind = (typeof WRITE_RUN_KINDS)[number];

/**
 * Who acted, for whom, in which run. `requestedBy` and `run` exist only for a node run; a signed-in person's
 * session and an outside AI's key are not node runs and carry neither.
 */
export interface WriteAttribution {
  readonly actor: string;
  readonly requestedBy?: string | undefined;
  readonly run?: { readonly id: string; readonly kind: WriteRunKind } | undefined;
}

const ONE_TOKEN = /^[^\s\u0085\u2028\u2029]+$/u;

/** A blank actor is an unauthenticated write; every other violation is a host bug. */
export class WriteAttributionInvalidError extends Error {
  override readonly name = "WriteAttributionInvalidError";
}

function token(label: string, value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!ONE_TOKEN.test(trimmed)) {
    throw new WriteAttributionInvalidError(
      `write attribution: ${label} must be one non-empty token with no whitespace`
    );
  }
  return trimmed;
}

/** The attribution with every value checked (one token, a known run kind). Throws `WriteAttributionInvalidError`. */
export function requireWriteAttribution(
  attribution: WriteAttribution
): WriteAttribution {
  const actor = token("actor", attribution?.actor);
  const requestedBy =
    attribution.requestedBy === undefined
      ? undefined
      : token("requestedBy", attribution.requestedBy);
  let run: WriteAttribution["run"];
  if (attribution.run !== undefined) {
    if (!(WRITE_RUN_KINDS as readonly string[]).includes(attribution.run.kind)) {
      throw new WriteAttributionInvalidError(
        "write attribution: run kind is not a known run kind"
      );
    }
    run = { id: token("run id", attribution.run.id), kind: attribution.run.kind };
  }
  return {
    actor,
    ...(requestedBy !== undefined ? { requestedBy } : {}),
    ...(run ? { run } : {}),
  };
}

/** The `Requested-by:` and `Run:` commit lines, in that order, for a checked attribution. */
export function attributionCommitLines(
  attribution: WriteAttribution
): string[] {
  const lines: string[] = [];
  if (attribution.requestedBy !== undefined)
    lines.push(`Requested-by: ${attribution.requestedBy}`);
  if (attribution.run)
    lines.push(`Run: ${attribution.run.id} ${attribution.run.kind}`);
  return lines;
}
