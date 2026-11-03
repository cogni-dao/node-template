// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Thin node-template binding. Shared convergence lives in scheduling/routing. */
import {
  type CharterExecution,
  type GovernanceScheduleConfig,
  type GovernanceScheduleSyncResult,
  type GovernanceScheduleSyncDeps as RoutingDeps,
  syncGovernanceSchedules as reconcile,
} from "@cogni/scheduling/routing";
import {
  isScheduleControlConflictError,
  isScheduleControlNotFoundError,
  type ScheduleControlPort,
} from "../ports/schedule-control.port";

export type {
  GovernanceScheduleConfig,
  GovernanceScheduleEntry,
  GovernanceScheduleSyncResult,
  LedgerScheduleConfig,
  UpsertGovernanceScheduleRowParams,
} from "@cogni/scheduling/routing";

export type GovernanceScheduleSyncDeps = Omit<
  RoutingDeps,
  | "scheduleControl"
  | "scheduleIdFor"
  | "ownsScheduleId"
  | "isConflictError"
  | "isNotFoundError"
  | "resolveLedgerIngestExecution"
> &
  Partial<Pick<RoutingDeps, "scheduleIdFor" | "ownsScheduleId">> & {
    scheduleControl: ScheduleControlPort;
  };

export function governanceScheduleId(charter: string): string {
  return `governance:${charter.toLowerCase()}`;
}

/** Legacy helper retained for original callers; production job binds exact own IDs. */
export function isOwnGovernanceScheduleId(id: string): boolean {
  return id.startsWith("governance:") && id.split(":").length === 2;
}

export function syncGovernanceSchedules(
  config: GovernanceScheduleConfig,
  deps: GovernanceScheduleSyncDeps
): Promise<GovernanceScheduleSyncResult> {
  return reconcile(config, {
    ...deps,
    scheduleIdFor: deps.scheduleIdFor ?? governanceScheduleId,
    ownsScheduleId: deps.ownsScheduleId ?? isOwnGovernanceScheduleId,
    isConflictError: isScheduleControlConflictError,
    isNotFoundError: isScheduleControlNotFoundError,
    resolveLedgerIngestExecution: async ({
      config,
      entry,
      governanceGrantId,
    }): Promise<CharterExecution> => {
      // Preserve template's ledger-without-config sandbox fallback, ignoring graph.
      if (!config.ledger)
        return {
          desiredInput: { message: entry.entrypoint, model: "kimi-k2.5" },
          graphId: "sandbox:openclaw",
          grantId: governanceGrantId,
        };
      return {
        desiredInput: {
          version: 1,
          scopeId: config.ledger.scopeId,
          scopeKey: config.ledger.scopeKey,
          epochLengthDays: config.ledger.epochLengthDays,
          activitySources: config.ledger.activitySources,
          ...(config.ledger.baseIssuanceCredits && {
            baseIssuanceCredits: config.ledger.baseIssuanceCredits,
          }),
          ...(config.ledger.approvers &&
            config.ledger.approvers.length > 0 && {
              approvers: config.ledger.approvers,
            }),
        },
        workflowType: "CollectEpochWorkflow",
        taskQueueOverride: "ledger-tasks",
        graphId: "ledger:ingest",
        grantId: governanceGrantId,
      };
    },
  });
}
