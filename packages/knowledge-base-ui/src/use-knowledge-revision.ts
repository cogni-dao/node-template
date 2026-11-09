// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/use-knowledge-revision`
 * Purpose: Tell a person that knowledge changed under a live traversal, from the revisions windows already carry and the node's existing cache invalidations (task.0059).
 * Scope: Client hook over the host React Query cache. Observes only; never fetches, scans or refetches.
 * Invariants:
 *   - BASELINE_FIRST_REVISION: the first observed revision is the baseline; a later different revision, or an invalidation of any query under the prefix, sets `restartNeeded`.
 *   - RESTART_ACKNOWLEDGES: `acknowledgeRestart(revision)` adopts a fresh first window's revision as the new baseline and clears the prompt.
 *   - HOST_QUERY_CLIENT: rendered under the host's `QueryClientProvider`.
 * Side-effects: none
 * Links: task.0059
 * @public
 */

"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { KNOWLEDGE_QUERY_PREFIX } from "./knowledge-browse-query.js";

export interface UseKnowledgeRevisionResult {
  readonly restartNeeded: boolean;
  readonly acknowledgeRestart: (revision: string) => void;
}

function underPrefix(key: readonly unknown[], prefix: readonly unknown[]) {
  return prefix.every((part, index) => key[index] === part);
}

export function useKnowledgeRevision(
  revision: string | undefined,
  queryKeyPrefix: readonly unknown[] = KNOWLEDGE_QUERY_PREFIX,
): UseKnowledgeRevisionResult {
  const client = useQueryClient();
  const baseline = useRef(revision);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const prefix = useRef(queryKeyPrefix);
  useEffect(() => {
    prefix.current = queryKeyPrefix;
  });
  useEffect(() => {
    if (!baseline.current) baseline.current = revision;
    else if (revision && baseline.current !== revision) setRestartNeeded(true);
  }, [revision]);
  useEffect(
    () =>
      client.getQueryCache().subscribe((event) => {
        if (
          event.type !== "updated" ||
          !underPrefix(event.query.queryKey, prefix.current)
        )
          return;
        if (event.action.type === "invalidate" && baseline.current)
          setRestartNeeded(true);
        const data = event.query.state.data as
          | { revision?: unknown }
          | undefined;
        if (
          typeof data?.revision === "string" &&
          baseline.current &&
          data.revision !== baseline.current
        )
          setRestartNeeded(true);
      }),
    [client],
  );
  const acknowledgeRestart = useCallback((nextRevision: string) => {
    baseline.current = nextRevision;
    setRestartNeeded(false);
  }, []);
  return { restartNeeded, acknowledgeRestart };
}
