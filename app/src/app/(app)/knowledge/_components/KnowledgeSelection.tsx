// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/** Exact-ID detail is independent of every loaded page; query identity prevents stale selection. */
"use client";
import { useQuery } from "@tanstack/react-query";
import { fetchKnowledgeEntry } from "../_api/fetchKnowledgeEntry";
import { KnowledgeDetail } from "./KnowledgeDetail";

export function useKnowledgeSelection(id: string | null) {
  return useQuery({
    queryKey: ["knowledge", "detail", id],
    queryFn: ({ signal }) => fetchKnowledgeEntry(id ?? "", signal),
    enabled: id !== null,
    staleTime: 30_000,
    retry: false,
  });
}
export function KnowledgeSelection({
  id,
  onClose,
}: {
  readonly id: string | null;
  readonly onClose: () => void;
}) {
  const detail = useKnowledgeSelection(id);
  return (
    <KnowledgeDetail
      item={detail.data ?? null}
      open={id !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      loading={detail.isFetching}
      error={detail.error}
      onRetry={() => void detail.refetch()}
    />
  );
}
