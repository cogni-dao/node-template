// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/GraphView`
 * Purpose: Compose the package whole-corpus Graph and its published WebGL renderer with this node's transport and exact-ID detail sheet.
 * Scope: Composition only. Graph state, exact counts, narrowing, neighbor highlighting and the renderer live in `@cogni/knowledge-base-ui` (`/knowledge`, `/graph-3d`; task.0059). The node lazy-loads the client-only renderer subpath.
 * Invariants: Browser client: same-origin cookie transport only; the graph route revalidates by store revision (ETag/304).
 * Side-effects: IO (through the package hook and node fetchers)
 * @internal
 */

"use client";

import {
  KnowledgeGraph,
  type KnowledgeGraphRendererProps,
} from "@cogni/knowledge-base-ui/knowledge";
import dynamic from "next/dynamic";
import { type ComponentType, useCallback, useState } from "react";

import { fetchGraph } from "../_api/fetchGraph";
import { KnowledgeDetail } from "./KnowledgeDetail";
import { useKnowledgeSelection } from "./KnowledgeSelection";

const KnowledgeForceGraph3D = dynamic(
  () => import("@cogni/knowledge-base-ui/graph-3d"),
  { ssr: false }
) as ComponentType<KnowledgeGraphRendererProps>;

export function GraphView() {
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
        fetchGraph={fetchGraph}
        renderer={KnowledgeForceGraph3D}
        selectedId={selectedId}
        onSelect={onSelect}
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
