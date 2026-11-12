// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/substrate-health`
 * Purpose: The node-neutral deep-readiness mechanism every Cogni node's `/readyz?deep=1` is built from.
 * Scope: Owns the concurrent bounded deep runner (`runDeepChecks`), its failure type (`DeepProbeFailure`),
 *   the three reach-probe factories (Redis stream, knowledge plane, LiteLLM gateway), the declared-dependency
 *   type (`SubstrateDependency`), the env-schema drift guard (`findUnclassifiedSubstrateKeys`), the deep HTTP
 *   body contract (`DeepReadyzEvidence`) and its one reader (`readDeepReadiness`), and the whole `/readyz`
 *   response (`serveReadyz`): a local-only default path and the registry-driven deep path. It owns no node
 *   identity: a node injects its logger, error type, budget, ports and declaration map.
 * Invariants:
 *   - Leaf package: no app, container, env-loader or framework imports. Everything node-specific is injected.
 *   - A probe factory calls its port AS A METHOD (`port.streamLength(key)`), so a class method keeps `this`.
 *     Never destructure the method off the port.
 *   - `runDeepChecks` runs every check concurrently under one per-check budget, emits ONE per-dependency
 *     summary via the injected `log`, and throws `DeepProbeFailure` when any check fails. The first failure in
 *     `checks` order is `primary`; `unreachable[]` preserves that order.
 *   - A deep body (200 and 503) carries the `checks` map and the responder's `buildSha`, so a reader judges one
 *     named dependency at one named revision from the subject itself. `readDeepReadiness` is the only parser:
 *     a dependency is `reached` only on positive `checks[name].status === "ok"` evidence; a body without
 *     `checks` is `unknown`, never green.
 *   - `serveReadyz` default path (the kubelet probe) makes ZERO remote calls: it runs only the node's local
 *     config/secret assertion. Remote dependencies are proven only by `?deep=1`, so a slow or down shared
 *     substrate can neither delay nor drain the serving fleet.
 * Side-effects: none in this module; injected probes do IO when run.
 * Links: fleet-reliability-substrate-matrix, node-substrate-health-checklist, deep-readyz-design
 * @public
 */

/** A deep probe failed: carries the first failure (for reason/message) and every failing dependency, in order. */
export class DeepProbeFailure extends Error {
  constructor(
    readonly primary: unknown,
    readonly unreachable: readonly string[],
    readonly checks: DeepChecks = {}
  ) {
    super("deep readiness failed");
    this.name = "DeepProbeFailure";
  }
}

/** One probed dependency's outcome in the deep `checks` map. */
export interface DeepCheckResult {
  status: "ok" | "failed";
  durationMs: number;
}

/** The deep `checks` map: every probed dependency, keyed by its probe name. */
export type DeepChecks = Readonly<Record<string, DeepCheckResult>>;

/** A node injects its logger, its error type and the per-check budget. */
export interface DeepRuntime {
  /** Emit the one per-dependency summary (a node maps this to its structured logger). */
  log: (fields: Record<string, unknown>, message: string) => void;
  /** Build the node's connectivity error for a check that exceeds its budget. */
  timeoutError: (dependency: string, budgetMs: number) => unknown;
  /** Per-check deadline in ms. */
  budgetMs: number;
}

const CHECK_TIMEOUT = Symbol("substrate-health.check_timeout");

/**
 * Race `promise` against a budget. The underlying work keeps running, but the
 * caller stops waiting for it. Internal: a node keeps its own copy for any
 * non-deep path.
 */
