// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tool-writers`
 * Purpose: The one place a graph tool's work-item write (patch, artifact) is wired to its attribution and its terminal events (hub activity-attribution, task.0133, task.0175).
 * Scope: Composition over injected functions: the node passes its run scope, its logger, its trace id reader and its two stores. It returns the `backlogWriter` and `artifacts` parts a node's work-item capability takes. No I/O of its own.
 * Invariants:
 *   - ACTING_PRINCIPAL_FOR_WRITES: every tool write records the run's acting principal as actor, the run's subject as requester and the run, built per call from the run scope. Never at construction, never from the subject.
 *   - ONE_TERMINAL_EVENT (task.0122): a tool write ends in the same events the route logs (`WORK_ITEM_WRITE_EVENTS`); `via: "tool"` and the run's trace id tell it from a route call.
 * Side-effects: log lines through the injected logger
 * Links: hub agent-run-authority, activity-attribution
 * @public
 */

import {
  type RunAttributionLog,
  type RunAttributionScope,
  type WriteAttribution,
  WriteAttributionInvalidError,
  attributionFields,
  createRunAttribution,
} from "./attribution.js";
import type { ArtifactLog, WorkItemArtifactDeps } from "./artifacts.js";
import type { WorkItemsPort } from "./content.js";
import { WORK_ITEM_WRITE_EVENTS } from "./write-http.js";
import { workItemWriteErrorResponse } from "./write-errors.js";

/** The logger surface the writers use: the structured `info(fields, event)` and `warn(fields, event)` calls. */
export interface WorkItemWritersLog extends RunAttributionLog {
  info(fields: Record<string, unknown>, event: string): void;
}

export interface WorkItemWritersDeps {
  readonly log: WorkItemWritersLog;
  /** The run scope, read at each call. */
  readonly scope: () => RunAttributionScope;
  /** The current trace id, or undefined. */
  readonly traceId: () => string | undefined;
  /** The Doltgres store, read at call time (it is assigned after the capability is built). */
  readonly store: () => Pick<WorkItemsPort, "patch">;
  /** The artifact store pair, read at call time. */
  readonly artifacts: () => WorkItemArtifactDeps | undefined;
}

/** The two parts of a node's work-item capability that write for a graph tool. */
export interface WorkItemWriters {
  readonly backlogWriter: {
    readonly store: Pick<WorkItemsPort, "patch">;
    readonly attribution: () => WriteAttribution;
    readonly attributionDenied: (event: { workItemId: string; error: unknown }) => void;
  };
  readonly artifacts: {
    readonly deps: () => WorkItemArtifactDeps | undefined;
    readonly attribution: () => WriteAttribution;
    readonly log: (log: ArtifactLog, attribution?: WriteAttribution) => void;
  };
}

export function createWorkItemWriters(deps: WorkItemWritersDeps): WorkItemWriters {
  const { log } = deps;
  const attribution = createRunAttribution({ scope: deps.scope, log });
  const refused = (fields: Record<string, unknown>): void =>
    log.info(
      {
        event: WORK_ITEM_WRITE_EVENTS.patchRefused,
        routeId: "work.items.patch",
        via: "tool",
        traceId: deps.traceId(),
        outcome: "refused",
        ...fields,
      },
      WORK_ITEM_WRITE_EVENTS.patchRefused
    );
  return {
    backlogWriter: {
      attribution,
      // A run with no acting principal writes nothing, and the refusal is as findable as any other (same event as the route's).
      attributionDenied: ({ workItemId, error }) =>
        refused({
          workItemId,
          status: 403,
          errorCode: "attribution_denied",
          errorName: error instanceof Error ? error.name : "unknown",
        }),
      store: {
        // ONE_TERMINAL_EVENT (task.0122): an agent's patch ends in the same registered event the route logs, so a refusal
        // or a success of the tool is as findable as the route's.
        patch: async (input, attributed) => {
          try {
            const patched = await deps.store().patch(input, attributed);
            log.info(
              {
                event: WORK_ITEM_WRITE_EVENTS.patchSuccess,
                routeId: "work.items.patch",
                via: "tool",
                traceId: deps.traceId(),
                outcome: "success",
                workItemId: input.id,
                ...attributionFields(attributed),
              },
              WORK_ITEM_WRITE_EVENTS.patchSuccess
            );
            return patched;
          } catch (error) {
            const mapped = workItemWriteErrorResponse(error, "patch");
            if (!mapped && error instanceof WriteAttributionInvalidError) {
              // The host built a bad attribution: a server defect, refused before any write.
              refused({ workItemId: input.id, status: 500, errorCode: "attribution_invalid" });
            }
            if (mapped) {
              const { from, to, missing } = mapped.body as Record<string, unknown>;
              refused({
                workItemId: input.id,
                status: mapped.status,
                errorCode: mapped.errorCode,
                ...(typeof from === "string" ? { from } : {}),
                ...(typeof to === "string" ? { to } : {}),
                ...(typeof missing === "string" ? { missing } : {}),
              });
            }
            throw error;
          }
        },
      },
    },
    artifacts: {
      deps: deps.artifacts,
      attribution,
      log: ({ event, ...fields }, attributed) =>
        log.info(
          {
            event,
            routeId: "work.items.artifacts.create",
            via: "tool",
            traceId: deps.traceId(),
            ...fields,
            ...(attributed ? attributionFields(attributed) : {}),
          },
          event
        ),
    },
  };
}
