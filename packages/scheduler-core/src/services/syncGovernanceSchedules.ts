// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-core/services/syncGovernanceSchedules`
 * Purpose: Sync governance schedules from config to Temporal. Pure orchestration — depends only on ports and types.
 * Scope: Creates/updates/resumes node-scoped Temporal schedules for each graph charter in governance config; pauses this node's schedules removed from config. Never schedules LEDGER_INGEST (the operator owns epoch-collect dispatch into the node). Does not manage tenant-facing schedule CRUD or workflow execution.
 * Invariants:
 *   - OVERLAP_SKIP_DEFAULT: All governance schedules use overlap=SKIP (enforced by ScheduleControlPort)
 *   - CATCHUP_WINDOW_ZERO: No backfill (enforced by ScheduleControlPort)
 *   - PRUNE_IS_PAUSE: Removed schedules are paused, never deleted (reversible)
 *   - SYSTEM_OPS_ONLY: This function runs at deploy time, never exposed as an API endpoint
 *   - PURE_ORCHESTRATION: No adapters, no Temporal client — only ports/types/callbacks
 *   - SYSTEM_TENANT_IS_TENANT: Governance schedules are first-class DB rows owned by system principal
 *   - UPDATE_ON_DRIFT: Existing schedules are updated in-place (always, for graph charters)
 *   - GRAPH_REAPPLY: existing graph charters receive their full desired action on every reconcile.
 *   - NODE_SCOPED_SCHEDULE_ID (bug.0026): every schedule id this sync writes is
 *     `governance:{nodeId}:{charter}`. All nodes of an environment share ONE Temporal namespace, so a
 *     flat `governance:{charter}` id is a single schedule that the last writer owns.
 *   - LEDGER_COLLECT_IS_OPERATOR_OWNED (bug.0026): a node never writes a LEDGER_INGEST schedule. The
 *     operator creates `governance:{nodeId}:ledger_ingest` and dispatches `/api/internal/attribution/collect`
 *     into the node. The charter is skipped here, never given a DB row, and never pruned.
 *   - LEGACY_FLAT_IDS (bug.0026): a node never touches a flat `governance:{charter}` schedule in Temporal;
 *     it cannot know whose it is (the operator owns `governance:ledger_ingest`). It only disables its own
 *     database row for a flat id left by an older build.
 *   - GRAPH_CHARTER (task.5282): a non-ledger charter that declares `graph` (+ `model`) runs that
 *     catalog graph via GraphRunWorkflow with `{ messages: [entrypoint], modelRef: platform/model }`
 *     on its own `graph:execute:{graph}` grant. A non-ledger charter WITHOUT `graph` has nothing to
 *     run: it is skipped with a warning (never an error) and an existing copy is paused by the
 *     prune step.
 * Side-effects: IO (Temporal RPC via ScheduleControlPort, grant creation via ensureGovernanceGrant / ensureGraphGrant)
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/scheduler.md, https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/governance-council.md, .cogni/repo-spec.yaml
 * @public
 */

import {
  governanceScheduleId,
  isLegacyFlatGovernanceScheduleId,
  isOperatorOwnedGovernanceCharter,
  isOwnGovernanceScheduleId,
} from "@cogni/scheduling";
import type { JsonValue } from "type-fest";

export {
  governanceScheduleId,
  isLegacyFlatGovernanceScheduleId,
  isOwnGovernanceScheduleId,
} from "@cogni/scheduling";

import {
  type CreateScheduleParams,
  isScheduleControlConflictError,
  isScheduleControlNotFoundError,
  type ScheduleControlPort,
} from "../ports/schedule-control.port";

/**
 * Provider key for platform (LiteLLM) models in a graph-run `modelRef` — the same
 * key the schedules UI and pr-review use for platform model ids.
 */
const PLATFORM_PROVIDER_KEY = "platform";

/** Minimal governance schedule shape (no @/ imports — pure type) */
export interface GovernanceScheduleEntry {
  charter: string;
  cron: string;
  timezone: string;
  entrypoint: string;
  /**
   * Optional namespaced catalog graph id (e.g. `langgraph:cogni-decide`). When set,
   * the charter runs THAT graph via GraphRunWorkflow with a graph-run input
   * (`messages` + `modelRef`). Absent → the charter is skipped with a warning.
   * LEDGER_INGEST is always skipped: the operator owns epoch collection.
   */
  graph?: string;
  /** Platform model id for the `graph` run. Required when `graph` is set. */
  model?: string;
}

/** Ledger config carried by repo-spec. The node sync does not schedule from it (operator-owned). */
export interface LedgerScheduleConfig {
  /** Stable opaque scope UUID */
  scopeId: string;
  /** Human-friendly scope slug */
  scopeKey: string;
  /** Epoch length in days */
  epochLengthDays: number;
  /** Map of source name → source config */
  activitySources: Record<
    string,
    {
      attributionPipeline: string;
      sourceRefs: string[];
    }
  >;
  /** Pool budget: base_issuance_credits as string (bigint serialized). */
  baseIssuanceCredits?: string;
  /** EVM approver addresses for epoch close. */
  approvers?: string[];
}

