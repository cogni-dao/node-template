// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/graph-3d`
 * Purpose: The knowledge Graph's WebGL force-graph renderer, published on its own client-only subpath so every node draws the whole corpus exactly as node-template does (task.0059).
 * Scope: A `KnowledgeGraphRendererProps` component over the peer `react-force-graph-3d`, which any host importing this subpath must install. The engine touches `window` when it loads, so it is imported after mount; hosts typically lazy-load the subpath too (`next/dynamic(() => import("@cogni/knowledge-base-ui/graph-3d"), { ssr: false })`).
 * Invariants:
 *   - DRAWS_EVERY_NODE: every node and link in `graphData` is drawn; large graphs get cheaper drawing, never fewer entries. Synthetic hub membership links are thin with no particles or arrows (as in the original graph).
 *   - RENDER_BUDGET: no warm-up ticks (first frame immediately); the simulation stops after `cooldownTicks` / `cooldownTime`; above `LARGE_GRAPH_NODES` nodes spheres drop to `LARGE_NODE_RESOLUTION`; above `LARGE_GRAPH_LINKS` links there are no particles or arrows; labels render only on hover (`nodeLabel` tooltip).
 * Side-effects: dynamic import of `react-force-graph-3d`
 * Links: task.0059, packages/knowledge-base-ui/src/knowledge-graph.tsx
 * @public
 */

"use client";

import {
  type ComponentType,
  lazy,
  type ReactElement,
  Suspense,
  useEffect,
  useState,
} from "react";

import type {
  KnowledgeGraphLink,
  KnowledgeGraphNode,
  KnowledgeGraphRendererProps,
} from "./knowledge-graph.js";

/** Render budget: thresholds where drawing gets cheaper (never sparser). */
export const KNOWLEDGE_GRAPH_3D_BUDGET = {
  /** Above this many nodes, spheres use `LARGE_NODE_RESOLUTION` segments. */
  LARGE_GRAPH_NODES: 1_500,
  /** Above this many links, no directional particles or arrows. */
  LARGE_GRAPH_LINKS: 2_000,
  NODE_RESOLUTION: 12,
  LARGE_NODE_RESOLUTION: 4,
  /** The simulation stops after this many ticks or this many ms, whichever first. */
  COOLDOWN_TICKS: 300,
  COOLDOWN_TIME_MS: 15_000,
} as const;

/** The `react-force-graph-3d` props this renderer sets; the library's generics are erased by the lazy import. */
interface ForceGraph3DProps {
  readonly graphData: KnowledgeGraphRendererProps["graphData"];
  readonly width: number;
  readonly height: number;
  readonly backgroundColor: string;
  readonly showNavInfo: boolean;
  readonly warmupTicks: number;
  readonly cooldownTicks: number;
  readonly cooldownTime: number;
  readonly nodeColor: (node: KnowledgeGraphNode) => string;
  readonly nodeVal: (node: KnowledgeGraphNode) => number;
  readonly nodeLabel: (node: KnowledgeGraphNode) => string;
  readonly nodeOpacity: number;
  readonly nodeResolution: number;
  readonly linkColor: (link: KnowledgeGraphLink) => string;
  readonly linkWidth: (link: KnowledgeGraphLink) => number;
  readonly linkDirectionalParticles: (link: KnowledgeGraphLink) => number;
  readonly linkDirectionalParticleWidth: number;
  readonly linkDirectionalArrowLength: (link: KnowledgeGraphLink) => number;
  readonly linkDirectionalArrowRelPos: number;
  readonly onNodeClick: (node: KnowledgeGraphNode) => void;
}

const ForceGraph3D = lazy(async () => {
  const engine = await import("react-force-graph-3d");
  return { default: engine.default as unknown as ComponentType<ForceGraph3DProps> };
});

function Loading(): ReactElement {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground text-xs">
      Loading 3D engine…
    </div>
  );
}

/** WebGL renderer for `KnowledgeGraph`'s `renderer` prop. */
export function KnowledgeForceGraph3D(
  props: KnowledgeGraphRendererProps,
): ReactElement {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <Loading />;
  const budget = KNOWLEDGE_GRAPH_3D_BUDGET;
  const largeNodes = props.graphData.nodes.length > budget.LARGE_GRAPH_NODES;
  const largeLinks = props.graphData.links.length > budget.LARGE_GRAPH_LINKS;
  return (
    <Suspense fallback={<Loading />}>
      <ForceGraph3D
        {...props}
        backgroundColor="rgba(0,0,0,0)"
        showNavInfo={false}
        warmupTicks={0}
        cooldownTicks={budget.COOLDOWN_TICKS}
        cooldownTime={budget.COOLDOWN_TIME_MS}
        nodeOpacity={0.92}
        nodeResolution={
          largeNodes ? budget.LARGE_NODE_RESOLUTION : budget.NODE_RESOLUTION
        }
        // Citations as in the original graph; synthetic hub links stay faint.
        linkWidth={(link) => (largeLinks ? 0 : link.kind === "cite" ? 1.2 : 0.4)}
        linkDirectionalParticles={(link) =>
          largeLinks || link.kind !== "cite" ? 0 : 2
        }
        linkDirectionalParticleWidth={1.4}
        linkDirectionalArrowLength={(link) =>
          largeLinks || link.kind !== "cite" ? 0 : 2.5
        }
        linkDirectionalArrowRelPos={1}
      />
    </Suspense>
  );
}

// biome-ignore lint/style/noDefaultExport: lets hosts lazy-load the subpath directly
export default KnowledgeForceGraph3D;
