// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/readyz/readyz-probes`
 * Purpose: The deep-readiness probe primitives and the declared-dependency registry that `/readyz` consumes.
 * Scope: Owns the per-check budget/runner primitives, the four shared substrate probes, the Doltgres/LiteLLM/Redis probes, the `SUBSTRATE_DEPENDENCIES` declaration map, and the env-schema parity helper. Does not own the HTTP handler.
 * Invariants:
 *   - Imports are one-way: `route.ts` → this module (never the reverse), so the type + runner + parity helper can later move to a shared package unchanged (story.0025).
 *   - `?deep=1` probes exactly the dependencies this node DECLARES (`isDeclared`), each reach-only, fatal on failure. An undeclared dependency is never probed and never a failure.
 *   - Deep registry order fixes the `reason`/`message` first-failure and the `unreachable[]` order: evm-rpc, temporal, scheduler-worker, postgres, redis, litellm-gateway, doltgres.
 *   - Every substrate env key (server-env `/_(URL|ADDRESS)$/`) is either owned by a map entry or in `NON_SUBSTRATE_ALLOWLIST`; `findUnclassifiedSubstrateKeys` fails CI otherwise (drift guard).
 * Side-effects: IO (network reads to RPC/Temporal/LiteLLM/Redis, DB reads) only when a probe runs.
 * Links: src/app/(infra)/readyz/route.ts, fleet-reliability-substrate-matrix, node-substrate-health-checklist
 * @public
 */

import type { getContainer } from "@/bootstrap/container";
import { verifySystemTenant } from "@/bootstrap/healthchecks";
import type { serverEnv } from "@/shared/env";
import {
  assertSchedulerWorkerConnectivity,
  assertTemporalConnectivity,
  checkEvmRpcConnectivity,
  InfraConnectivityError,
} from "@/shared/env/invariants";
import type { RequestContext } from "@/shared/observability";

type Container = ReturnType<typeof getContainer>;
type Env = ReturnType<typeof serverEnv>;

/** Default-path budget for each non-fatal remote check (EVM RPC, Temporal, scheduler-worker). */
export const NON_FATAL_CHECK_BUDGET_MS = 1500;
/** Default-path budget for the fatal system-tenant DB check; exceeding it is a 503. */
export const SYSTEM_TENANT_BUDGET_MS = 2000;
/** Successful system-tenant checks are reused for at most this long. Failures are never cached. */
export const SYSTEM_TENANT_OK_TTL_MS = 30_000;
/** An in-flight tenant query older than this is abandoned and a fresh one started. */
export const SYSTEM_TENANT_INFLIGHT_MAX_AGE_MS = 10_000;
/**
 * Deep-path budget for each dependency check. The checks run concurrently, so the
 * whole probe stays under this plus the response; it must stay below the 5 s deadline
 * of the fleet prober that reads `unreachable`, and above the 2 s system-tenant sub-budget.
 */
export const DEEP_CHECK_BUDGET_MS = 3000;
/** Readiness summaries at or above this duration log at info (debug otherwise). */
export const SLOW_READINESS_LOG_MS = 1000;

/** A fixed, never-present id: a healthy knowledge plane returns null, a dead one throws. */
const DOLTGRES_READYZ_PROBE_ID = "readyz-probe-knowledge-reach";
/** A fixed run id for the Redis XLEN reach probe; missing key returns 0. */
const REDIS_READYZ_PROBE_KEY = "readyz:probe";

/** Epoch ms of the last successful default-path system-tenant check (0 = never). */
let systemTenantVerifiedAtMs = 0;
/** The single in-flight default-path tenant query, shared by concurrent probes. */
let systemTenantInflight: {
  promise: Promise<void>;
  startedAtMs: number;
} | null = null;

export type CheckStatus = "ok" | "cached" | "degraded" | "timeout" | "failed";
export type CheckTimings = Record<
  string,
  { status: CheckStatus; durationMs: number }
>;

