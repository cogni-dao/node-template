// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Serialize one domain row without selecting an allowlist of read fields. */
import type { WorkItemDto } from "@cogni-dao/read-contracts/work-items";
import { rankScore } from "./scores.js";
import type { WorkItem } from "./types.js";

export function toWorkItemDto(item: WorkItem): WorkItemDto {
  const { actor, ...fields } = item;
  return {
    ...fields,
    ...(actor !== "either" && { actor }),
    rankScore: rankScore(item.scores),
    assignees: item.assignees.map(a => ({ ...a })),
    externalRefs: item.externalRefs.map(r => ({ ...r })),
    labels: [...item.labels],
    specRefs: [...item.specRefs],
  };
}