/** Minimal governance config shape (no @/ imports — pure type) */
export interface GovernanceScheduleConfig {
  schedules: GovernanceScheduleEntry[];
  /** Ledger config from repo-spec. Unused by the sync: the operator dispatches collection. */
  ledger?: LedgerScheduleConfig;
}

/** Logger interface matching pino shape */
interface SyncLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Parameters for upserting a governance schedule DB row */
export interface UpsertGovernanceScheduleRowParams {
  /** Temporal schedule ID (e.g., "governance:{nodeId}:community") */
  temporalScheduleId: string;
  /** System tenant user ID */
  ownerUserId: string;
  /** Execution grant ID for authorization */
  executionGrantId: string;
  /** Graph ID (e.g., "langgraph:cogni-decide") */
  graphId: string;
  /** Graph input payload */
  input: JsonValue;
  /** Cron expression */
  cron: string;
  /** IANA timezone */
  timezone: string;
}

/** Injectable dependencies for governance schedule sync */
export interface GovernanceScheduleSyncDeps {
  /** Idempotent: ensures governance grant exists, returns grantId */
  ensureGovernanceGrant(): Promise<string>;
  /**
   * Idempotent: ensures a grant scoped `graph:execute:{graphId}` exists for the system
   * principal, returns grantId. Used only for charters that declare `graph`. Absent → graph charters are
   * skipped with a warning.
   */
  ensureGraphGrant?(graphId: string): Promise<string>;
  /** Upsert governance schedule row in DB, returns dbScheduleId (UUID) */
  upsertGovernanceScheduleRow(
    params: UpsertGovernanceScheduleRowParams
  ): Promise<string>;
  /** System tenant user ID (owner of governance schedules) */
  systemUserId: string;
  /** Node ID from repo-spec (routes execution to correct node) */
  nodeId: string;
  /** Temporal schedule lifecycle control */
  scheduleControl: ScheduleControlPort;
  /** Returns all Temporal schedule IDs with 'governance:' prefix */
  listGovernanceScheduleIds(): Promise<string[]>;
  /** Disable a governance schedule (DB + Temporal) by its Temporal schedule ID */
  disableSchedule(temporalScheduleId: string): Promise<void>;
  /** Structured logger */
  log: SyncLogger;
}

/** Result of a governance schedule sync operation */
export interface GovernanceScheduleSyncResult {
  created: string[];
  updated: string[];
  resumed: string[];
  skipped: string[];
  paused: string[];
}

/**
 * Syncs governance schedules from repo-spec config to Temporal.
 *
 * For each graph charter in config (LEDGER_INGEST is skipped: operator-owned):
 * - If missing in Temporal: create
 * - If it exists: update in place, and resume it if paused (GRAPH_REAPPLY)
 *
 * For this node's governance schedules in Temporal but not in config:
 * - Pause (don't delete — reversible)
 * For a legacy flat `governance:{charter}` row: disable the DB row only.
 *
 * @param config - Governance config from repo-spec
 * @param deps - Injectable dependencies
 * @returns Summary of actions taken
 */