const CHECK_TIMEOUT = Symbol("readyz.check_timeout");

/** Dependencies a deep 503 can name in `unreachable`. */
export type DeepDependency =
  | "postgres"
  | "temporal"
  | "scheduler-worker"
  | "evm-rpc"
  | "redis"
  | "litellm-gateway"
  | "doltgres";

/** A deep probe failed: carries the first failure (for reason/message) and every failing dependency. */
export class DeepProbeFailure extends Error {
  constructor(
    readonly primary: unknown,
    readonly unreachable: DeepDependency[]
  ) {
    super("deep readiness failed");
    this.name = "DeepProbeFailure";
  }
}

/**
 * Deep path: run every dependency check at once, each under its own deadline, and
 * report every failure. Throws DeepProbeFailure when any check fails; the first
 * failure in `checks` order is `primary`.
 */
export async function runDeepChecks(
  checks: ReadonlyArray<readonly [DeepDependency, () => Promise<unknown>]>
): Promise<void> {
  const results = await Promise.allSettled(
    checks.map(async ([dependency, run]) => {
      const result = await withBudget(
        Promise.resolve().then(run),
        DEEP_CHECK_BUDGET_MS
      );
      if (result === CHECK_TIMEOUT) {
        throw new InfraConnectivityError(
          `${dependency} check exceeded ${DEEP_CHECK_BUDGET_MS}ms budget`
        );
      }
    })
  );
  const unreachable: DeepDependency[] = [];
  let primary: unknown;
  results.forEach((result, index) => {
    const entry = checks[index];
    if (result.status !== "rejected" || !entry) return;
    if (unreachable.length === 0) primary = result.reason;
    unreachable.push(entry[0]);
  });
  if (unreachable.length > 0) throw new DeepProbeFailure(primary, unreachable);
}

/**
 * Race `promise` against a budget. The underlying work keeps running (and may
 * warm a cache, e.g. the EVM RPC probe), but the probe stops waiting for it.
 */
export async function withBudget<T>(
  promise: Promise<T>,
  budgetMs: number
): Promise<T | typeof CHECK_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof CHECK_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(CHECK_TIMEOUT), budgetMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Run one named check, recording its status and duration in `timings`. */
export async function timed(
  timings: CheckTimings,
  name: string,
  run: () => Promise<CheckStatus>
): Promise<void> {
  const startedAt = Date.now();
  try {
    const status = await run();
    timings[name] = { status, durationMs: Date.now() - startedAt };
  } catch (error) {
    timings[name] = { status: "failed", durationMs: Date.now() - startedAt };
    throw error;
  }
}

export function logBudgetExceeded(
  ctx: RequestContext,
  event: string,
  dependency: string
): void {
  ctx.log.warn(
    {
      event,
      severity: "degraded",
      reason: "CHECK_TIMEOUT",
      dependency,
      budgetMs: NON_FATAL_CHECK_BUDGET_MS,
    },
    `readiness: ${dependency} check exceeded its budget, returning ready (non-fatal)`
  );
}

/**
 * Fatal system-tenant check (per SYSTEM_TENANT_STARTUP_CHECK). Bounded so a
 * wedged service pool fails the probe fast (503) instead of past its timeout;
 * success is cached briefly so steady-state probes do not hit Postgres.
 * Probes share one in-flight query, and a success that lands after a probe's
 * budget still fills the cache, so a slow-but-healthy DB does not stack
 * queries or 503 forever. A query that never settles (the DB client has no
 * query timeout) is abandoned after SYSTEM_TENANT_INFLIGHT_MAX_AGE_MS so a
 * fresh query can prove recovery. Failures are never cached.
 */
