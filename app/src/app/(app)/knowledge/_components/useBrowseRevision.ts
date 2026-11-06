// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Observe live window revisions and existing mutation invalidation; never scan. */
"use client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

export function useBrowseRevision(revision: string | undefined) {
  const client = useQueryClient();
  const baseline = useRef(revision);
  const [restartNeeded, setRestartNeeded] = useState(false);
  useEffect(() => {
    if (!baseline.current) baseline.current = revision;
    else if (revision && baseline.current !== revision) setRestartNeeded(true);
  }, [revision]);
  useEffect(
    () =>
      client.getQueryCache().subscribe((event) => {
        if (event.type !== "updated" || event.query.queryKey[0] !== "knowledge")
          return;
        if (event.action.type === "invalidate" && baseline.current)
          setRestartNeeded(true);
        const data = event.query.state.data as
          | { revision?: string }
          | undefined;
        if (
          data?.revision &&
          baseline.current &&
          data.revision !== baseline.current
        )
          setRestartNeeded(true);
      }),
    [client]
  );
  const acknowledgeRestart = useCallback((nextRevision: string) => {
    baseline.current = nextRevision;
    setRestartNeeded(false);
  }, []);
  return { restartNeeded, acknowledgeRestart };
}
