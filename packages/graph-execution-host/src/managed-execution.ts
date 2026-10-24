// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `@cogni-dao/graph-execution/managed-execution`
 * Purpose: Canonical run-result admission and post-commit presentation policy.
 * Scope: Injected persistence/stream ports; no database, model, environment or scheduler.
 * Invariants: immutable bounded result; duplicate admission removes the proposal; provisional text is never terminal truth.
 * Side-effects: injected presentation callbacks only.
 * Links: https://cognidao.org/work/items/task.5340
 * @public
 */
export interface ExecutionAudience {
  readonly actorUserId: string;
  readonly billingAccountId: string;
  readonly graphId: string;
  readonly executionGrantId: string | null;
}
export interface CanonicalRunResult {
  readonly version: 1;
  readonly audience: ExecutionAudience;
  readonly runId: string;
  readonly traceId: string | null;
  readonly stateKey?: string;
  readonly ok: boolean;
  readonly errorCode?: string;
  readonly structuredOutput?: unknown;
}
export interface ManagedExecutionBinding {
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly runId: string;
  readonly audience: ExecutionAudience;
}
export interface ManagedExecutionClaim {
  readonly binding: ManagedExecutionBinding;
  readonly graphRunId: string;
  readonly token: string;
}
export type ManagedAcquireResult =
  | { readonly status: "claimed"; readonly claim: ManagedExecutionClaim }
  | { readonly status: "cached"; readonly result: CanonicalRunResult }
  | { readonly status: "pending" | "mismatch" | "unavailable" | "denied" };
export type ManagedCommitResult =
  | {
      readonly status: "committed" | "cached";
      readonly result: CanonicalRunResult;
    }
  | { readonly status: "stale" };
/** Transaction callback must be synchronous, deterministic, bounded and free of I/O. */
export interface ManagedExecutionPort {
  acquire(
    binding: ManagedExecutionBinding,
    leaseMs: number,
  ): Promise<ManagedAcquireResult>;
  heartbeat(claim: ManagedExecutionClaim, leaseMs: number): Promise<boolean>;
  commit(
    claim: ManagedExecutionClaim,
    input: {
      readonly acceptedInputKey?: string;
      readonly resolve: (prior?: CanonicalRunResult) => CanonicalRunResult;
    },
  ): Promise<ManagedCommitResult>;
  readOwnedResult(
    runId: string,
    actorUserId: string,
  ): Promise<CanonicalRunResult | null>;
}
/** Canonical JSON avoids JSONB key-order differences during replay and presentation checks. */
export function canonicalJson(value: unknown): string {
  const text = JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
  if (text === undefined) throw new Error("result_unavailable");
  return text;
}
export const MAX_CANONICAL_RESULT_BYTES = 32_768;
export function sameExecutionAudience(
  a: ExecutionAudience,
  b: ExecutionAudience,
): boolean {
  return (
    a.actorUserId === b.actorUserId &&
    a.billingAccountId === b.billingAccountId &&
    a.graphId === b.graphId &&
    a.executionGrantId === b.executionGrantId
  );
}
/** Validate the storage wrapper without making assertions about the program payload schema. */
export function readCanonicalResult(value: unknown): CanonicalRunResult {
  if (!value || typeof value !== "object")
    throw new Error("result_unavailable");
  const r = value as Partial<CanonicalRunResult>;
  if (
    r.version !== 1 ||
    typeof r.runId !== "string" ||
    typeof r.ok !== "boolean" ||
    !(r.traceId === null || typeof r.traceId === "string") ||
    !r.audience ||
    typeof r.audience.actorUserId !== "string" ||
    typeof r.audience.billingAccountId !== "string" ||
    typeof r.audience.graphId !== "string" ||
    !(
      r.audience.executionGrantId === null ||
      typeof r.audience.executionGrantId === "string"
    )
  )
    throw new Error("result_unavailable");
  const text = canonicalJson(value);
  if (new TextEncoder().encode(text).byteLength > MAX_CANONICAL_RESULT_BYTES)
    throw new Error("result_too_large");
  return JSON.parse(text) as CanonicalRunResult;
}
/** Called inside the node-owned admission transaction, after trusted schema validation. */
export function canonicalTerminal(
  candidate: CanonicalRunResult,
  prior: CanonicalRunResult | undefined,
  hash: (text: string) => string,
): CanonicalRunResult {
  let result = readCanonicalResult(candidate);
  if (prior) {
    const existing = readCanonicalResult(prior);
    if (!sameExecutionAudience(existing.audience, result.audience))
      throw new Error("result_audience_mismatch");
    if (
      !existing.ok ||
      !existing.structuredOutput ||
      typeof existing.structuredOutput !== "object" ||
      (existing.structuredOutput as { status?: unknown }).status !== "accepted"
    )
      throw new Error("invalid_prior_result");
    if (
      !result.ok ||
      !result.structuredOutput ||
      typeof result.structuredOutput !== "object"
    )
      throw new Error("invalid_duplicate_candidate");
    const output = result.structuredOutput as Record<string, unknown>;
    if (output.status !== "accepted")
      throw new Error("invalid_duplicate_candidate");
    const { proposal: _proposal, ...rest } = output;
    result = readCanonicalResult({
      ...result,
      structuredOutput: {
        ...rest,
        status: "no_op",
        reason: "unchanged_input",
        priorResult: {
          runId: existing.runId,
          sha256: hash(canonicalJson(existing)),
        },
      },
    });
  }
  return result;
}
export function shouldWithholdResultEvent(type: string): boolean {
  return type === "text_delta" || type === "assistant_final" || type === "done";
}
/** This function receives only a committed/replayed result; it cannot change execution state. */
export async function publishCanonicalTerminal(
  result: CanonicalRunResult,
  deps: {
    readonly persist: (text: string) => Promise<void>;
    readonly publish: (
      event:
        | { type: "text_delta"; delta: string }
        | { type: "assistant_final"; content: string }
        | { type: "done" },
    ) => Promise<void>;
  },
): Promise<void> {
  if (!result.ok) return;
  const text = canonicalJson(result.structuredOutput);
  if (text === undefined) throw new Error("result_unavailable");
  await deps.persist(text);
  await deps.publish({ type: "text_delta", delta: text });
  await deps.publish({ type: "assistant_final", content: text });
  await deps.publish({ type: "done" });
}