export async function checkSystemTenant(
  serviceAccountService: Parameters<typeof verifySystemTenant>[0]
): Promise<CheckStatus> {
  if (
    systemTenantVerifiedAtMs > 0 &&
    Date.now() - systemTenantVerifiedAtMs < SYSTEM_TENANT_OK_TTL_MS
  ) {
    return "cached";
  }
  if (
    !systemTenantInflight ||
    Date.now() - systemTenantInflight.startedAtMs >
      SYSTEM_TENANT_INFLIGHT_MAX_AGE_MS
  ) {
    // An abandoned query that settles later must not touch the newer state.
    const inflight = {
      startedAtMs: Date.now(),
      promise: verifySystemTenant(serviceAccountService)
        .then(() => {
          if (systemTenantInflight === inflight) {
            systemTenantVerifiedAtMs = Date.now();
          }
        })
        .finally(() => {
          if (systemTenantInflight === inflight) systemTenantInflight = null;
        }),
    };
    systemTenantInflight = inflight;
  }
  const result = await withBudget(
    systemTenantInflight.promise,
    SYSTEM_TENANT_BUDGET_MS
  );
  if (result === CHECK_TIMEOUT) {
    throw new InfraConnectivityError(
      `System tenant check exceeded ${SYSTEM_TENANT_BUDGET_MS}ms budget`
    );
  }
  return "ok";
}

/**
 * Async-substrate connectivity check that is NON-FATAL to the k8s readiness
 * probe by default. Temporal and scheduler-worker are async dispatch substrate,
 * not synchronous serving dependencies — failing /readyz on their blip drains
 * every node-app from its Service endpoints and causes a fleet-wide 502
 * (incident 2026-06-26). Same rationale already applied to EVM RPC.
 *
 * They ARE mission-critical: all AI/chat work is dispatched through Temporal, so
 * a sustained outage means AI is down. We therefore log failures at ERROR with a
 * stable `event` + `severity:"critical"` so monitoring fires a critical alert,
 * and the request paths that need the substrate return 503 at request time — we
 * just never take the public site down with the probe.
 *
 * `deep` (from `?deep=1`) restores hard-fail semantics for provisioning /
 * stack-test smoke checks that must assert the substrate is actually up.
 */
export async function assertSubstrate(
  check: () => Promise<void>,
  opts: {
    ctx: RequestContext;
    deep: boolean;
    event: string;
    dependency: string;
  }
): Promise<CheckStatus> {
  try {
    if (opts.deep) {
      await check();
      return "ok";
    }
    const inflight = check();
    const result = await withBudget(inflight, NON_FATAL_CHECK_BUDGET_MS);
    if (result === CHECK_TIMEOUT) {
      logBudgetExceeded(opts.ctx, opts.event, opts.dependency);
      // The probe has already answered, but a hang-type outage must still page:
      // a failure that lands after the budget logs the same critical event.
      inflight.catch((error: unknown) => {
        if (error instanceof InfraConnectivityError) {
          logSubstrateUnreachable(opts, error);
        }
      });
      return "timeout";
    }
    return "ok";
  } catch (error) {
    if (opts.deep) throw error; // explicit deep probe: hard-fail (503)
    if (error instanceof InfraConnectivityError) {
      logSubstrateUnreachable(opts, error);
      return "degraded";
    }
    throw error; // unexpected error type → fall through to default 503 handling
  }
}

function logSubstrateUnreachable(
  opts: { ctx: RequestContext; event: string; dependency: string },
  error: InfraConnectivityError
): void {
  opts.ctx.log.error(
    {
      event: opts.event,
      severity: "critical",
      reason: error.code,
      dependency: opts.dependency,
      message: error.message,
    },
    `readiness: ${opts.dependency} unreachable — MISSION-CRITICAL async substrate down (AI/chat is dispatched through Temporal). Returning ready: probe stays non-fatal so the fleet is not drained; the critical alert + request-time 503 cover it.`
  );
}

/**
 * EVM RPC connectivity. Default path: cached probe bounded by
 * NON_FATAL_CHECK_BUDGET_MS, degraded (never fatal) on failure or timeout.
 * Deep path: forced live read, fatal on failure.
 */
