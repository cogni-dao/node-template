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
 *   - DENIAL_IS_TERMINAL: `offeredToolIds` drops every tool whose principal lock already fails, so the model is never offered
 *     a tool it cannot use. An exec-time denial (a role revoked mid-run, a failed subject lock) calls `onTerminalDenial`
 *     once so the node ends the run cleanly. A denied run never loops.
 * Side-effects: IO (store reads through `withStore`)
 * @public
 */

import { authorize, principalLockPrecheck } from "./authorize";
import type {
  AdminCheck,
  AuthzDecision,
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
  /** The run id, so a `not_offered` decision can be tied to its run. Logged only. */
  readonly runId?: string | undefined;
}

export interface GuardDeps {
  readonly withStore: WithStore;
  readonly adminCheck: AdminCheck;
  readonly onDecision?: (event: AuthzEvent) => void;
  /** Called once per exec-time denial, before the error is thrown. The node ends the run cleanly (DENIAL_IS_TERMINAL). */
  readonly onTerminalDenial?: (denial: TerminalDenial) => void;
  /** Runs one tool call with the run identity bound (the node's ExecutionScope). */
  readonly runAs?: <T>(identity: RunIdentity, fn: () => Promise<T>) => Promise<T>;
}

export interface TerminalDenial {
  readonly tool: string;
  readonly code: DenialCode;
  readonly reason: string;
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
        if (decision.decision === "deny") {
          deps.onTerminalDenial?.({
            tool: id,
            code: decision.code,
            reason: decision.reason,
          });
          throw new ToolAuthorityError(
            decision.code,
            id,
            requires?.scope ?? null
          );
        }
        return call();
      },
    } as T;
  }
  return guarded;
}

/**
 * Run-start filter (DENIAL_IS_TERMINAL). Returns the tool ids the run may offer the model: a read_only tool with no
 * `requires` always; any other tool only when its PRINCIPAL lock opens now. A tool whose principal lock fails, or whose
 * store check is unavailable, or that has no `requires` entry and an effect other than read_only, is excluded and reported.
 * One store read for the whole run (`liveScopes`), filtered in memory. An `own` scope with no run subject is withheld too,
 * matching `authorize()`'s `no_subject` deny. The rest of the subject lock is not checked here: it can only narrow, and
 * the exec-time guard still enforces it.
 */
export async function offeredToolIds(
  tools: ReadonlyArray<{ readonly id: string; readonly effect: string }>,
  requiresById: Readonly<Record<string, ToolRequires>>,
  scope: GuardScope,
  deps: Pick<GuardDeps, "withStore" | "onDecision">
): Promise<{
  readonly offered: string[];
  readonly excluded: ReadonlyArray<{ tool: string; code: DenialCode; reason: string }>;
}> {
  const verdicts = new Map<string, AuthzDecision>();
  const needStore: Array<{ id: string; scope: string }> = [];
  for (const tool of tools) {
    const requires = requiresById[tool.id];
    if (!requires && tool.effect === "read_only") {
      verdicts.set(tool.id, { decision: "allow", basis: "graph_lock" });
      continue;
    }
    if (!requires) {
      verdicts.set(tool.id, { decision: "deny", code: "policy_denied", reason: "no_requires" });
      continue;
    }
    const early = principalLockPrecheck(scope.principalId, requires);
    if (early) {
      verdicts.set(tool.id, early);
      continue;
    }
    if (requires.kind === "own" && !scope.subjectUserId) {
      verdicts.set(tool.id, { decision: "deny", code: "policy_denied", reason: "no_subject" });
      continue;
    }
    needStore.push({ id: tool.id, scope: requires.scope });
  }
  if (needStore.length > 0 && scope.principalId) {
    const principalId = scope.principalId;
    const scopes = [...new Set(needStore.map((n) => n.scope))];
    let held: Set<string> | null = null;
    try {
      held = new Set(await deps.withStore((store) => store.liveScopes(principalId, scopes)));
    } catch {
      held = null;
    }
    for (const n of needStore)
      verdicts.set(
        n.id,
        held === null
          ? { decision: "deny", code: "authz_unavailable", reason: "store_unavailable" }
          : held.has(n.scope)
            ? { decision: "allow", basis: "role" }
            : { decision: "deny", code: "policy_denied", reason: "no_role" }
      );
  }
  const offered: string[] = [];
  const excluded: Array<{ tool: string; code: DenialCode; reason: string }> = [];
  for (const tool of tools) {
    const decision = verdicts.get(tool.id) as AuthzDecision;
    if (decision.decision === "allow") {
      offered.push(tool.id);
      continue;
    }
    excluded.push({ tool: tool.id, code: decision.code, reason: decision.reason });
    deps.onDecision?.({
      principal: scope.principalId ?? null,
      subject: scope.subjectUserId ?? null,
      payer: scope.payer ?? null,
      tool: tool.id,
      decision: "deny",
      code: decision.code,
      reason: `not_offered:${decision.reason}`,
      runId: scope.runId ?? null,
    });
  }
  return { offered, excluded };
}
