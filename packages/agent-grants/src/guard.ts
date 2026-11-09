// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/agent-grants/guard`
 * Purpose: Wrap every tool runtime's `exec` so a tool runs only when its locks open.
 * Scope: Structural over the runtime shape (`id`, `effect`, `exec`); never imports `@cogni/ai-core`.
 * Invariants:
 *   - GUARD_COVERS_EVERY_RUNNER_SITE: every `createToolRunner` call site passes its runtimes through here.
 *   - A tool with no `requiresById` entry and any effect other than `read_only` is denied.
 *   - A denial throws an Error carrying `receipt {code, retryable:false, lookup}`; ai-core's runner
 *     returns the fixed message plus that receipt (see `failureReceipt` in ai-core tool-runner).
 *   - The fixed message never names a role, scope or reason. `onDecision` carries the reason.
 *   - `runAs` lets the node bind principal and subject for the duration of the tool call.
 * Side-effects: IO (store reads through `withStore`)
 * @public
 */

import { authorize } from "./authorize";
import type {
  AdminCheck,
  AuthzEvent,
  DenialCode,
  RunIdentity,
  ToolRequires,
  WithStore,
} from "./types";

/** The slice of a bound tool runtime the guard needs. */
export interface GuardableRuntime {
  readonly id: string;
  readonly effect: string;
  exec(args: never, ctx: never, capabilities: never): Promise<unknown>;
}

export interface GuardScope extends RunIdentity {
  /** The billing account charged for the run. Logged only; never an authority. */
  readonly payer?: string | undefined;
}

export interface GuardDeps {
  readonly withStore: WithStore;
  readonly adminCheck: AdminCheck;
  readonly onDecision?: (event: AuthzEvent) => void;
  /** Runs one tool call with the run identity bound (the node's ExecutionScope). */
  readonly runAs?: <T>(identity: RunIdentity, fn: () => Promise<T>) => Promise<T>;
}

const FIXED_MESSAGE: Record<DenialCode, string> = {
  policy_denied: "Tool call denied by policy",
  authz_unavailable: "Tool authorization is unavailable",
};

export class ToolAuthorityError extends Error {
  readonly receipt: {
    readonly code: DenialCode;
    readonly retryable: false;
    readonly lookup: Record<string, string | null>;
  };
  constructor(code: DenialCode, tool: string, scope: string | null) {
    super(FIXED_MESSAGE[code]);
    this.name = "ToolAuthorityError";
    this.receipt = { code, retryable: false, lookup: { tool, scope } };
  }
}

function runIdOf(ctx: unknown): string | null {
  if (typeof ctx === "object" && ctx !== null && "runId" in ctx) {
    const value = (ctx as { runId?: unknown }).runId;
    return typeof value === "string" ? value : null;
  }
  return null;
}

export function guardTools<T extends GuardableRuntime>(
  runtimes: Readonly<Record<string, T>>,
  requiresById: Readonly<Record<string, ToolRequires>>,
  scope: GuardScope,
  deps: GuardDeps
): Record<string, T> {
  const identity: RunIdentity = {
    principalId: scope.principalId,
    subjectUserId: scope.subjectUserId,
  };
  const guarded: Record<string, T> = {};
  for (const [id, runtime] of Object.entries(runtimes)) {
    const requires = requiresById[id];
    const scoped = requires !== undefined || runtime.effect !== "read_only";
    const inner = runtime.exec.bind(runtime) as (
      ...a: unknown[]
    ) => Promise<unknown>;
    guarded[id] = {
      ...runtime,
      exec: async (args: unknown, ctx: unknown, caps: unknown) => {
        const call = () =>
          deps.runAs
            ? deps.runAs(identity, () => inner(args, ctx, caps))
            : inner(args, ctx, caps);
        if (!scoped) return call();

        // No principal: deny without touching the store (also keeps the dev runner storeless).
        const decision = !identity.principalId
          ? ({
              decision: "deny",
              code: "policy_denied",
              reason: "no_principal",
            } as const)
          : requires
          ? await deps
              .withStore((store) =>
                authorize(store, deps.adminCheck, {
                  ...identity,
                  requires,
                })
              )
              .catch(
                () =>
                  ({
                    decision: "deny",
                    code: "authz_unavailable",
                    reason: "store_unavailable",
                  }) as const
              )
          : ({
              decision: "deny",
              code: "policy_denied",
              reason: "no_requires",
            } as const);

        deps.onDecision?.({
          principal: identity.principalId ?? null,
          subject: identity.subjectUserId ?? null,
          payer: scope.payer ?? null,
          tool: id,
          decision: decision.decision,
          code: decision.decision === "allow" ? "allowed" : decision.code,
          reason: decision.decision === "allow" ? decision.basis : decision.reason,
          runId: runIdOf(ctx),
        });
        if (decision.decision === "deny")
          throw new ToolAuthorityError(
            decision.code,
            id,
            requires?.scope ?? null
          );
        return call();
      },
    } as T;
  }
  return guarded;
}