export async function checkEvmRpc(
  ctx: RequestContext,
  container: Container,
  env: Env,
  deep: boolean
): Promise<CheckStatus> {
  const probe = checkEvmRpcConnectivity(container.evmOnchainClient, env, {
    forceLive: deep,
  });
  const evmRpcResult = deep
    ? await probe
    : await withBudget(probe, NON_FATAL_CHECK_BUDGET_MS);
  if (evmRpcResult === CHECK_TIMEOUT) {
    logBudgetExceeded(ctx, "substrate.evm_rpc.unreachable", "evm-rpc");
    return "timeout";
  }
  if (!evmRpcResult.ok) {
    const message = `EVM RPC connectivity check failed: ${evmRpcResult.errorMessage ?? "unknown"}`;
    const context = {
      event: "substrate.evm_rpc.unreachable",
      severity: deep ? "critical" : "degraded",
      reason: "INFRA_UNREACHABLE",
      dependency: "evm-rpc",
      source: evmRpcResult.source,
      message,
    };
    if (deep) {
      ctx.log.error(context, "deep readiness: EVM RPC unreachable");
      throw new InfraConnectivityError(message);
    }
    ctx.log.warn(
      context,
      "readiness: EVM RPC unreachable, returning ready (non-fatal)"
    );
    return "degraded";
  }
  if (deep) {
    ctx.log.info(
      {
        event: "substrate.evm_rpc.reachable",
        dependency: "evm-rpc",
        source: evmRpcResult.source,
      },
      "deep readiness: EVM RPC reachable"
    );
  }
  return evmRpcResult.source === "cached" ? "cached" : "ok";
}

/**
 * Doltgres knowledge-plane reach. Only meaningful when the node declares Doltgres
 * (`DOLTGRES_URL`). A bounded point read on the `max:5` knowledge pool — NOT the
 * work-item/lease path, which reads Postgres. A healthy empty hit returns null.
 */
export async function checkDoltgres(
  container: Container,
  env: Env
): Promise<void> {
  if (!env.DOLTGRES_URL) return; // undeclared; the registry filter also guards this
  const port = container.knowledgeStorePort;
  if (!port) {
    throw new InfraConnectivityError(
      "Doltgres is declared (DOLTGRES_URL set) but the knowledge store is not wired"
    );
  }
  try {
    await port.getKnowledge(DOLTGRES_READYZ_PROBE_ID);
  } catch (error) {
    throw new InfraConnectivityError(
      `Doltgres knowledge plane unreachable: ${error instanceof Error ? error.message : "read failed"}`
    );
  }
}

/**
 * LiteLLM gateway reach. A no-generation live read of the alias catalog
 * (`/model/info`). Uncached and never writes the model cache, so a dead gateway
 * fails immediately instead of being masked by a stale catalog.
 */
