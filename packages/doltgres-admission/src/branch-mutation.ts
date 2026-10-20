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
  /** Register an owner-only reconciliation plan; never invoke it before native work settles. */
  readonly onReconcile?: (reconcile: () => Promise<boolean>) => void;
  /** Hand proven success and deferred ref cleanup to the trusted session owner. */
  readonly onCommitted?: (
    result: { readonly value: T; readonly commitHash: string },
    cleanup: () => Promise<void>
  ) => void;
}

export interface DoltBranchMutationResult<T> {
  readonly value: T;
  readonly commitHash: string;
  /** Cleanup failed or was deferred to the trusted session owner. */
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

export interface DoltAbandonedOperationProof {
  readonly guard: DoltWriterLock;
  readonly branch?: string;
  readonly baseHash?: string;
  /** Owning adapter's guarded create-new acknowledgement or equivalent prior-absence/readback proof. */
  readonly creationProven: boolean;
  readonly commitAttempted: boolean;
  readonly mergeAttempted: boolean;
}

/**
 * Reconcile only an already-settled operation on its exact guarded connection.
 * The owning adapter supplies private native evidence; public callbacks cannot
 * manufacture ownership through this function. Never replay or merge intent.
 */
export async function reconcileAbandonedDoltOperation(
  connection: DoltWriterConnection,
  proof: DoltAbandonedOperationProof
): Promise<boolean> {
  assertDoltWriterLock(connection, proof.guard);
  const current = async () =>
    scalar(
      await connection.unsafe("SELECT active_branch() AS branch_name"),
      "branch_name"
    );
  const head = async () =>
    scalar(
      await connection.unsafe("SELECT dolt_hashof('HEAD') AS commit_hash"),
      "commit_hash"
    );
  const clean = async () =>
    !(await connection.unsafe("SELECT * FROM dolt.status")).length;
  const noMergeOrConflicts = async () => {
    const merging = await connection.unsafe(
      "SELECT is_merging FROM dolt.merge_status"
    );
    if (
      merging.length !== 1 ||
      (merging[0]?.is_merging !== false &&
        merging[0]?.is_merging !== "false" &&
        merging[0]?.is_merging !== 0)
    )
      return false;
    return !(await connection.unsafe("SELECT * FROM dolt.conflicts")).length;
  };
  const cleanMain = async () =>
    (await current()) === "main" &&
    (await clean()) &&
    (await noMergeOrConflicts());
  try {
    const active = await current();
    if (active === "main") return await cleanMain();
    const expected = proof.branch;
    if (
      !proof.creationProven ||
      !expected ||
      expected === "main" ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/.test(expected) ||
      expected.includes("..") ||
      active !== expected ||
      !(await noMergeOrConflicts())
    )
      return false;
    if (!(await clean())) {
      if (
        proof.commitAttempted ||
        proof.mergeAttempted ||
        !proof.baseHash ||
        !/^[a-z0-9]{32,64}$/i.test(proof.baseHash) ||
        (await head()) !== proof.baseHash
      )
        return false;
      // The owned branch still has its captured original HEAD. Only its
      // uncommitted changes are discarded; keep the ref as recovery evidence.
      await connection.unsafe("SELECT dolt_reset('--hard', 'HEAD')");
      if (
        (await current()) !== expected ||
        !(await clean()) ||
        !(await noMergeOrConflicts()) ||
        (await head()) !== proof.baseHash
      )
        return false;
    }
    await connection.unsafe("SELECT dolt_checkout('main')");
    return await cleanMain();
  } catch {
    return false;
  }
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
  let creationProven = false;
  let baseHash: string | undefined;
  let commitAttempted = false;
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
    baseHash = scalar(
      await execute("SELECT dolt_hashof('HEAD') AS commit_hash"),
      "commit_hash"
    );
    if (!/^[a-z0-9]{32,64}$/i.test(baseHash))
      throw new Error("Main base HEAD was not proven");
    options.onReconcile?.(async () => {
      assertDoltWriterLock(native, options.guard);
      // A lost caller ACK may still have a positive create-new result. Prior
      // absence + this held guard + exact active ref/base identify our branch.
      let owns = creationProven;
      if (!owns && created && !callbackStarted && baseHash) {
        owns =
          scalar(
            await native.unsafe("SELECT active_branch() AS branch_name"),
            "branch_name"
          ) === branch &&
          scalar(
            await native.unsafe("SELECT dolt_hashof('HEAD') AS commit_hash"),
            "commit_hash"
          ) === baseHash;
      }
      return reconcileAbandonedDoltOperation(native, {
        guard: options.guard,
        branch,
        baseHash,
        creationProven: owns,
        commitAttempted,
        mergeAttempted: mergeStarted,
      });
    });
    created = true; // Creation acknowledgement itself can be lost.
    await execute(`SELECT dolt_checkout('-b', ${ref}, 'main')`);
    if ((await currentBranch()) !== branch)
      throw new DoltBranchMutationUncertainError(
        options.operationId,
        branch,
        "operation_checkout_unproven"
      );
    creationProven = true;

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
    commitAttempted = dirty;
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
  const cleanup = async () => {
    assertDoltWriterLock(native, options.guard);
    try {
      await execute(`SELECT dolt_branch('-D', ${ref})`);
    } catch (error) {
      await poison(error);
      throw error;
    }
  };
  if (options.onCommitted) {
    try {
      options.onCommitted({ value, commitHash }, cleanup);
      return { value, commitHash, cleanupUncertain: true };
    } catch {
      // Notification failed after positive commit proof. Preserve the result
      // and retained ref; never turn observer failure into a replayable write.
      return { value, commitHash, cleanupUncertain: true };
    }
  }
  let cleanupUncertain = false;
  try {
    await cleanup();
  } catch {
    cleanupUncertain = true;
  }
  return { value, commitHash, cleanupUncertain };
}
