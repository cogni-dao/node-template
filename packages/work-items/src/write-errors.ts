// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/write-errors`
 * Purpose: One HTTP answer for every error a work-item create or patch can throw (task.0097).
 * Scope: Pure function and a table of error names. No I/O, no framework types; a node route turns the result into its own response.
 * Invariants:
 *   - MATCH_BY_NAME: the root entry and the adapter entry bundle separate copies of each error class, so `instanceof` misses. The table is keyed by `error.name`.
 *   - CODE_FROM_THE_TABLE: `errorCode` is fixed per name and never read from the error, so a copy that lost its fields still maps.
 *   - SHAPE_DEFAULTS: `issues` that is not an array reads `[message]`; `ids` that is not an array reads `[]`; `field` other than `"moves"` reads `"cites"`.
 *   - UNMAPPED_IS_UNDEFINED: any other error returns `undefined`, so the caller rethrows and its wrapper answers 500.
 *   - ENVELOPE_STAYS_FREE: `body` is the default wire body; a node with its own envelope builds it from `status`, `errorCode`, `message` and `body`.
 * Side-effects: none
 * Links: hub change-history-design ("Package entries a node calls")
 * @public
 */

export type WorkItemWriteOperation = "create" | "patch";

export interface WorkItemWriteErrorResponse {
  readonly status: 400 | 409 | 503;
  /** Stable machine code; the same for every copy of the error class. */
  readonly errorCode: string;
  /** The error's own message. */
  readonly message: string;
  /** The default wire body. */
  readonly body: Readonly<Record<string, unknown>>;
}

interface Fields {
  readonly message: string;
  readonly raw: Readonly<Record<string, unknown>>;
  /** Request path to `moves`: `["moves"]` on a create, `["set", "moves"]` on a patch. */
  readonly movesPath: readonly string[];
}

type Mapper = (f: Fields) => WorkItemWriteErrorResponse;

const INVALID = "invalid input";

function strings(value: unknown, fallback: readonly string[]): string[] {
  return Array.isArray(value) ? value.map(String) : [...fallback];
}

function invalid(
  errorCode: string,
  extra: Readonly<Record<string, unknown>>,
  message: string
): WorkItemWriteErrorResponse {
  return {
    status: 400,
    errorCode,
    message,
    body: { error: INVALID, errorCode, ...extra },
  };
}

function issue(path: readonly string[], message: string) {
  return { code: "custom", path, message };
}

const MAPPERS: Readonly<Record<string, Mapper>> = {
  WorkItemScoresInvalidError: ({ raw, message }) =>
    invalid(
      "work_item_scores_invalid",
      { issues: Array.isArray(raw.issues) ? raw.issues : [] },
      message
    ),
  ChangeReasonInvalidError: ({ message }) =>
    invalid(
      "reason_invalid",
      { issues: [issue(["reason"], message)] },
      message
    ),
  CitesInvalidError: ({ raw, message }) =>
    invalid(
      "cites_invalid",
      {
        issues: strings(raw.issues, [message]).map((m) => issue(["cites"], m)),
      },
      message
    ),
  CitesUnsupportedError: ({ message }) =>
    invalid("cites_unsupported", { issues: [issue(["cites"], message)] }, message),
  EntryUnresolvedError: ({ raw, message, movesPath }) => {
    const ids = strings(raw.ids, []);
    const moves = raw.field === "moves";
    return invalid(
      "cite_unresolved",
      {
        ids,
        issues: ids.map((cited) =>
          issue(
            moves ? movesPath : ["cites"],
            moves
              ? `metric not found or deprecated: ${cited}`
              : `cited entry not found: ${cited}`
          )
        ),
      },
      message
    );
  },
  MovesInvalidError: ({ raw, message, movesPath }) =>
    invalid(
      "moves_invalid",
      {
        issues: strings(raw.issues, [message]).map((m) => issue(movesPath, m)),
      },
      message
    ),
  MovesUnsupportedError: ({ message, movesPath }) =>
    invalid(
      "moves_unsupported",
      { issues: [issue(movesPath, message)] },
      message
    ),
  EntryResolverUnavailableError: ({ message }) => ({
    status: 503,
    errorCode: "cite_resolver_unavailable",
    message,
    body: {
      error: "cites_unavailable",
      errorCode: "cite_resolver_unavailable",
      message,
    },
  }),
  MetricBaselineUnavailableError: ({ message }) => ({
    status: 503,
    errorCode: "metric_baseline_unavailable",
    message,
    body: {
      error: "metric_baseline_unavailable",
      errorCode: "metric_baseline_unavailable",
      message,
    },
  }),
  WorkItemRevisionConflictError: ({ raw, message }) => ({
    status: 409,
    errorCode: "revision_conflict",
    message,
    body: {
      error: "revision_conflict",
      expectedRevision: raw.expectedRevision,
      currentRevision: raw.currentRevision,
    },
  }),
  WorkItemWriteOutcomeUnknownError: ({ raw, message }) => ({
    status: 409,
    errorCode: "work_item_write_outcome_unknown",
    message,
    body: {
      error: "work_item_write_outcome_unknown",
      retryable: false,
      lookup: {
        operationId: raw.operationId ?? null,
        branch: raw.branch ?? null,
        commitHash: raw.commitHash ?? null,
        itemId: raw.itemId ?? null,
      },
      message,
    },
  }),
  WorkItemGateUnmetError: ({ raw, message }) => ({
    status: 409,
    errorCode: "gate_unmet",
    message,
    body: {
      error: "gate_unmet",
      errorCode: "gate_unmet",
      from: raw.from ?? null,
      to: raw.to ?? null,
      missing: raw.missing ?? null,
      message,
    },
  }),
  WorkItemGateFactsUnavailableError: ({ raw, message }) => ({
    status: 503,
    errorCode: "gate_facts_unavailable",
    message,
    body: {
      error: "gate_facts_unavailable",
      errorCode: "gate_facts_unavailable",
      from: raw.from ?? null,
      to: raw.to ?? null,
      missing: raw.missing ?? null,
      message,
    },
  }),
  WorkItemAlreadyExistsError: ({ message }) => ({
    status: 409,
    errorCode: "work_item_exists",
    message,
    body: { error: message },
  }),
};

/** Error names `workItemWriteErrorResponse` answers. A test keeps this list equal to the table. */
export const WORK_ITEM_WRITE_ERROR_NAMES: readonly string[] =
  Object.freeze(Object.keys(MAPPERS));

/**
 * The HTTP answer for a work-item write error, or `undefined` when the error is not one of them.
 * `operation` only sets the request path of a `moves` issue: `moves` on a create, `set.moves` on a patch.
 */
export function workItemWriteErrorResponse(
  error: unknown,
  operation: WorkItemWriteOperation
): WorkItemWriteErrorResponse | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const raw = error as Readonly<Record<string, unknown>>;
  const name = raw.name;
  if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(MAPPERS, name)) {
    return undefined;
  }
  const mapper = MAPPERS[name];
  if (!mapper) return undefined;
  return mapper({
    raw,
    message: typeof raw.message === "string" ? raw.message : "",
    movesPath: operation === "create" ? ["moves"] : ["set", "moves"],
  });
}
