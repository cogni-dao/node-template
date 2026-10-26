// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Shared completion identity and non-leased reservation policy.
 * Host validates payloads and injects credentials/ports; no auth, env or lifecycle.
 * Preserve existing canonical bytes and named conflicts across node consumers.
 * Links: graph-execution-package-design D9, task.5340.
 */
import { createHash, createHmac } from "node:crypto";

export interface CompletionRequestPayload {
  readonly graphId: string;
  readonly messages: readonly unknown[];
  readonly modelRef: unknown;
  readonly stateKey?: string;
}

/** Existing global reservation scope; trusted identity segments are host-owned. */
export function scopeExecutionIdempotencyKey(
  nodeId: string,
  billingAccountId: string,
  actorUserId: string,
  callerKey: string
): string {
  return `ai:${createHash("sha256")
    .update(`${nodeId}:${billingAccountId}:${actorUserId}:${callerKey}`, "utf8")
    .digest("hex")}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

export function completionRequestHash(
  input: CompletionRequestPayload,
  key: string
): string {
  return createHmac("sha256", key)
    .update("completion-request:v1\0", "utf8")
    .update(
      JSON.stringify(
        canonicalize({
          graphId: input.graphId,
          messages: input.messages,
          modelRef: input.modelRef,
          stateKey: input.stateKey ?? null,
        })
      ),
      "utf8"
    )
    .digest("hex");
}

export type CompletionReservationCheck =
  | { readonly status: "new" }
  | { readonly status: "mismatch" }
  | {
      readonly status: "pending" | "stale" | "cached";
      readonly request: { readonly runId: string };
    };

/** Minimal structural projection: no scheduler or database dependencies. */
export interface CompletionReservationPort {
  checkIdempotency(
    key: string,
    requestHash: string
  ): Promise<CompletionReservationCheck>;
  createPendingRequest(
    key: string,
    requestHash: string,
    runId: string,
    traceId: string | null
  ): Promise<unknown>;
}

export class CompletionIdempotencyConflictError extends Error {
  readonly code = "COMPLETION_IDEMPOTENCY_CONFLICT" as const;
  constructor() {
    super(
      "Idempotency key was already used for a different completion request"
    );
    this.name = "CompletionIdempotencyConflictError";
  }
}

/** Reserve before Temporal start; receiver alone acquires the execution lease. */
export async function reserveCompletionRequest(
  input: {
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly runId: string;
    readonly traceId: string | null;
  },
  port: CompletionReservationPort
): Promise<void> {
  const { idempotencyKey, requestHash, runId, traceId } = input;
  let idempotency = await port.checkIdempotency(idempotencyKey, requestHash);
  if (idempotency.status === "new") {
    let createError: unknown;
    try {
      await port.createPendingRequest(
        idempotencyKey,
        requestHash,
        runId,
        traceId
      );
    } catch (error) {
      createError = error;
    }
    // A concurrent insert can win even when our create throws. Re-read truth.
    idempotency = await port.checkIdempotency(idempotencyKey, requestHash);
    if (idempotency.status === "new") {
      throw (
        createError ??
        new Error("Execution idempotency claim was not persisted")
      );
    }
  }
  if (
    idempotency.status === "mismatch" ||
    idempotency.request.runId !== runId
  ) {
    throw new CompletionIdempotencyConflictError();
  }
}