/**
 * Drain/account first, then admit one canonical result. Publication failure is
 * delivery-only and never invokes a second execution finalization.
 */
export async function completeManagedGraph(input: {
  readonly run: import("@cogni/graph-execution-core").GraphRunResult;
  readonly claim: ManagedExecutionClaim;
  readonly port: Pick<ManagedExecutionPort, "commit">;
  readonly traceId: string | null;
  readonly stateKey?: string;
  readonly scope: {
    readonly nodeId: string;
    readonly environment: string;
    readonly scheduleId: string | null;
  };
  readonly parseResult: (output: unknown) => Record<string, unknown>;
  readonly hash: (text: string) => string;
  readonly persist: (text: string) => Promise<void>;
  readonly publish: (event: import("@cogni/ai-core").AiEvent) => Promise<void>;
  readonly onDeliveryError: (error: unknown) => void;
}): Promise<ManagedCommitResult> {
  let candidate: CanonicalRunResult;
  let acceptedInputKey: string | undefined;
  try {
    for await (const event of input.run.stream) {
      if (!shouldWithholdResultEvent(event.type) && event.type !== "error") {
        try {
          await input.publish(event);
        } catch (error) {
          input.onDeliveryError(error);
        }
      }
    }
    const final = await input.run.final;
    let output: Record<string, unknown> | undefined;
    if (final.ok) {
      output = input.parseResult(final.structuredOutput);
      if (output.status === "accepted") {
        const identity = final.inputIdentity;
        if (
          !identity ||
          !/^[a-f0-9]{64}$/.test(identity.digest) ||
          !identity.policyVersion ||
          identity.policyVersion.length > 128
        ) {
          const { proposal: _proposal, ...rest } = output;
          output = input.parseResult({
            ...rest,
            status: "incomplete",
            reason: "input_identity_missing",
          });
        } else {
          acceptedInputKey = input.hash(
            canonicalJson({
              scope: input.scope,
              audience: input.claim.binding.audience,
              inputIdentity: identity,
            }),
          );
        }
      }
    }
    candidate = readCanonicalResult({
      version: 1,
      audience: input.claim.binding.audience,
      runId: input.claim.binding.runId,
      traceId: input.traceId,
      ...(input.stateKey ? { stateKey: input.stateKey } : {}),
      ok: final.ok,
      ...(final.error ? { errorCode: final.error } : {}),
      ...(output ? { structuredOutput: output } : {}),
    });
  } catch {
    acceptedInputKey = undefined;
    // Resolve an already-settled failure without losing a rejection from final.
    await input.run.final.catch(() => undefined);
    candidate = {
      version: 1,
      audience: input.claim.binding.audience,
      runId: input.claim.binding.runId,
      traceId: input.traceId,
      ok: false,
      errorCode: "internal",
    };
  }
  const committed = await input.port.commit(input.claim, {
    ...(acceptedInputKey ? { acceptedInputKey } : {}),
    resolve: (prior) => {
      const canonical = canonicalTerminal(candidate, prior, input.hash);
      // Admission can turn accepted into no_op. The program validates that shape too.
      if (canonical.ok) input.parseResult(canonical.structuredOutput);
      return canonical;
    },
  });
  if (committed.status === "stale") return committed;
  try {
    if (committed.result.ok)
      await publishCanonicalTerminal(committed.result, input);
    else {
      await input.publish({ type: "error", error: "internal" });
      await input.publish({ type: "done" });
    }
  } catch (error) {
    input.onDeliveryError(error);
  }
  return committed;
}
