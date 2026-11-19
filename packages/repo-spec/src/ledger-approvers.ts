// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/repo-spec` ledger approvers from raw YAML
 * Purpose: Read another node's approver wallets without requiring its whole repo-spec to match this node's schema.
 * Scope: Pure. Parses YAML and reads only `activity_ledger.approvers`.
 * Invariants:
 *   - APPROVERS_ONLY: a fork with an older or newer repo-spec (a retired or unknown field) still yields its approvers; only this one list is validated.
 *   - MALFORMED_IS_LOUD: a list that is not an array of 0x-prefixed 40-hex strings throws `malformed_spec`; unparseable YAML throws `malformed_spec` too.
 *   - A missing list is `[]` (the caller decides; the owner source refuses `no_approvers`).
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/node-relationships-design
 * @public
 */

import { parse } from "yaml";

const WALLET = /^0x[0-9a-fA-F]{40}$/;

/** Lowercased approver wallets from a raw repo-spec, or throw `Error("malformed_spec")`. */
export function readLedgerApproversFromYaml(yaml: string): string[] {
  let doc: unknown;
  try {
    doc = parse(yaml);
  } catch {
    throw new Error("malformed_spec");
  }
  if (doc === null || typeof doc !== "object") throw new Error("malformed_spec");
  const ledger = (doc as Record<string, unknown>).activity_ledger;
  if (ledger === undefined || ledger === null) return [];
  if (typeof ledger !== "object") throw new Error("malformed_spec");
  const approvers = (ledger as Record<string, unknown>).approvers;
  if (approvers === undefined || approvers === null) return [];
  if (!Array.isArray(approvers)) throw new Error("malformed_spec");
  return approvers.map((wallet) => {
    if (typeof wallet !== "string" || !WALLET.test(wallet)) throw new Error("malformed_spec");
    return wallet.toLowerCase();
  });
}
