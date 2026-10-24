// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Versioned full work-item identity, computed before presentation caps. No I/O. */
import type { WorkItemInfo } from "./capabilities/work-item";

export const WORK_ITEM_SEMANTIC_VERSION = "work-item-semantic-v1";
export function semanticJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))
        )
      : entry
  );
}
export async function workItemSemanticIdentity(
  item: WorkItemInfo,
  provenance: { sourceUrl?: string; sourceUrlUnavailable?: true }
): Promise<{
  policyVersion: typeof WORK_ITEM_SEMANTIC_VERSION;
  digest: string;
}> {
  // Enumerate the capability contract; absent values have one representation.
  const projection = {
    id: item.id,
    type: item.type,
    title: item.title,
    status: item.status,
    actor: item.actor ?? null,
    priority: item.priority ?? null,
    rank: item.rank ?? null,
    rankScore: item.rankScore ?? null,
    summary: item.summary ?? null,
    outcome: item.outcome ?? null,
    projectId: item.projectId ?? null,
    parentId: item.parentId ?? null,
    estimate: item.estimate ?? null,
    branch: item.branch ?? null,
    pr: item.pr ?? null,
    blockedBy: item.blockedBy ?? null,
    scores: item.scores ?? null,
    labels: [...new Set(item.labels)].sort(),
    assignees: [...item.assignees]
      .map(({ kind, id }) => ({ kind, id }))
      .sort((a, b) => semanticJson(a).localeCompare(semanticJson(b))),
    specRefs: [...new Set(item.specRefs ?? [])].sort(),
    sourceUrl: provenance.sourceUrl ?? null,
    sourceUrlUnavailable: provenance.sourceUrlUnavailable === true,
  };
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(semanticJson(projection))
  );
  return {
    policyVersion: WORK_ITEM_SEMANTIC_VERSION,
    digest: Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0")
    ).join(""),
  };
}
