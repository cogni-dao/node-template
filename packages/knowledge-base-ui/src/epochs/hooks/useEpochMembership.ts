// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

"use client";
import { useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { useEpochContext } from "../context";

/** Membership retires before activity can persist, even if the later summary fails. */
export function useEpochMembership() {
  const { queryKeyPrefix } = useEpochContext();
  const queryClient = useQueryClient();
  const attempt = useRef<string | null>(null);
  return {
    isCurrent: (readId: string | undefined) =>
      attempt.current === null || attempt.current === readId,
    read: async <T>(
      epochId: string | undefined,
      signal: AbortSignal,
      fetch: (readId: string) => Promise<T>
    ): Promise<T> => {
      const readId = crypto.randomUUID();
      attempt.current = readId;
      await queryClient.cancelQueries({
        predicate: (query) => {
          const key = query.queryKey;
          const start = queryKeyPrefix.length;
          return (
            queryKeyPrefix.every((part, index) => key[index] === part) &&
            key[start] === "epochs" &&
            key[start + 1] === epochId &&
            key[start + 3] === "contributor"
          );
        },
      });
      signal.throwIfAborted();
      return fetch(readId);
    },
  };
}
