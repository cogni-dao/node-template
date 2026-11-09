// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/GraphView`
 * Purpose: Compose the package Graph capability with this node's transport, its WebGL force-graph renderer and exact-ID detail sheet.
 * Scope: Composition plus the renderer adapter. Overview windows, focus pages, bounded geometry, palette, legend and controls live in `@cogni/knowledge-base-ui` (task.0059); `react-force-graph-3d` stays node-local because it is a heavy, `window`-bound engine loaded through `next/dynamic`.
 * Invariants: Browser client: same-origin cookie transport only. The renderer draws exactly the package geometry (≤ 26 nodes, ≤ 5 typed edges).
 * Side-effects: IO (through the package hooks and node fetchers)
 * @internal
 */

"use client";

import {
  KnowledgeGraph,
  type KnowledgeGraphLink,
  type KnowledgeGraphNode,
  type KnowledgeGraphRendererProps,
} from "@cogni/knowledge-base-ui";
import type { KnowledgeBrowsePage } from "@cogni/node-contracts";
import dynamic from "next/dynamic";
import { type ComponentType, useCallback, useState } from "react";

import { fetchCitationLinks } from "../../_api/fetchCitationLinks";
import { fetchOverview } from "../_api/fetchBrowse";
import { KnowledgeDetail } from "./KnowledgeDetail";
import { useKnowledgeSelection } from "./KnowledgeSelection";

// Only the props we use. `next/dynamic` erases the lib's own generic prop types.
interface ForceGraph3DProps {
  readonly graphData: KnowledgeGraphRendererProps["graphData"];
  readonly width?: number;
  readonly height?: number;
  readonly backgroundColor?: string;
  readonly showNavInfo?: boolean;
  readonly nodeColor?: (node: KnowledgeGraphNode) => string;
  readonly nodeVal?: (node: KnowledgeGraphNode) => number;
  readonly nodeLabel?: (node: KnowledgeGraphNode) => string;
  readonly nodeOpacity?: number;
  readonly nodeResolution?: number;
  readonly linkColor?: (link: KnowledgeGraphLink) => string;
  readonly linkWidth?: number;
  readonly linkDirectionalParticles?: number;
  readonly linkDirectionalParticleWidth?: number;
  readonly linkDirectionalArrowLength?: number;
  readonly linkDirectionalArrowRelPos?: number;
  readonly onNodeClick?: (node: KnowledgeGraphNode) => void;
}

// react-force-graph-3d reaches for `window` at module load — keep it client-only.
const ForceGraph3D = dynamic(() => import("react-force-graph-3d"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-muted-foreground text-xs">
      Loading 3D engine…
    </div>
  ),
}) as unknown as ComponentType<ForceGraph3DProps>;

function ForceGraphRenderer(props: KnowledgeGraphRendererProps) {
  return (
    <ForceGraph3D
      {...props}
      backgroundColor="rgba(0,0,0,0)"
      showNavInfo={false}
      nodeOpacity={0.92}
      nodeResolution={12}
      linkWidth={1.2}
      linkDirectionalParticles={2}
      linkDirectionalParticleWidth={1.4}
      linkDirectionalArrowLength={2.5}
      linkDirectionalArrowRelPos={1}
    />
  );
}

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
        renderer={ForceGraphRenderer}
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
