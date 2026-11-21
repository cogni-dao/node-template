// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/knowledge-base-ui/epochs/hooks/useReviewSubjectOverrides`
 * Purpose: CRUD hook for review-subject overrides during epoch review.
 * Scope: Client-side data fetching and mutation for review-subject overrides. Does not perform server-side logic.
 * Invariants: WRITE_ROUTES_APPROVER_GATED (server enforces). BigInt overrideUnits serialized as strings.
 * Side-effects: IO (HTTP fetches to review-subject-overrides API)
 * Links: src/contracts/attribution.review-subject-overrides.v1.contract.ts
 * @public
 */

"use client";

import { useEpochContext } from "../context";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

/** Shape of a single override as returned by the GET endpoint. */
export interface ReviewSubjectOverrideView {
  readonly id: string;
  readonly subjectRef: string;
  readonly overrideUnits: string | null;
  readonly overrideReason: string | null;
}

interface UseReviewSubjectOverridesReturn {
  /** Map of subjectRef → override for O(1) lookup. */
  readonly overridesByRef: ReadonlyMap<string, ReviewSubjectOverrideView>;
  readonly isLoading: boolean;
  readonly error: Error | null;
  readonly retry: () => void;
  /** Save (upsert) an override for a subject. */
  readonly saveOverride: (
    subjectRef: string,
    overrideUnits: string,
    reason?: string
  ) => Promise<void>;
  /** Remove an override for a subject. */
  readonly removeOverride: (subjectRef: string) => Promise<void>;
  readonly isSaving: boolean;
}

function overridesQueryKey(epochId: string): readonly string[] {
  return ["governance", "epochs", epochId, "review-subject-overrides"] as const;
}

export function useReviewSubjectOverrides(
  epochId: string
): UseReviewSubjectOverridesReturn {
  const { client } = useEpochContext();
  const queryClient = useQueryClient();
  const qk = overridesQueryKey(epochId);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: qk,
    queryFn: async (): Promise<ReviewSubjectOverrideView[]> => {
      const res = await client.request(client.endpoints.overrides(epochId), {
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error("Failed to fetch overrides");
      const json = (await res.json()) as {
        overrides: ReviewSubjectOverrideView[];
      };
      return json.overrides;
    },
    staleTime: 30_000,
    retry: false,
  });

  const overridesByRef = useMemo(() => {
    const m = new Map<string, ReviewSubjectOverrideView>();
    if (data) {
      for (const o of data) {
        m.set(o.subjectRef, o);
      }
    }
    return m;
  }, [data]);

  const upsertMutation = useMutation({
    mutationFn: async (params: {
      subjectRef: string;
      overrideUnits: string;
      reason?: string | undefined;
    }) => {
      const res = await client.request(client.endpoints.overrides(epochId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          overrides: [
            {
              subjectRef: params.subjectRef,
              overrideUnits: params.overrideUnits,
              overrideReason: params.reason ?? null,
            },
          ],
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Failed to save override: ${body}`);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk });
      // Also invalidate the review epochs query so totals refresh
      void queryClient.invalidateQueries({
        queryKey: ["governance"],
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (subjectRef: string) => {
      const res = await client.request(client.endpoints.overrides(epochId), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ subjectRef }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Failed to delete override: ${body}`);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk });
      void queryClient.invalidateQueries({
        queryKey: ["governance"],
      });
    },
  });

  const saveOverride = useCallback(
    async (subjectRef: string, overrideUnits: string, reason?: string) => {
      await upsertMutation.mutateAsync({ subjectRef, overrideUnits, reason });
    },
    [upsertMutation.mutateAsync]
  );

  const removeOverride = useCallback(
    async (subjectRef: string) => {
      await deleteMutation.mutateAsync(subjectRef);
    },
    [deleteMutation.mutateAsync]
  );

  return {
    overridesByRef,
    isLoading,
    error,
    retry: () => {
      void refetch();
    },
    saveOverride,
    removeOverride,
    isSaving: upsertMutation.isPending || deleteMutation.isPending,
  };
}