export async function syncGovernanceSchedules(
  config: GovernanceScheduleConfig,
  deps: GovernanceScheduleSyncDeps
): Promise<GovernanceScheduleSyncResult> {
  const { scheduleControl, log } = deps;

  // 1. Ensure governance grant exists for cogni_system
  const governanceGrantId = await deps.ensureGovernanceGrant();
  log.info({ grantId: governanceGrantId }, "Governance grant ready");

  // 2. Create, update, or resume schedules from config
  const result: GovernanceScheduleSyncResult = {
    created: [],
    updated: [],
    resumed: [],
    skipped: [],
    paused: [],
  };

  const configScheduleIds = new Set<string>();

  for (const schedule of config.schedules) {
    const scheduleId = governanceScheduleId(deps.nodeId, schedule.charter);

    // LEDGER_COLLECT_IS_OPERATOR_OWNED: the operator owns epoch collection and creates
    // `governance:{nodeId}:ledger_ingest` itself. Writing it here would overwrite that
    // schedule. Never created, never given a DB row, never pruned (see
    // isOwnGovernanceScheduleId).
    const isLedgerIngest = isOperatorOwnedGovernanceCharter(schedule.charter);
    if (isLedgerIngest) {
      log.info(
        { scheduleId },
        "Skipping governance schedule: epoch collection is operator-owned"
      );
      result.skipped.push(scheduleId);
      continue;
    }

    configScheduleIds.add(scheduleId);

    let desiredInput: JsonValue;
    let graphId: string;
    let grantId: string;

    if (schedule.graph !== undefined) {
      // GRAPH_CHARTER (task.5282): run the declared catalog graph through the default
      // GraphRunWorkflow. The input mirrors a user-created graph schedule — the
      // entrypoint as the single user message plus an explicit platform `modelRef`
      // (the internal graph-run route requires `modelRef`; there is no model default).
      if (schedule.model === undefined || deps.ensureGraphGrant === undefined) {
        log.warn(
          {
            scheduleId,
            graph: schedule.graph,
            hasModel: schedule.model !== undefined,
            hasGraphGrant: deps.ensureGraphGrant !== undefined,
          },
          "Skipping governance graph schedule: model or graph grant unavailable"
        );
        // Not added to the live set below → an existing copy is paused by the prune
        // step instead of firing runs that would fail the route's validation.
        configScheduleIds.delete(scheduleId);
        result.skipped.push(scheduleId);
        continue;
      }
      desiredInput = {
        messages: [{ role: "user", content: schedule.entrypoint }],
        modelRef: {
          providerKey: PLATFORM_PROVIDER_KEY,
          modelId: schedule.model,
        },
      };
      graphId = schedule.graph;
      grantId = await deps.ensureGraphGrant(schedule.graph);
    } else {
      // No `graph` declared on a non-ledger charter: there is no program to run.
      // Warn and skip (repo-spec is shared across forks; missing config never blocks).
      log.warn(
        { scheduleId },
        "Skipping governance schedule: charter declares no `graph`"
      );
      // Not added to the live set → an existing copy is paused by the prune step.
      configScheduleIds.delete(scheduleId);
      result.skipped.push(scheduleId);
      continue;
    }

    // Upsert DB row first — governance schedules are first-class DB rows
    const dbScheduleId = await deps.upsertGovernanceScheduleRow({
      temporalScheduleId: scheduleId,
      ownerUserId: deps.systemUserId,
      executionGrantId: grantId,
      graphId,
      input: desiredInput,
      cron: schedule.cron,
      timezone: schedule.timezone,
    });

    const desiredParams: CreateScheduleParams = {
      scheduleId,
      nodeId: deps.nodeId,
      dbScheduleId,
      ownerUserId: deps.systemUserId,
      cron: schedule.cron,
      timezone: schedule.timezone,
      graphId,
      executionGrantId: grantId,
      input: desiredInput,
      overlapPolicy: "skip",
      catchupWindowMs: 0,
    };

    try {
      await scheduleControl.createSchedule(desiredParams);
      result.created.push(scheduleId);
      log.info(
        { scheduleId, cron: schedule.cron },
        "Created governance schedule"
      );
    } catch (error) {
      if (isScheduleControlConflictError(error)) {
        // Schedule already exists. The description omits graph/grant and canonical cron,
        // so every graph charter is reapplied in full (GRAPH_REAPPLY): rotations,
        // graph-only changes and cadence changes converge, including while paused.
        const desc = await scheduleControl.describeSchedule(scheduleId);
        if (!desc) {
          // Race condition: schedule disappeared between create and describe
          result.skipped.push(scheduleId);
          continue;
        }

        await scheduleControl.updateSchedule(scheduleId, desiredParams);
        if (desc.isPaused) {
          await scheduleControl.resumeSchedule(scheduleId);
        }
        result.updated.push(scheduleId);
        log.info(
          { scheduleId, linkDrift: desc.dbScheduleId !== dbScheduleId },
          "Updated governance schedule (drift detected)"
        );
      } else {
        throw error;
      }
    }
  }

  // 3. Prune: pause governance schedules not in current config — but ONLY the ones THIS
  // node owns (`governance:{ownNodeId}:{charter}`, never the ledger charter). The shared
  // Temporal namespace also holds the operator's flat and node-scoped schedules and
  // sibling nodes' schedules. See {@link isOwnGovernanceScheduleId}.
  const allGovernanceIds = await deps.listGovernanceScheduleIds();
  for (const existingId of allGovernanceIds) {
    if (isLegacyFlatGovernanceScheduleId(existingId)) {
      // LEGACY_FLAT_IDS: retire this node's DB row only. Temporal is left alone.
      await deps.disableSchedule(existingId);
      log.warn(
        { scheduleId: existingId },
        "Disabled legacy flat governance schedule row (Temporal schedule untouched)"
      );
      continue;
    }
    if (
      isOwnGovernanceScheduleId(deps.nodeId, existingId) &&
      !configScheduleIds.has(existingId)
    ) {
      try {
        await scheduleControl.pauseSchedule(existingId);
        await deps.disableSchedule(existingId);
        result.paused.push(existingId);
        log.warn(
          { scheduleId: existingId },
          "Paused governance schedule (removed from repo-spec)"
        );
      } catch (error) {
        if (isScheduleControlNotFoundError(error)) {
          // Schedule was deleted externally — nothing to pause
          log.warn(
            { scheduleId: existingId },
            "Governance schedule not found in Temporal (deleted externally)"
          );
        } else {
          throw error;
        }
      }
    }
  }

  return result;
}
