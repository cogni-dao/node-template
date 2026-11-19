// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/attribution`
 * Purpose: The record of one EDO write: who did it, who asked, which run (hub activity-attribution, task.0133).
 * Scope: Pure type, validation and commit-message composition. No I/O.
 * Invariants:
 *   - SAME_SHAPE_AS_WORK_ITEMS: structurally identical to `@cogni-dao/work-items` `WriteAttribution`, so one host-built object serves both planes.
 *   - HOST_BUILDS_IT: only host code constructs one, from the session or the run scope's acting principal.
 *   - ONE_LINE_EACH: every value is one token (no whitespace), so a value cannot forge a commit line.
 * Side-effects: none
 * Links: hub activity-attribution
 * @public
 */

export const WRITE_RUN_KINDS = [
  "user_immediate",
  "system_scheduled",
  "system_webhook",
] as const;
export type WriteRunKind = (typeof WRITE_RUN_KINDS)[number];

/** Who acted, for whom, in which run. `requestedBy` and `run` exist only for a node run. */
export interface WriteAttribution {
  readonly actor: string;
  readonly requestedBy?: string | undefined;
  readonly run?: { readonly id: string; readonly kind: WriteRunKind } | undefined;
}

export class WriteAttributionInvalidError extends Error {
  override readonly name = "WriteAttributionInvalidError";
}

/** The operation text (it names a caller-supplied entry id) holds a line break: caller input, a 400, never a host defect. */
export class CommitTextInvalidError extends Error {
  override readonly name = "CommitTextInvalidError";
}

const ONE_TOKEN = /^[^\s\u0085\u2028\u2029]+$/u;

function token(label: string, value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!ONE_TOKEN.test(trimmed)) {
    throw new WriteAttributionInvalidError(
      `write attribution: ${label} must be one non-empty token with no whitespace`
    );
  }
  return trimmed;
}

/**
 * The commit message of one attributed EDO write. The first line is `<what> by actor:<actor>` (the same form as
 * work-items commits); a node run's write adds `Requested-by: <subject>` when it has a subject, then `Run: <id> <kind>`.
 * Throws `WriteAttributionInvalidError` when a value would break a line.
 */
export function attributedCommitMessage(
  what: string,
  attribution: WriteAttribution
): string {
  if (/[\r\n\u0085\u2028\u2029]/u.test(what)) {
    throw new CommitTextInvalidError(
      "the entry id must be one line: it names the commit"
    );
  }
  const actor = token("actor", attribution?.actor);
  const lines = [`${what} by actor:${actor}`];
  if (attribution.requestedBy !== undefined)
    lines.push(`Requested-by: ${token("requestedBy", attribution.requestedBy)}`);
  if (attribution.run) {
    if (!(WRITE_RUN_KINDS as readonly string[]).includes(attribution.run.kind)) {
      throw new WriteAttributionInvalidError(
        "write attribution: run kind is not a known run kind"
      );
    }
    lines.push(
      `Run: ${token("run id", attribution.run.id)} ${attribution.run.kind}`
    );
  }
  return lines.join("\n");
}
