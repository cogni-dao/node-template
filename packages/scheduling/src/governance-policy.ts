// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Derive a node-scoped Temporal schedule ID, including operator-owned IDs. */
export function governanceScheduleId(nodeId: string, charter: string): string {
  return `governance:${nodeId}:${charter.toLowerCase()}`;
}

/** The operator alone schedules epoch collection. */
export function isOperatorOwnedGovernanceCharter(charter: string): boolean {
  return charter.toLowerCase() === "ledger_ingest";
}

/** A node may prune only its own scoped, non-ledger governance schedules. */
export function isOwnGovernanceScheduleId(
  nodeId: string,
  scheduleId: string
): boolean {
  const prefix = `governance:${nodeId}:`;
  if (!scheduleId.startsWith(prefix)) return false;
  const charter = scheduleId.slice(prefix.length);
  return charter.length > 0 && !isOperatorOwnedGovernanceCharter(charter);
}

/** Flat IDs belong to a shared namespace and must not be changed by node sync. */
export function isLegacyFlatGovernanceScheduleId(scheduleId: string): boolean {
  return (
    scheduleId.startsWith("governance:") && scheduleId.split(":").length === 2
  );
}
