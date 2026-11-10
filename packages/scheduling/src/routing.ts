// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Port-only governance reconciliation. Node identity, ledger policy and authority are injected. */
import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "type-fest";

const GOVERNANCE_GRAPH_ID = "sandbox:openclaw";
const GOVERNANCE_MODEL = "kimi-k2.5";
const PLATFORM_PROVIDER_KEY = "platform";

export type ScheduleOverlapPolicyHint = "skip" | "buffer_one" | "allow_all";

export interface CreateScheduleParams {
  /** Temporal schedule ID (caller-supplied) */
  readonly scheduleId: string;
  /** Originating node ID from repo-spec. Stored in workflow args for execution routing. */
  readonly nodeId: string;
  /**
   * DB schedule UUID for schedules that have a row in `schedules`.
   * Set null/undefined only for legacy Temporal-only schedules.
   */
  readonly dbScheduleId?: string | null;
  /** User ID of the schedule owner — written as requestedBy on produced runs. */
  readonly ownerUserId: string;
  /** Cron expression (5-field) */
  readonly cron: string;
  /** IANA timezone */
  readonly timezone: string;
  /** Graph ID to execute */
  readonly graphId: string;
  /** Execution grant ID for authorization */
  readonly executionGrantId: string;
  /** Graph input payload (JSON-serializable) */
  readonly input: JsonValue;
  /** Overlap policy hint. Default: "buffer_one" for tenant schedules. Governance sync passes "skip". */
  readonly overlapPolicy?: ScheduleOverlapPolicyHint;
  /** Catchup window in milliseconds. Default: 60_000 (1m). Governance passes 0. */
  readonly catchupWindowMs?: number;
  /** Workflow type to start (default: GraphRunWorkflow) */
  readonly workflowType?: string;
  /** Task queue override (default: uses adapter's configured queue) */
  readonly taskQueueOverride?: string;
}

/**
 * Schedule description returned by describeSchedule.
 * Dates are ISO strings for serialization safety.
 */
export interface ScheduleDescription {
  /** Schedule ID */
  readonly scheduleId: string;
  /** Next scheduled run time (ISO string), null if paused/none */
  readonly nextRunAtIso: string | null;
  /** Last run time (ISO string), null if never run */
  readonly lastRunAtIso: string | null;
  /** Whether schedule is paused */
  readonly isPaused: boolean;
  /** Current cron expression, null if unavailable */
  readonly cron: string | null;
  /** Current IANA timezone, null if unavailable */
  readonly timezone: string | null;
  /** Current graph input payload, null if unavailable */
  readonly input: JsonValue | null;
  /** DB schedule UUID from workflow args, null if Temporal-only (legacy) */
  readonly dbScheduleId: string | null;
  readonly taskQueue?: string | null;
}

export interface ScheduleControlPort {
  createSchedule(params: CreateScheduleParams): Promise<void>;
  updateSchedule(
    scheduleId: string,
    params: CreateScheduleParams
  ): Promise<void>;
  describeSchedule(scheduleId: string): Promise<ScheduleDescription | null>;
  pauseSchedule(scheduleId: string): Promise<void>;
  resumeSchedule(scheduleId: string): Promise<void>;
}

export interface CharterExecution {
  desiredInput: JsonValue;
  graphId: string;
  grantId: string;
  workflowType?: string;
  taskQueueOverride?: string;
}

