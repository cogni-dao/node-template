// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/governance/role-signal`
 * Purpose: A malformed grant:role / revoke:role target is refused before the node is asked to write anything.
 * Scope: Role target parser and signal executor with a fake port. No I/O.
 * Side-effects: none
 * Links: src/features/governance/signal-parser.ts, src/features/governance/role-action.ts
 * @public
 */

import { AgentRolesError } from "@cogni/agent-grants";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { executeRoleSignal } from "@/features/governance/role-action";
import { parseRoleTarget } from "@/features/governance/signal-parser";
import type { Signal } from "@/features/governance/signal-types";

const log = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
const signal = (over: Partial<Signal> = {}): Signal => ({
  dao: "0xdao",
  chainId: 8453n,
  vcs: "github",
  repoUrl: "https://github.com/cogni-dao/node-template",
  action: "grant",
  target: "role",
  resource: "work_item:transition",
  nonce: 1n,
  deadline: 0,
  paramsJson: '{"principal":"node-ai"}',
  executor: "0xexec",
  ...over,
});

describe("governance role signal", () => {
  it("parses a well-formed grant and revoke", () => {
    expect(parseRoleTarget(signal())).toEqual({ action: "grant", principalSlug: "node-ai", scope: "work_item:transition" });
    expect(parseRoleTarget(signal({ action: "revoke" }))?.action).toBe("revoke");
  });

  it.each([
    ["merge action on a role target", { action: "merge" as const }],
    ["scope without a colon", { resource: "everything" }],
    ["empty params", { paramsJson: "" }],
    ["params that are not JSON", { paramsJson: "node-ai" }],
    ["no principal", { paramsJson: "{}" }],
    ["an extra key a handler would ignore", { paramsJson: '{"principal":"node-ai","admin":true}' }],
    ["a principal that is not a slug", { paramsJson: '{"principal":"Node AI; DROP"}' }],
  ])("refuses a malformed target: %s", (_name, over) => {
    expect(parseRoleTarget(signal(over))).toBeNull();
  });

  it("never asks the node to write for a malformed target", async () => {
    const applyRole = vi.fn();
    const r = await executeRoleSignal(signal({ paramsJson: "{}" }), "0xtx", { applyRole }, log);
    expect(r).toMatchObject({ success: false, action: "validation_failed" });
    expect(applyRole).not.toHaveBeenCalled();
  });

  it("passes the signal tx hash to the node as the approval reference", async () => {
    const applyRole = vi.fn().mockResolvedValue({ changed: true });
    const r = await executeRoleSignal(signal(), "0xtx", { applyRole }, log);
    expect(applyRole).toHaveBeenCalledWith({ action: "grant", principalSlug: "node-ai", scope: "work_item:transition", signalTx: "0xtx" });
    expect(r).toMatchObject({ success: true, action: "role_granted" });
  });

  it("reports a replay as a successful no-op", async () => {
    const applyRole = vi.fn().mockResolvedValue({ changed: false });
    expect(await executeRoleSignal(signal(), "0xtx", { applyRole }, log)).toMatchObject({ success: true, action: "role_unchanged" });
  });

  it("turns an undeclared scope into a refusal, not an exception", async () => {
    const applyRole = vi.fn().mockRejectedValue(new AgentRolesError("invalid_scope", "scope is not declared"));
    expect(await executeRoleSignal(signal(), "0xtx", { applyRole }, log)).toMatchObject({
      success: false,
      action: "role_refused",
      error: "invalid_scope",
    });
  });

  it("refuses when the node offers no role authority", async () => {
    expect(await executeRoleSignal(signal(), "0xtx", undefined, log)).toMatchObject({ success: false, action: "roles_unavailable" });
  });
});