export async function checkLiteLlm(env: Env): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${env.LITELLM_BASE_URL}/model/info`, {
      method: "GET",
      headers: { Authorization: `Bearer ${env.LITELLM_MASTER_KEY}` },
      signal: AbortSignal.timeout(DEEP_CHECK_BUDGET_MS),
    });
  } catch (error) {
    throw new InfraConnectivityError(
      `LiteLLM gateway unreachable: ${error instanceof Error ? error.message : "fetch failed"}`
    );
  }
  if (!response.ok) {
    throw new InfraConnectivityError(
      `LiteLLM /model/info returned ${response.status}`
    );
  }
  const body = await response.json().catch(() => null);
  // Accept every shape the canonical catalog reader does (raw array,
  // `{data:[...]}`, or `{models:[...]}`) so a shape the gateway legitimately
  // returns is not a false 503. Source of truth: `transformModelInfoResponse`
  // in app/src/shared/ai/model-catalog.server.ts.
  const modelsList = Array.isArray(body)
    ? body
    : body && typeof body === "object"
      ? ((body as { data?: unknown[]; models?: unknown[] }).data ??
        (body as { data?: unknown[]; models?: unknown[] }).models)
      : undefined;
  if (!Array.isArray(modelsList) || modelsList.length === 0) {
    throw new InfraConnectivityError(
      "LiteLLM /model/info returned no models"
    );
  }
}

/**
 * Redis run-stream reach. Redis is the ephemeral run-event plane the synchronous
 * chat completion subscribes to and awaits, so its loss fails chat — it is
 * serving-critical, not merely degraded. `XLEN` on a fixed key is O(1).
 */
export async function checkRedis(container: Container): Promise<void> {
  try {
    await container.runStream.streamLength(REDIS_READYZ_PROBE_KEY);
  } catch (error) {
    throw new InfraConnectivityError(
      `Redis run-stream unreachable: ${error instanceof Error ? error.message : "stream read failed"}`
    );
  }
}

/** Every substrate dependency this node can declare, probe or justified non-probe. */
type SubstrateName =
  | DeepDependency
  | "tigerbeetle"
  | "langfuse"
  | "openbao-eso"
  | "openfga";

type ProbeRun = (
  ctx: RequestContext,
  container: Container,
  env: Env
) => Promise<unknown>;

/** Fields every entry carries. */
interface SubstrateDependencyBase {
  /** Server-env keys that wire this dependency (drives the env-schema parity guard). */
  envKeys: readonly string[];
  /** Whether this node actually depends on it (config-gate). */
  isDeclared: (env: Env) => boolean;
}

/**
 * A probed dependency. Its `dependency` is typed `DeepDependency` by construction,
 * so only a name that can appear in `unreachable[]` can be a probe — no cast.
 */
interface ProbeDependency extends SubstrateDependencyBase {
  dependency: DeepDependency;
  readyz: { kind: "probe"; run: ProbeRun };
}

/** A declared dependency deliberately NOT probed by deep readyz, with a reason. */
interface NaDependency extends SubstrateDependencyBase {
  dependency: SubstrateName;
  readyz: { kind: "na"; reason: string };
}

type SubstrateDependency = ProbeDependency | NaDependency;

/** Narrow a registry entry to a probe entry (and thus `dependency: DeepDependency`). */
function isProbe(dep: SubstrateDependency): dep is ProbeDependency {
  return dep.readyz.kind === "probe";
}

const always = (): boolean => true;

/**
 * The single source of truth for what deep readiness proves. Probe entries are in
 * deep-registry order; new probes are appended so existing first-failure/order
 * assertions hold. `na` entries record why a declared dependency is not probed.
 */
export const SUBSTRATE_DEPENDENCIES: readonly SubstrateDependency[] = [
  {
    dependency: "evm-rpc",
    envKeys: ["EVM_RPC_URL"],
    isDeclared: always,
    readyz: {
      kind: "probe",
      run: (ctx, container, env) => checkEvmRpc(ctx, container, env, true),
    },
  },
  {
    dependency: "temporal",
    envKeys: ["TEMPORAL_ADDRESS"],
    isDeclared: always,
    readyz: {
      kind: "probe",
      run: (ctx, container, env) =>
        assertSubstrate(
          () => assertTemporalConnectivity(container.scheduleControl, env),
          {
            ctx,
            deep: true,
            event: "substrate.temporal.unreachable",
            dependency: "temporal",
          }
        ),
    },
  },
  {
    dependency: "scheduler-worker",
    envKeys: ["SCHEDULER_WORKER_HEALTH_URL"],
    isDeclared: always,
    readyz: {
      kind: "probe",
      run: (ctx, _container, env) =>
        assertSubstrate(() => assertSchedulerWorkerConnectivity(env), {
          ctx,
          deep: true,
          event: "substrate.scheduler_worker.unreachable",
          dependency: "scheduler-worker",
        }),
    },
  },
  {
    // System tenant billing account (SYSTEM_TENANT_STARTUP_CHECK) is the Postgres verdict.
    dependency: "postgres",
    envKeys: ["DATABASE_URL", "DATABASE_SERVICE_URL"],
    isDeclared: always,
    readyz: {
      kind: "probe",
      run: (_ctx, container) =>
        verifySystemTenant(container.serviceAccountService),
    },
  },
  {
    dependency: "redis",
    envKeys: ["REDIS_URL"],
    isDeclared: always,
    readyz: { kind: "probe", run: (_ctx, container) => checkRedis(container) },
  },
  {
    dependency: "litellm-gateway",
    envKeys: ["LITELLM_BASE_URL"],
    isDeclared: always,
    readyz: { kind: "probe", run: (_ctx, _container, env) => checkLiteLlm(env) },
  },
  {
    dependency: "doltgres",
    envKeys: ["DOLTGRES_URL"],
    isDeclared: (env) => Boolean(env.DOLTGRES_URL),
    readyz: {
      kind: "probe",
      run: (_ctx, container, env) => checkDoltgres(container, env),
    },
  },
  {
    dependency: "tigerbeetle",
    envKeys: ["TIGERBEETLE_ADDRESS"],
    isDeclared: (env) => Boolean(env.TIGERBEETLE_ADDRESS),
    readyz: {
      kind: "na",
      reason:
        "Account/ledger class; proven out-of-band, never from the serving path.",
    },
  },
  {
    dependency: "langfuse",
    envKeys: ["LANGFUSE_BASE_URL"],
    isDeclared: (env) => Boolean(env.LANGFUSE_BASE_URL),
    readyz: {
      kind: "na",
      reason:
        "Observe class; probing telemetry from the serving path makes it a serving dependency.",
    },
  },
  {
    dependency: "openbao-eso",
    envKeys: [],
    isDeclared: always,
    readyz: {
      kind: "na",
      reason: "Secret delivery is already proven by assertRuntimeSecrets.",
    },
  },
  {
    dependency: "openfga",
    envKeys: [],
    isDeclared: () => false,
    readyz: { kind: "na", reason: "Not wired on node-template." },
  },
];

/**
 * Build the deep-path checks for the dependencies this node declares, in registry
 * order. Probe entries use a `DeepDependency` name by construction.
 */
export function buildDeepChecks(
  ctx: RequestContext,
  container: Container,
  env: Env
): ReadonlyArray<readonly [DeepDependency, () => Promise<unknown>]> {
  const checks: Array<readonly [DeepDependency, () => Promise<unknown>]> = [];
  for (const dep of SUBSTRATE_DEPENDENCIES) {
    if (!isProbe(dep) || !dep.isDeclared(env)) continue;
    const run = dep.readyz.run;
    checks.push([dep.dependency, () => run(ctx, container, env)]);
  }
  return checks;
}

/** Substrate env keys look like `*_URL` / `*_ADDRESS`. This is a floor, not a full inventory. */
export const SUBSTRATE_ENV_KEY_PATTERN = /_(URL|ADDRESS)$/;

/** Schema keys that match the pattern but are not substrate dependencies. */
export const NON_SUBSTRATE_ALLOWLIST: readonly string[] = [
  "APP_BASE_URL",
  "LANGGRAPH_DEV_URL",
  "DOLTHUB_REMOTE_URL",
  "PROMETHEUS_REMOTE_WRITE_URL",
  "PROMETHEUS_QUERY_URL",
];

/**
 * Drift guard: given the server-env schema keys, return every substrate-looking
 * key that is neither owned by a `SUBSTRATE_DEPENDENCIES` entry nor allowlisted.
 * A non-empty result means a new dependency was wired without a readyz decision.
 */
export function findUnclassifiedSubstrateKeys(
  schemaKeys: readonly string[]
): string[] {
  const classified = new Set<string>(NON_SUBSTRATE_ALLOWLIST);
  for (const dep of SUBSTRATE_DEPENDENCIES) {
    for (const key of dep.envKeys) classified.add(key);
  }
  return schemaKeys.filter(
    (key) => SUBSTRATE_ENV_KEY_PATTERN.test(key) && !classified.has(key)
  );
}
