// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/GraphView`
 * Purpose: Compose the package Graph capability and its published WebGL renderer with this node's transport and exact-ID detail sheet.
 * Scope: Composition only. Overview windows, focus pages, bounded geometry, palette, legend, controls and the renderer live in `@cogni/knowledge-base-ui` (`/knowledge`, `/graph-3d`; task.0059). The node only lazy-loads the client-only renderer subpath.
 * Invariants: Browser client: same-origin cookie transport only.
 * Side-effects: IO (through the package hooks and node fetchers)
 * @internal
 */

"use client";

import {
  KnowledgeGraph,
  type KnowledgeGraphRendererProps,
} from "@cogni/knowledge-base-ui/knowledge";
import type { KnowledgeBrowsePage } from "@cogni/node-contracts";
import dynamic from "next/dynamic";
import { type ComponentType, useCallback, useState } from "react";

import { fetchCitationLinks } from "../../_api/fetchCitationLinks";
import { fetchOverview } from "../_api/fetchBrowse";
import { KnowledgeDetail } from "./KnowledgeDetail";
import { useKnowledgeSelection } from "./KnowledgeSelection";

const KnowledgeForceGraph3D = dynamic(
  () => import("@cogni/knowledge-base-ui/graph-3d"),
  { ssr: false }
) as ComponentType<KnowledgeGraphRendererProps>;

export function GraphView({
  initialData,
}: {
  readonly initialData?: KnowledgeBrowsePage | undefined;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const detail = useKnowledgeSelection(selectedId);
  const onSelect = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id) setDetailOpen(true);
  }, []);
  return (
    <>
      <KnowledgeGraph
        fetchOverview={fetchOverview}
        fetchCitationLinks={fetchCitationLinks}
        renderer={KnowledgeForceGraph3D}
        initialData={initialData}
        selectedId={selectedId}
        onSelect={onSelect}
        selected={detail.data ?? null}
        canvasClassName="h-[var(--height-knowledge-graph)]"
      />
      <KnowledgeDetail
        item={detail.data ?? null}
        open={detailOpen && selectedId !== null}
        loading={detail.isFetching}
        error={detail.error}
        onRetry={() => void detail.refetch()}
        onOpenChange={setDetailOpen}
      />
    </>
  );
}
