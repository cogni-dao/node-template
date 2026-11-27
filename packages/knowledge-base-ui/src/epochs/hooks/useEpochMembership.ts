// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

"use client";
import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useEpochContext } from "../context";

// Each cached query owns its latest attempt, across page changes and observers.
// Weak keys retire bookkeeping when QueryCache releases the query itself.
const attempts = new WeakMap<object, string>();

/** Retire at native fetch start, including attempts paused before queryFn runs. */
export function useEpochMembership(queryKey: QueryKey) {
  const { queryKeyPrefix } = useEpochContext();
  const queryClient = useQueryClient();
  const { queryHash } = queryClient.defaultQueryOptions({ queryKey });
  const currentQuery = () => queryClient.getQueryCache().get(queryHash);
  return {
    // Query core invokes onFetch before dispatching fetch/pausing the retryer.
    // Reverting cancellation restores query data, but cannot undo this retirement.
    behavior: {
      onFetch: (_context: unknown, query: object) => {
        attempts.set(query, crypto.randomUUID());
      },
    },
    isCurrent: (readId: string | undefined) => {
      const query = currentQuery();
      const attempt = query && attempts.get(query);
      return attempt === undefined || attempt === readId;
    },
    read: async <T>(
      epochId: string | undefined,
      signal: AbortSignal,
      fetch: (readId: string) => Promise<T>
    ): Promise<T> => {
      const query = currentQuery();
      if (!query) throw new Error("Epoch membership query is unavailable");
      const readId = attempts.get(query) ?? crypto.randomUUID();
      attempts.set(query, readId);
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
