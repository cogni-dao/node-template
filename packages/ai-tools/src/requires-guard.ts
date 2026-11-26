// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools` (src/requires-guard.ts)
 * Purpose: The tool-contract `requires` guard as pure functions a node's CI runs over its own composed bundle, so a node tool that changes state without
 *   naming its scope fails in the node's pipeline, not only in this package's.
 * Scope: Plain `{ name, effect, requires }` records; no tool runs. A lint, not proof of authority.
 * Invariants: SCOPED_TOOL_NEEDS_PRINCIPAL is only enforceable if each state-changing tool names its scope. A read_only tool declares `requires` only for an account read.
 * Side-effects: none
 * @public
 */

import type { ToolContract } from "./types";

type GuardedContract = Pick<ToolContract<string, unknown, unknown, unknown>, "name" | "effect" | "requires">;

/** The tools that change state (or reach outside) and declare no `requires`. @beta */
export function contractsMissingRequires(contracts: readonly GuardedContract[]): string[] {
  return contracts.filter((c) => c.effect !== "read_only" && c.requires === undefined).map((c) => c.name);
}

/** The read_only tools that declare `requires` for anything but one account's data (`kind: "account"`). @beta */
export function readOnlyContractsWithNonAccountRequires(contracts: readonly GuardedContract[]): string[] {
  return contracts.filter((c) => c.effect === "read_only" && c.requires && c.requires.kind !== "account").map((c) => c.name);
}
