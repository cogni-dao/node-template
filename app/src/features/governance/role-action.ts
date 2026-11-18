// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/governance/role-action`
 * Purpose: Execute a passed `grant:role` / `revoke:role` DAO signal: turn one of this node's AI permissions On or Off.
 * Scope: Parses the role target and calls the injected port. Writes nothing itself and needs no VCS credential.
 * Invariants:
 *   - DAO_IS_THE_APPROVER: the approver of the row is the DAO signal (its tx hash rides to the port), never the AI and never a human admin session.
 *   - REPLAY_IS_A_NOOP: the port reports `changed: false` when the row is already in the asked state; that is a success, not an error.
 *   - REFUSAL_IS_TERMINAL: a malformed target, an undeclared scope or an unknown principal is refused with a code and never retried.
 * Side-effects: IO (through the port)
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

import { AgentRolesError } from "@cogni/agent-grants";
import type { Logger } from "pino";

import { parseRoleTarget } from "./signal-parser";
import type { ActionResult, Signal } from "./signal-types";

/** What the node must offer to apply a role signal. Implemented by the node's agent authority. */
export interface RoleSignalPort {
  applyRole(input: {
    action: "grant" | "revoke";
    principalSlug: string;
    scope: string;
    /** The DAO signal that approved this: the transaction hash. */
    signalTx: string;
    /** Chain time of the signal's block, ms since epoch. */
    signalAtMs: number;
  }): Promise<{ changed: boolean; stale?: boolean }>;
}

export async function executeRoleSignal(
  signal: Signal,
  txHash: string,
  signalAtMs: number,
  port: RoleSignalPort | undefined,
  log: Logger
): Promise<ActionResult> {
  const target = parseRoleTarget(signal);
  if (!target) {
    return {
      success: false,
      action: "validation_failed",
      error: "role target must be grant|revoke, a scope in resource and {principal} in params",
    };
  }
  if (!port) {
    return { success: false, action: "roles_unavailable", error: "node agent authority not available" };
  }
  try {
    const { changed, stale } = await port.applyRole({ ...target, signalTx: txHash, signalAtMs });
    log.info({ ...target, signalTx: txHash, changed, stale: stale === true }, "role signal applied");
    const verb = target.action === "grant" ? "granted" : "revoked";
    // A stale signal is a successful no-op: it was seen and is superseded, so it is never retried.
    return { success: true, action: stale ? "role_stale" : changed ? `role_${verb}` : "role_unchanged" };
  } catch (error) {
    if (error instanceof AgentRolesError) {
      log.warn({ ...target, signalTx: txHash, code: error.code }, "role signal refused");
      return { success: false, action: "role_refused", error: error.code };
    }
    throw error;
  }
}
