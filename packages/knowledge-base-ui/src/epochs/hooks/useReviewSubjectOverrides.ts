// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

"use client";
/** Exact scoped read + mutation transport. Acceptance never invalidates or claims verification. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useEpochContext } from "../context";
import {
  ReviewRefusal,
  reviewResponseError,
  safeReviewError,
} from "../review-errors";

export interface ReviewSubjectOverrideView {
  readonly id: string;
  readonly subjectRef: string;
  readonly overrideUnits: string | null;
  readonly overrideReason: string | null;
}
export const overridesQueryKey = (
  prefix: readonly string[],
  epochId: string | null,
) => [...prefix, "epochs", epochId, "review-subject-overrides"] as const;
export interface OverrideRead {
  readonly overrides: ReviewSubjectOverrideView[];
  readonly readId: string;
}
export interface OverrideSubmission {
  readonly subjectRef: string;
  readonly kind: "save" | "reset";
  readonly units: string;
  readonly reason: string | null;
}
export function useReviewSubjectOverrides(epochId: string | null) {
  const { client, queryKeyPrefix } = useEpochContext();
  const qk = overridesQueryKey(queryKeyPrefix, epochId);
  const query = useQuery({
    queryKey: qk,
    enabled: epochId !== null,
    queryFn: async ({ signal }): Promise<OverrideRead> => {
      try {
        if (epochId === null) throw new ReviewRefusal("not_found", "read");
        const res = await client.request(client.endpoints.overrides(epochId), {
          credentials: "same-origin",
          cache: "no-store",
          signal,
        });
        if (!res.ok) throw await reviewResponseError(res, "read");
        const json: unknown = await res.json();
        signal.throwIfAborted();
        if (
          !json ||
          typeof json !== "object" ||
          !("overrides" in json) ||
          !Array.isArray(json.overrides)
        )
          throw new ReviewRefusal("unexpected", "read");
        const overrides: ReviewSubjectOverrideView[] = [];
        for (const item of json.overrides) {
          if (
            !item ||
            typeof item !== "object" ||
            typeof item.id !== "string" ||
            typeof item.subjectRef !== "string" ||
            !(
              item.overrideUnits === null ||
              (typeof item.overrideUnits === "string" &&
                /^\d+$/.test(item.overrideUnits))
            ) ||
            !(
              item.overrideReason === null ||
              typeof item.overrideReason === "string"
            )
          )
            throw new ReviewRefusal("unexpected", "read");
          overrides.push({
            id: item.id,
            subjectRef: item.subjectRef,
            overrideUnits: item.overrideUnits,
            overrideReason: item.overrideReason,
          });
        }
        return { overrides, readId: crypto.randomUUID() };
      } catch (error) {
        throw safeReviewError(error, "read");
      }
    },
    staleTime: 30_000,
    retry: false,
    refetchOnMount: "always",
  });
  const mutation = useMutation({
    mutationFn: async ({
      epochId,
      submission,
    }: {
      epochId: string | null;
      submission: OverrideSubmission;
    }) => {
      if (epochId === null)
        throw new ReviewRefusal("not_found", submission.kind);
      try {
        const res = await client.request(client.endpoints.overrides(epochId), {
          method: submission.kind === "save" ? "PATCH" : "DELETE",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(
            submission.kind === "save"
              ? {
                  overrides: [
                    {
                      subjectRef: submission.subjectRef,
                      overrideUnits: submission.units,
                      overrideReason: submission.reason,
                    },
                  ],
                }
              : { subjectRef: submission.subjectRef },
          ),
        });
        if (!res.ok) throw await reviewResponseError(res, submission.kind);
      } catch (error) {
        throw safeReviewError(error, submission.kind);
      }
    },
    retry: false,
    networkMode: "always",
  });
  const overridesByRef = useMemo(
    () => new Map(query.data?.overrides.map((o) => [o.subjectRef, o])),
    [query.data],
  );
  return {
    ...query,
    queryKey: qk,
    overridesByRef,
    submit: (submission: OverrideSubmission) =>
      mutation.mutateAsync({ epochId, submission }),
    isSaving: mutation.isPending,
  };
}
