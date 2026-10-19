// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/doltgres-admission/branch-mutation`
 * Purpose: Run an admitted logical write on an isolated Dolt operation branch.
 * Scope: Injected SQL only; callers own admission, deadlines, pool lifecycle and domain idempotence.
 * Invariants: NEVER_REPLAY_UNCERTAIN_CALLBACK, MAIN_ONLY_BY_PROVEN_MERGE, COMMITTED_ACK_SURVIVES_CLEANUP_FAILURE.
 * Side-effects: IO (Dolt branches, commit, merge, cleanup through injected SQL).
 * @public
 */
import { createHash } from "node:crypto";
import {
  assertDoltWriterLock,
  type DoltWriterConnection,
  type DoltWriterLock,
} from "./locks.js";

export class DoltBranchMutationUncertainError extends Error {
  readonly retryable = false;
  readonly name = "DoltBranchMutationUncertainError";
  constructor(
    readonly operationId: string,
    readonly branch: string,
    readonly reason: string,
    readonly commitHash?: string
  ) {
    super(
      `Dolt write ${operationId} requires outcome inspection (${reason}); inspect main and ${branch} before retrying. The callback was not replayed.`
    );
  }
}

export interface DoltBranchMutationOptions<T> {
  readonly guard: DoltWriterLock;
  /** Stable, capability-namespaced operation identity. Domain code owns successful-request idempotence. */
  readonly operationId: string;
  readonly message: string;
  /** Database operations only; use this scoped connection exclusively. */
  readonly run: (connection: DoltWriterConnection) => Promise<T>;
  /** Retire the owned session/pool and log uncertainty; never return it for reuse. */
  readonly onSessionUncertain: (error: unknown) => Promise<void>;
}

export interface DoltBranchMutationResult<T> {
  readonly value: T;
  readonly commitHash: string;
  readonly cleanupUncertain: boolean;
}

function literal(value: string): string {
  if (value.includes("\0"))
    throw new Error("Dolt operation text must not contain NUL");
  return `'${value.replace(/'/g, "''")}'`;
}

function scalar(
  rows: readonly Record<string, unknown>[],
  name: string
): string {
  const value = rows[0]?.[name];
  const raw = Array.isArray(value) ? value[0] : value;
  return raw == null
    ? ""
    : String(raw).replace(/^\{/, "").replace(/\}$/, "").trim();
}

