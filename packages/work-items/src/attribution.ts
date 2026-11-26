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

/** The terminal event names this module owns; a node's registry repeats them only as these values. */
export const WORK_ITEM_ATTRIBUTION_EVENTS = {
  runMissing: "work.items.attribution_run_missing",
} as const;

/** The run facts a host builds an attribution from. A node's own run scope satisfies this shape; the package imports no scope type. */
export interface RunAttributionScope {
  /** The acting agent principal's user id. */
  readonly principalId?: string | undefined;
  /** The authenticated caller the run serves; absent for a run with no caller. */
  readonly subjectUserId?: string | undefined;
  readonly runId?: string | undefined;
  /** The run record's kind; absent when the record is missing or unreadable. */
  readonly runKind?: WriteRunKind | undefined;
}

/**
 * The actor of a write made inside a run: the run's own acting principal. Fails closed when the scope names none
 * (never falls back to the subject: a run with no principal writes nothing).
 */
export function actingPrincipal(scope: RunAttributionScope): string {
  if (!scope.principalId) {
    throw new Error("write denied: the run has no acting principal");
  }
  return scope.principalId;
}

/** The fields every write's terminal event carries: who acted, who asked, which run. Ids only. */
export function attributionFields(attribution: WriteAttribution): {
  actor: string;
  requestedBy?: string;
  runId?: string;
  runKind?: string;
} {
  return {
    actor: attribution.actor,
    ...(attribution.requestedBy ? { requestedBy: attribution.requestedBy } : {}),
    ...(attribution.run
      ? { runId: attribution.run.id, runKind: attribution.run.kind }
      : {}),
  };
}

/** A write made through a route: the authenticated caller (a signed-in person, or the outside AI that holds the key). No requester, no run. */
export function routeAttribution(callerUserId: string): WriteAttribution {
  return { actor: callerUserId };
}

/** The one logger call `runAttribution` makes. */
export interface RunAttributionLog {
  warn(fields: Record<string, unknown>, event: string): void;
}

/**
 * A write made by a graph tool: the run's acting principal, the run's subject as requester (when it has one) and the run.
 * The actor rule is fail closed: no principal, no write, and the subject is never the actor. The run is not: when the host
 * could not name it (no record, no kind, an unreadable ledger) the write still happens as the principal, with no `Run:` line,
 * and one `work.items.attribution_run_missing` event says so.
 */
export function runAttribution(
  scope: RunAttributionScope,
  log?: RunAttributionLog
): WriteAttribution {
  const actor = actingPrincipal(scope);
  const run =
    scope.runId && scope.runKind
      ? { id: scope.runId, kind: scope.runKind }
      : undefined;
  if (!run) {
    log?.warn(
      {
        event: WORK_ITEM_ATTRIBUTION_EVENTS.runMissing,
        ...(scope.runId ? { runId: scope.runId } : {}),
        hasRunKind: scope.runKind !== undefined,
      },
      WORK_ITEM_ATTRIBUTION_EVENTS.runMissing
    );
  }
  return {
    actor,
    ...(scope.subjectUserId ? { requestedBy: scope.subjectUserId } : {}),
    ...(run ? { run } : {}),
  };
}

/** `runAttribution` bound to the node's current run scope, read at each call and never at construction. */
export function createRunAttribution(deps: {
  readonly scope: () => RunAttributionScope;
  readonly log?: RunAttributionLog;
}): () => WriteAttribution {
  return () => runAttribution(deps.scope(), deps.log);
}
