// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/item-ref-ports`
 * Purpose: The adapters for the work-items envelope's ref ports (story.0058): the first page of artifact refs, the
 *   first page of history refs and one artifact by id. The HTTP facade and core__work_item_read wire the same ports.
 * Scope: Maps the Doltgres store to `ItemArtifactRefsPort`, `ItemHistoryRefsPort` and `ItemArtifactByIdPort`. The page cut,
 *   the ref shape, the deadline and the `unavailable` mapping live beside it in this package.
 * Invariants:
 *   - REFS_FIRST: lists carry refs only; one artifact in full comes from `artifactById`.
 *   - ABSENT_STORE_IS_ABSENT_PORT: a node without the store gets no port, so the part reads `unavailable`.
 * Side-effects: IO (Doltgres reads through the store)
 * Links: hub work-item-artifacts, change-history-design, work-item-view-capability (moved from node-template's app, story.0085)
 * @public
 */

import { readArtifactRefsPage, type WorkItemArtifactStore } from "./artifacts.js";
import type { ItemArtifactByIdPort, ItemArtifactRefsPort, ItemHistoryRefsPort } from "./envelope.js";
import { readHistoryRefsPage, type WorkItemHistoryStore } from "./history-read.js";
import { toWorkItemId } from "./types.js";

export interface ItemRefPorts {
  readonly artifactRefs?: ItemArtifactRefsPort;
  readonly historyRefs?: ItemHistoryRefsPort;
  readonly artifactById?: ItemArtifactByIdPort;
}

export function createItemRefPorts(deps: {
  readonly artifacts?: WorkItemArtifactStore | undefined;
  readonly history?: Pick<WorkItemHistoryStore, "historyPage"> | undefined;
}): ItemRefPorts {
  const { artifacts } = deps;
  const historyPage = deps.history?.historyPage?.bind(deps.history);
  return {
    ...(artifacts
      ? {
          artifactRefs: { firstPage: (id) => readArtifactRefsPage(artifacts, id) },
          artifactById: { get: (id, artifactId) => artifacts.get(id, artifactId) },
        }
      : {}),
    ...(historyPage
      ? { historyRefs: { firstPage: (id) => readHistoryRefsPage({ historyPage }, toWorkItemId(id)) } }
      : {}),
  };
}