export function governanceGraphMessage(
  entrypoint: string,
  payload: object | undefined
): string {
  return payload === undefined
    ? entrypoint
    : `${entrypoint}\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
}

/** Minimal governance schedule shape (no @/ imports — pure type) */
export interface GovernanceScheduleEntry {
  charter: string;
  cron: string;
  timezone: string;
  entrypoint: string;
  /**
   * Optional namespaced catalog graph id (e.g. `langgraph:cogni-decide`). When set,
   * the charter runs THAT graph via GraphRunWorkflow with a graph-run input
   * (`messages` + `modelRef`). Absent → `sandbox:openclaw`, byte-for-byte unchanged.
   * LEDGER_INGEST behavior is determined by the injected ledger resolver.
   */
  graph?: string;
  /** Platform model id for the `graph` run. Required when `graph` is set. */
  model?: string;
  /** Trusted node-supplied graph payload; omitted preserves entrypoint exactly. */
  payload?: object;
}

/** Ledger config for LEDGER_INGEST schedules */
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
  /** Ledger config — required when LEDGER_INGEST charter is present */
  ledger?: LedgerScheduleConfig;
}

/** Logger interface matching pino shape */
interface SyncLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Parameters for upserting a governance schedule DB row */
export interface UpsertGovernanceScheduleRowParams {
  /** Temporal schedule ID (e.g., "governance:community") */
  temporalScheduleId: string;
  /** System tenant user ID */
  ownerUserId: string;
  /** Execution grant ID for authorization */
  executionGrantId: string;
  /** Graph ID (e.g., "sandbox:openclaw") */
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
   * principal, returns grantId. Used only for charters that declare `graph` — the
   * sandbox governance grant (and therefore every pre-existing schedule, LEDGER_INGEST
   * included) is untouched. Absent → graph charters are skipped with a warning (a run
   * on the sandbox-scoped grant would 403 at the graph-run route's scope check).
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
  /** Caller binds IDs and ownership to the same node prefix / exact legacy IDs. */
  scheduleIdFor(charter: string): string;
  ownsScheduleId(scheduleId: string): boolean;
  isConflictError(error: unknown): boolean;
  isNotFoundError(error: unknown): boolean;
  resolveLedgerIngestExecution(ctx: {
    entry: GovernanceScheduleEntry;
    config: GovernanceScheduleConfig;
    nodeId: string;
    governanceGrantId: string;
  }): Promise<CharterExecution | null>;
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
 * Checks whether the desired schedule config differs from the current Temporal state.
 * NOTE: cron comparison is skipped when desc.cron is null (Temporal compiles crons
 * to calendars, so the original string isn't available). Input + timezone cover
 * the critical drift cases (model, entrypoint, timezone changes).
 */
function scheduleConfigChanged(
  desc: ScheduleDescription,
  _cron: string,
  timezone: string,
  input: JsonValue,
  desiredTaskQueue: string | undefined
): boolean {
  return (
    (desc.timezone !== null && desc.timezone !== timezone) ||
    !isDeepStrictEqual(desc.input, input) ||
    (desiredTaskQueue !== undefined &&
      typeof desc.taskQueue === "string" &&
      desc.taskQueue !== desiredTaskQueue)
  );
}

/**
 * Syncs governance schedules from repo-spec config to Temporal.
 *
 * For each schedule in config:
 * - If missing in Temporal: create
 * - If exists with changed config: update in-place
 * - If exists but paused (same config): resume
 * - If exists but paused (changed config): update + resume
 * - If exists, running, same config: skip (no-op)
 *
 * For governance schedules in Temporal but not in config:
 * - Pause (don't delete — reversible)
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

  // Validate every generated ID before grants, DB writes or Temporal mutations.
  if (!deps.nodeId || deps.nodeId.includes(":"))
    throw new Error("Invalid governance node ID");
  const desiredIds = new Set<string>();
  const planned: [GovernanceScheduleEntry, string][] = [];
  for (const entry of config.schedules) {
    const id = deps.scheduleIdFor(entry.charter);
    if (
      !entry.charter ||
      entry.charter.includes(":") ||
      !id ||
      !deps.ownsScheduleId(id) ||
      desiredIds.has(id)
    ) {
      throw new Error("Invalid, duplicate or unowned governance schedule ID");
    }
    desiredIds.add(id);
    planned.push([entry, id]);
  }
  if (
    config.schedules.some(
      (entry) => entry.charter.toUpperCase() === "LEDGER_INGEST"
    ) &&
    typeof deps.resolveLedgerIngestExecution !== "function"
  ) {
    throw new Error("Missing ledger execution resolver");
  }

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

  for (const [schedule, scheduleId] of planned) {
    configScheduleIds.add(scheduleId);

    // Determine if this is a LEDGER_INGEST schedule (different workflow + queue)
    const isLedgerIngest = schedule.charter.toUpperCase() === "LEDGER_INGEST";

    let desiredInput: JsonValue;
    let workflowType: string | undefined;
    let taskQueueOverride: string | undefined;
    let graphId: string;
    let grantId: string;

    const ledgerExecution = isLedgerIngest
      ? await deps.resolveLedgerIngestExecution({
          entry: schedule,
          config,
          nodeId: deps.nodeId,
          governanceGrantId,
        })
      : null;
    if (ledgerExecution !== null) {
      ({ desiredInput, workflowType, taskQueueOverride, graphId, grantId } =
        ledgerExecution);
    } else if (schedule.graph !== undefined) {
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
        messages: [
          {
            role: "user",
            content: governanceGraphMessage(
              schedule.entrypoint,
              schedule.payload
            ),
          },
        ],
        modelRef: {
          providerKey: PLATFORM_PROVIDER_KEY,
          modelId: schedule.model,
        },
      };
      graphId = schedule.graph;
      grantId = await deps.ensureGraphGrant(schedule.graph);
    } else {
      desiredInput = {
        message: schedule.entrypoint,
        model: GOVERNANCE_MODEL,
      };
      graphId = GOVERNANCE_GRAPH_ID;
      grantId = governanceGrantId;
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
      workflowType,
      taskQueueOverride,
    };

    try {
      await scheduleControl.createSchedule(desiredParams);
      result.created.push(scheduleId);
      log.info(
        { scheduleId, cron: schedule.cron },
        "Created governance schedule"
      );
    } catch (error) {
      if (deps.isConflictError(error)) {
        // Schedule already exists — check for config or link drift
        const desc = await scheduleControl.describeSchedule(scheduleId);
        if (!desc) {
          // Race condition: schedule disappeared between create and describe
          result.skipped.push(scheduleId);
          continue;
        }

        const configChanged = scheduleConfigChanged(
          desc,
          schedule.cron,
          schedule.timezone,
          desiredInput,
          taskQueueOverride
        );
        const linkDrift = desc.dbScheduleId !== dbScheduleId;
        // The description omits graph/grant and canonical cron. Reapply graph
        // charters in full so rotations, graph-only changes and equal-next-tick
        // cadence changes converge, including while paused.
        const reapplyGraph =
          schedule.graph !== undefined && ledgerExecution === null;

        if (reapplyGraph || configChanged || linkDrift) {
          await scheduleControl.updateSchedule(scheduleId, desiredParams);
          if (desc.isPaused) {
            await scheduleControl.resumeSchedule(scheduleId);
          }
          result.updated.push(scheduleId);
          log.info(
            { scheduleId, configChanged, linkDrift, reapplyGraph },
            "Updated governance schedule (drift detected)"
          );
        } else if (desc.isPaused) {
          await scheduleControl.resumeSchedule(scheduleId);
          result.resumed.push(scheduleId);
          log.info({ scheduleId }, "Resumed governance schedule");
        } else {
          result.skipped.push(scheduleId);
          log.info({ scheduleId }, "Governance schedule up to date, skipping");
        }
      } else {
        throw error;
      }
    }
  }

  // Own-row candidates are narrowed by the caller; ownership also guards the pure loop.
  const allGovernanceIds = await deps.listGovernanceScheduleIds();
  for (const existingId of allGovernanceIds) {
    if (deps.ownsScheduleId(existingId) && !configScheduleIds.has(existingId)) {
      try {
        await scheduleControl.pauseSchedule(existingId);
        await deps.disableSchedule(existingId);
        result.paused.push(existingId);
        log.warn(
          { scheduleId: existingId },
          "Paused governance schedule (removed from repo-spec)"
        );
      } catch (error) {
        if (deps.isNotFoundError(error)) {
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
