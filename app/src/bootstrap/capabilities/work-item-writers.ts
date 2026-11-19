// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/work-item-writers`
 * Purpose: The one place a graph tool's work-item write (patch, artifact) is wired to its attribution and its terminal events (hub activity-attribution, task.0133).
 * Scope: Composition only. The container builds the capability from these; the real-binding-path test builds it from the same function.
 * Invariants:
 *   - ACTING_PRINCIPAL_FOR_WRITES: every tool write records the run's acting principal as actor, the run's subject as requester and the run, built per call by `runAttribution` from the run scope. Never at construction, never from the subject.
 *   - ONE_TERMINAL_EVENT (task.0122): a tool write ends in the same registered events the route logs; `via: "tool"` and the run's trace id tell it from a route call.
 * Side-effects: IO (log lines)
 * @internal
 */

import {
  type WorkItemArtifactDeps,
  WriteAttributionInvalidError,
  workItemWriteErrorResponse,
} from "@cogni/work-items";
import type { WorkItemsDoltgresPort } from "@cogni/work-items/adapters/doltgres";
import {
  attributionFields,
  runAttribution,
} from "@/bootstrap/write-attribution";
import { getCurrentTraceId } from "@/bootstrap/otel";
import { EVENT_NAMES } from "@/shared/observability";
import type { WorkItemCapabilityDeps } from "./work-item";

/** The logger surface the writers use: the structured `info(fields, event)` call. */
export interface WorkItemWritersLog {
  info(fields: Record<string, unknown>, event: string): void;
}

export function createWorkItemWriters(deps: {
  readonly log: WorkItemWritersLog;
  /** The Doltgres store, read at call time (it is assigned after the capability is built). */
  readonly store: () => Pick<WorkItemsDoltgresPort, "patch">;
  /** The artifact store pair, read at call time. */
  readonly artifacts: () => WorkItemArtifactDeps | undefined;
}): Required<Pick<WorkItemCapabilityDeps, "backlogWriter" | "artifacts">> {
  const { log } = deps;
  return {
    backlogWriter: {
      attribution: runAttribution,
      // A run with no acting principal writes nothing, and the refusal is as findable as any other (same event as the route's).
      attributionDenied: ({ workItemId, error }) =>
        log.info(
          {
            event: EVENT_NAMES.WORK_ITEMS_PATCH_REFUSED,
            routeId: "work.items.patch",
            via: "tool",
            traceId: getCurrentTraceId(),
            outcome: "refused",
            workItemId,
            status: 403,
            errorCode: "attribution_denied",
            errorName: error instanceof Error ? error.name : "unknown",
          },
          EVENT_NAMES.WORK_ITEMS_PATCH_REFUSED
        ),
      store: {
        // ONE_TERMINAL_EVENT (task.0122): an agent's patch ends in the same registered event the route logs, so a refusal
        // or a success of the tool is as findable as the route's.
        patch: async (input, attribution) => {
          try {
            const patched = await deps.store().patch(input, attribution);
            log.info(
              {
                event: EVENT_NAMES.WORK_ITEMS_PATCH_SUCCESS,
                routeId: "work.items.patch",
                via: "tool",
                traceId: getCurrentTraceId(),
                outcome: "success",
                workItemId: input.id,
                ...attributionFields(attribution),
              },
              EVENT_NAMES.WORK_ITEMS_PATCH_SUCCESS
            );
            return patched;
          } catch (error) {
            const mapped = workItemWriteErrorResponse(error, "patch");
            if (!mapped && error instanceof WriteAttributionInvalidError) {
              // The host built a bad attribution: a server defect, refused before any write.
              log.info(
                {
                  event: EVENT_NAMES.WORK_ITEMS_PATCH_REFUSED,
                  routeId: "work.items.patch",
                  via: "tool",
                  traceId: getCurrentTraceId(),
                  outcome: "refused",
                  workItemId: input.id,
                  status: 500,
                  errorCode: "attribution_invalid",
                },
                EVENT_NAMES.WORK_ITEMS_PATCH_REFUSED
              );
            }
            if (mapped) {
              const { from, to, missing } = mapped.body as Record<string, unknown>;
              log.info(
                {
                  event: EVENT_NAMES.WORK_ITEMS_PATCH_REFUSED,
                  routeId: "work.items.patch",
                  via: "tool",
                  traceId: getCurrentTraceId(),
                  outcome: "refused",
                  workItemId: input.id,
                  status: mapped.status,
                  errorCode: mapped.errorCode,
                  ...(typeof from === "string" ? { from } : {}),
                  ...(typeof to === "string" ? { to } : {}),
                  ...(typeof missing === "string" ? { missing } : {}),
                },
                EVENT_NAMES.WORK_ITEMS_PATCH_REFUSED
              );
            }
            throw error;
          }
        },
      },
    },
    artifacts: {
      deps: deps.artifacts,
      attribution: runAttribution,
      log: ({ event, ...fields }, attribution) =>
        log.info(
          {
            event,
            routeId: "work.items.artifacts.create",
            via: "tool",
            traceId: getCurrentTraceId(),
            ...fields,
            ...(attribution ? attributionFields(attribution) : {}),
          },
          event
        ),
    },
  };
}