async function withBudget<T>(
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

type DeepCheckOutcome<Name extends string> = {
  dependency: Name;
  durationMs: number;
  error?: unknown;
};

/**
 * Deep path: run every declared dependency check at once, each under its own
 * deadline, and report every failure. Emits ONE structured summary naming each
 * probed dependency, its status and its duration — the per-dependency
 * observability a readiness probe must have. The summary fires on both the
 * all-pass path and before a failure. Throws `DeepProbeFailure` when any check
 * fails; the first failure in `checks` order is `primary`, and `unreachable[]`
 * preserves that order. Resolves with (and the failure carries) the `checks`
 * map the node puts in its deep HTTP body.
 */
export async function runDeepChecks<Name extends string>(
  checks: ReadonlyArray<readonly [Name, () => Promise<unknown>]>,
  runtime: DeepRuntime
): Promise<DeepChecks> {
  const startedAt = Date.now();
  const outcomes = await Promise.all(
    checks.map(async ([dependency, run]): Promise<DeepCheckOutcome<Name>> => {
      const checkStartedAt = Date.now();
      try {
        const result = await withBudget(
          Promise.resolve().then(run),
          runtime.budgetMs
        );
        if (result === CHECK_TIMEOUT) {
          return {
            dependency,
            durationMs: Date.now() - checkStartedAt,
            error: runtime.timeoutError(dependency, runtime.budgetMs),
          };
        }
        return { dependency, durationMs: Date.now() - checkStartedAt };
      } catch (error) {
        return { dependency, durationMs: Date.now() - checkStartedAt, error };
      }
    })
  );

  const checksSummary: Record<string, DeepCheckResult> = {};
  const unreachable: Name[] = [];
  let primary: unknown;
  for (const outcome of outcomes) {
    const failed = outcome.error !== undefined;
    checksSummary[outcome.dependency] = {
      status: failed ? "failed" : "ok",
      durationMs: outcome.durationMs,
    };
    if (failed) {
      if (unreachable.length === 0) primary = outcome.error;
      unreachable.push(outcome.dependency);
    }
  }

  runtime.log(
    {
      event: "substrate.deep.complete",
      checks: checksSummary,
      durationMs: Date.now() - startedAt,
      unreachable,
    },
    "deep readiness: checks complete"
  );

  if (unreachable.length > 0)
    throw new DeepProbeFailure(primary, unreachable, checksSummary);
  return checksSummary;
}

/**
 * The deep-readiness fields a node adds to its `/readyz?deep=1` body. A 200 adds
 * `checks`; a deep 503 adds `checks`, `unreachable` and `buildSha`. A config 503
 * (env, secrets) returns before any check and carries none of them.
 */
export interface DeepReadyzEvidence {
  checks: DeepChecks;
  unreachable?: readonly string[];
  buildSha?: string;
}

/**
 * How one deep body judges one dependency. `na` = the responder attributed its
 * checks and did not probe that name. `unknown` = no attributable evidence.
 */
export type DependencyState = "reached" | "unreached" | "na" | "unknown";

/** One deep response read once: the responder's revision and a per-dependency verdict. */
export interface DeepReadiness {
  /** The revision the responder reports in its own body, if any. */
  buildSha: string | undefined;
  /** The aggregate verdict: a 200 with `status: "healthy"` (every declared check passed). */
  healthy: boolean;
  dependencyState(dependency: string): DependencyState;
}

function isCheckResult(value: unknown): value is DeepCheckResult {
  return (
    typeof value === "object" &&
    value !== null &&
    ((value as { status?: unknown }).status === "ok" ||
      (value as { status?: unknown }).status === "failed")
  );
}

/**
 * The one reader of a `/readyz?deep=1` response. Takes the HTTP status and the
 * parsed JSON body (or anything; malformed input reads as unknown).
 *
 * - With a `checks` map (0.2.0+ producers): `ok` → reached, `failed` →
 *   unreached, absent → na. A 200 that lists a failed check is inconsistent and
 *   reads as unknown.
 * - Without `checks` (older producers): a 503 that names a dependency in
 *   `unreachable[]` → unreached; everything else is unknown. An aggregate 200
 *   is never positive evidence about any one dependency.
 * - Any other status → unknown.
 */
export function readDeepReadiness(status: number, body: unknown): DeepReadiness {
  const record =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const buildSha =
    typeof record.buildSha === "string" && record.buildSha.length > 0
      ? record.buildSha
      : undefined;
  const rawChecks = record.checks;
  const checks =
    typeof rawChecks === "object" &&
    rawChecks !== null &&
    !Array.isArray(rawChecks) &&
    Object.values(rawChecks).every(isCheckResult)
      ? (rawChecks as DeepChecks)
      : undefined;
  const unreachable =
    Array.isArray(record.unreachable) &&
    record.unreachable.every((name) => typeof name === "string")
      ? (record.unreachable as string[])
      : undefined;
  const answered =
    (status === 200 && record.status === "healthy") ||
    (status === 503 && record.status === "error");

  return {
    buildSha,
    healthy: status === 200 && record.status === "healthy",
    dependencyState(dependency) {
      if (!answered) return "unknown";
      if (checks) {
        const check = Object.hasOwn(checks, dependency)
          ? checks[dependency]
          : undefined;
        if (!check) return "na";
        if (check.status === "ok") return "reached";
        return status === 503 ? "unreached" : "unknown";
      }
      if (status === 503 && unreachable?.includes(dependency))
        return "unreached";
      return "unknown";
    },
  };
}

/** Injected into every probe factory so the node's own connectivity error is thrown. */
export interface ProbeOptions {
  /** Wrap a reason string in the node's connectivity error type. */
  wrapError: (message: string) => Error;
}

/** A port that can report a stream length (e.g. a Redis run-stream adapter). */
export interface StreamLengthPort {
  streamLength(key: string): Promise<number>;
}

/** A port that can point-read a knowledge row (e.g. a Doltgres knowledge store). */
export interface KnowledgeReachPort {
  getKnowledge(id: string): Promise<unknown>;
}

/**
 * Redis run-stream reach. `XLEN` on a fixed key is O(1); a missing key returns 0.
 * Takes the PORT OBJECT and calls `streamLength` as a method, so a class
 * implementation keeps `this`.
 */
export function probeRedisStream(
  port: StreamLengthPort,
  key: string,
  opts: ProbeOptions
): () => Promise<void> {
  return async () => {
    try {
      await port.streamLength(key);
    } catch (error) {
      throw opts.wrapError(
        `Redis run-stream unreachable: ${error instanceof Error ? error.message : "stream read failed"}`
      );
    }
  };
}

/**
 * Knowledge-plane reach. A bounded point read; a healthy empty hit returns null,
 * a dead plane throws. Takes the PORT OBJECT and calls `getKnowledge` as a method.
 */
export function probeKnowledgePlane(
  port: KnowledgeReachPort,
  id: string,
  opts: ProbeOptions
): () => Promise<void> {
  return async () => {
    try {
      await port.getKnowledge(id);
    } catch (error) {
      throw opts.wrapError(
        `Knowledge plane unreachable: ${error instanceof Error ? error.message : "read failed"}`
      );
    }
  };
}

/**
 * LiteLLM gateway reach. A no-generation live read of the alias catalog
 * (`/model/info`). Uncached and never writes any model cache, so a dead gateway
 * fails immediately instead of being masked by a stale catalog. Accepts every
 * catalog shape a gateway legitimately returns (raw array, `{data:[]}`,
 * `{models:[]}`) so a valid shape is not a false failure.
 */
export function probeLiteLlmGateway(
  cfg: { baseUrl: string; apiKey: string; budgetMs: number },
  opts: ProbeOptions
): () => Promise<void> {
  return async () => {
    let response: Response;
    try {
      response = await fetch(`${cfg.baseUrl}/model/info`, {
        method: "GET",
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        signal: AbortSignal.timeout(cfg.budgetMs),
      });
    } catch (error) {
      throw opts.wrapError(
        `LiteLLM gateway unreachable: ${error instanceof Error ? error.message : "fetch failed"}`
      );
    }
    if (!response.ok) {
      throw opts.wrapError(`LiteLLM /model/info returned ${response.status}`);
    }
    const body: unknown = await response.json().catch(() => null);
    const modelsList = Array.isArray(body)
      ? body
      : body && typeof body === "object"
        ? ((body as { data?: unknown[]; models?: unknown[] }).data ??
          (body as { data?: unknown[]; models?: unknown[] }).models)
        : undefined;
    if (!Array.isArray(modelsList) || modelsList.length === 0) {
      throw opts.wrapError("LiteLLM /model/info returned no models");
    }
  };
}

/** Fields every declared-dependency entry carries. `Env` is the node's parsed env type. */
export interface SubstrateDependencyBase<Env> {
  /** Env keys that wire this dependency (drives the env-schema drift guard). */
  envKeys: readonly string[];
  /** Whether this node actually depends on it (config-gate). */
  isDeclared: (env: Env) => boolean;
}

/**
 * A probed dependency. `dependency` is typed to the node's probe-name union, so
 * only a name that can appear in `unreachable[]` can be a probe. `Run` is the
 * node's probe closure signature.
 */
export interface ProbeDependency<Env, ProbeName extends string, Run>
  extends SubstrateDependencyBase<Env> {
  dependency: ProbeName;
  readyz: { kind: "probe"; run: Run };
}

/** A declared dependency deliberately NOT probed by deep readyz, with a reason. */
export interface NaDependency<Env, Name extends string>
  extends SubstrateDependencyBase<Env> {
  dependency: Name;
  readyz: { kind: "na"; reason: string };
}

/** One declaration-map entry: a probe (reach-tested) or a justified non-probe. */
export type SubstrateDependency<
  Env,
  ProbeName extends string,
  NaName extends string,
  Run,
> = ProbeDependency<Env, ProbeName, Run> | NaDependency<Env, NaName>;

/** Substrate env keys look like `*_URL` / `*_ADDRESS`. This is a floor, not a full inventory. */
export const SUBSTRATE_ENV_KEY_PATTERN = /_(URL|ADDRESS)$/;

/**
 * Drift guard: given the env-schema keys, return every substrate-looking key that
 * is neither classified (owned by a declaration-map entry) nor allowlisted. A
 * non-empty result means a dependency was wired without a readiness decision.
 * A node passes its map's `envKeys` as `classifiedKeys` and its non-substrate
 * allowlist.
 */
export function findUnclassifiedSubstrateKeys(
  schemaKeys: readonly string[],
  opts: {
    classifiedKeys: readonly string[];
    allowlist: readonly string[];
    pattern?: RegExp;
  }
): string[] {
  const pattern = opts.pattern ?? SUBSTRATE_ENV_KEY_PATTERN;
  const classified = new Set<string>([...opts.classifiedKeys, ...opts.allowlist]);
  return schemaKeys.filter((key) => pattern.test(key) && !classified.has(key));
}

/** What a node's `/readyz` route returns: an HTTP status and a JSON body. Framework-free. */
export interface ReadyzResponse {
  status: 200 | 503;
  body: Record<string, unknown>;
}

/** A node's error vocabulary, mapped to the readyz 503 body fields. */
export interface ReadyzErrorDescription {
  reason: string;
  message?: string;
  details?: unknown;
}

/** Everything node-specific `serveReadyz` needs. Nothing here may do remote IO except `deepChecks`. */
export interface ServeReadyzOptions<Name extends string> {
  /** `?deep=1` was requested. */
  deep: boolean;
  /**
   * Local serving readiness: parse env, assert runtime secrets and config. Throws on misconfiguration.
   * MUST NOT do remote IO. Returns the identity the body reports.
   */
  local: () => { buildSha?: string | undefined; version?: string | undefined };
  /** The node's declared deep checks, built only when `deep` (so the container is touched only then). */
  deepChecks: () => ReadonlyArray<readonly [Name, () => Promise<unknown>]>;
  /** Logger, connectivity error and per-check budget for the deep runner. */
  runtime: DeepRuntime;
  /** Map a thrown error (config error or the first deep failure) to the 503 body fields. */
  describeError: (error: unknown) => ReadyzErrorDescription;
  /** Log a failure before the 503 is returned. */
  onFailure?: (error: unknown) => void;
}

/**
 * The whole `/readyz` contract, shared by every node and the operator.
 *
 * - Default path: `local()` only. No remote IO, so it answers in milliseconds and a shared-substrate
 *   outage cannot drain the fleet. 200 `{status:"healthy", timestamp, version?, buildSha?}`.
 * - `?deep=1`: also runs every declared check concurrently (`runDeepChecks`). 200 adds `checks`;
 *   a failure is 503 with `reason`/`message` from the first failure plus `unreachable`, `checks` and
 *   `buildSha` (`DeepReadyzEvidence`).
 * - A local failure (config, secrets) is 503 with `reason`/`message`/`details` and no deep evidence.
 */
export async function serveReadyz<Name extends string>(
  opts: ServeReadyzOptions<Name>
): Promise<ReadyzResponse> {
  let identity: { buildSha?: string | undefined; version?: string | undefined } = {};
  try {
    identity = opts.local();
    let checks: DeepChecks | undefined;
    if (opts.deep) {
      checks = await runDeepChecks(opts.deepChecks(), opts.runtime);
    }
    return {
      status: 200,
      body: {
        status: "healthy",
        timestamp: new Date().toISOString(),
        ...(identity.version ? { version: identity.version } : {}),
        ...(identity.buildSha ? { buildSha: identity.buildSha } : {}),
        ...(checks ? { checks } : {}),
      },
    };
  } catch (caught) {
    const error = caught instanceof DeepProbeFailure ? caught.primary : caught;
    opts.onFailure?.(error);
    const described = opts.describeError(error);
    return {
      status: 503,
      body: {
        status: "error",
        reason: described.reason,
        ...(described.message !== undefined ? { message: described.message } : {}),
        ...(described.details !== undefined ? { details: described.details } : {}),
        ...(caught instanceof DeepProbeFailure
          ? {
              unreachable: caught.unreachable,
              checks: caught.checks,
              ...(identity.buildSha ? { buildSha: identity.buildSha } : {}),
            }
          : {}),
      },
    };
  }
}