/** A retained operation branch is evidence, never permission to replay its callback. */
export async function runDoltBranchMutation<T>(
  native: DoltWriterConnection,
  options: DoltBranchMutationOptions<T>
): Promise<DoltBranchMutationResult<T>> {
  assertDoltWriterLock(native, options.guard);
  if (
    !options.operationId.trim() ||
    options.operationId.length > 512 ||
    options.operationId.includes("\0")
  )
    throw new Error("Dolt operationId must contain 1–512 non-NUL characters");
  const branch = `dolt-op/${createHash("sha256").update(options.operationId).digest("hex")}`;
  const ref = literal(branch);
  const message = literal(
    `${options.message}\noperation: ${options.operationId}`
  );
  const poison = async (error: unknown) => {
    try {
      await options.onSessionUncertain(error);
    } catch {
      /* preserve the typed mutation receipt */
    }
  };
  let queryFailed = false;
  const execute = async (query: string) => {
    try {
      return await native.unsafe(query);
    } catch (error) {
      queryFailed = true;
      throw error;
    }
  };
  const currentBranch = async () =>
    scalar(
      await execute("SELECT active_branch() AS branch_name"),
      "branch_name"
    );
  const clean = async () =>
    !(await execute("SELECT * FROM dolt.status")).length;
  let created = false;
  let callbackStarted = false;
  let callbackComplete = false;
  let mergeStarted = false;
  let commitHash: string | undefined;
  let value!: T;
  const pending = new Set<Promise<readonly Record<string, unknown>[]>>();
  try {
    const existing = await execute(
      `SELECT name FROM dolt.branches WHERE name = ${ref}`
    );
    if (existing.length)
      throw new DoltBranchMutationUncertainError(
        options.operationId,
        branch,
        "existing_operation_branch"
      );
    if (!(await clean()))
      throw new DoltBranchMutationUncertainError(
        options.operationId,
        branch,
        "current_working_set_is_dirty"
      );
    await execute("SELECT dolt_checkout('main')");
    if ((await currentBranch()) !== "main" || !(await clean()))
      throw new DoltBranchMutationUncertainError(
        options.operationId,
        branch,
        "main_not_clean_or_checkout_unproven"
      );
    created = true; // Creation acknowledgement itself can be lost.
    await execute(`SELECT dolt_checkout('-b', ${ref}, 'main')`);
    if ((await currentBranch()) !== branch)
      throw new DoltBranchMutationUncertainError(
        options.operationId,
        branch,
        "operation_checkout_unproven"
      );

    let open = true;
    const scoped: DoltWriterConnection = {
      unsafe(query) {
        if (!open)
          return Promise.reject(new Error("Dolt write scope has closed"));
        const task = execute(query).finally(() => pending.delete(task));
        pending.add(task);
        return task;
      },
    };
    callbackStarted = true;
    try {
      value = await options.run(scoped);
    } finally {
      open = false;
    }
    if (pending.size || queryFailed) {
      queryFailed = true;
      throw new Error(
        "Dolt write callback returned with unawaited database operations"
      );
    }
    callbackComplete = true;
    const dirty = !(await clean());
    commitHash = dirty
      ? scalar(
          await execute(`SELECT dolt_commit('-Am', ${message})`),
          "dolt_commit"
        )
      : scalar(
          await execute(`SELECT dolt_hashof(${ref}) AS commit_hash`),
          "commit_hash"
        );
    if (!commitHash)
      throw new Error("Dolt operation did not return an immutable commit hash");
    await execute("SELECT dolt_checkout('main')");
    if ((await currentBranch()) !== "main" || !(await clean()))
      throw new Error("Main before merge was not proven clean");
    if (dirty) {
      mergeStarted = true;
      try {
        const merged = await execute(
          `SELECT hash, fast_forward, conflicts, message FROM dolt_merge(${ref})`
        );
        const conflicts = merged[0]?.conflicts;
        if (
          (typeof conflicts !== "number" && typeof conflicts !== "string") ||
          String(conflicts).trim() === "" ||
          !Number.isInteger(Number(conflicts)) ||
          Number(conflicts) < 0
        )
          throw new DoltBranchMutationUncertainError(
            options.operationId,
            branch,
            "merge_result_invalid",
            commitHash
          );
        if (Number(conflicts) !== 0) {
          await execute("SELECT dolt_merge('--abort')");
          throw new DoltBranchMutationUncertainError(
            options.operationId,
            branch,
            "merge_conflict",
            commitHash
          );
        }
      } catch (error) {
        if (error instanceof DoltBranchMutationUncertainError) throw error;
        // A lost acknowledgement can still be positively classified below.
      }
    }
    const ancestor = scalar(
      await execute(
        `SELECT dolt_merge_base('main', ${literal(commitHash)}) AS merge_base`
      ),
      "merge_base"
    );
    if (ancestor !== commitHash)
      throw new DoltBranchMutationUncertainError(
        options.operationId,
        branch,
        "merge_not_proven",
        commitHash
      );
  } catch (error) {
    if (
      created &&
      callbackStarted &&
      !callbackComplete &&
      !queryFailed &&
      !pending.size
    ) {
      // A domain rejection after uncommitted DML: first discard changes ONLY
      // on the positively identified owned branch. Checkout can carry dirty
      // working changes, so never checkout main before this reset/proof.
      try {
        if ((await currentBranch()) !== branch)
          throw new Error("Owned branch is not active");
        await execute("SELECT dolt_reset('--hard', 'HEAD')");
        if ((await currentBranch()) !== branch || !(await clean()))
          throw new Error("Owned branch reset not proven");
        await execute("SELECT dolt_checkout('main')");
        if ((await currentBranch()) !== "main" || !(await clean()))
          throw new Error("Clean main checkout not proven");
        await execute(`SELECT dolt_branch('-D', ${ref})`);
      } catch (cleanupError) {
        await poison(cleanupError);
        throw new DoltBranchMutationUncertainError(
          options.operationId,
          branch,
          "failed_callback_cleanup"
        );
      }
      throw error;
    }
    if (
      !(
        error instanceof DoltBranchMutationUncertainError &&
        error.reason === "existing_operation_branch"
      )
    )
      await poison(error);
    if (error instanceof DoltBranchMutationUncertainError) throw error;
    throw new DoltBranchMutationUncertainError(
      options.operationId,
      branch,
      mergeStarted ? "merge_outcome_unknown" : "write_outcome_unknown",
      commitHash
    );
  }
  let cleanupUncertain = false;
  try {
    await execute(`SELECT dolt_branch('-D', ${ref})`);
  } catch (error) {
    cleanupUncertain = true;
    await poison(error);
  }
  return { value, commitHash, cleanupUncertain };
}
