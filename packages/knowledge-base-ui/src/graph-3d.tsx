// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/graph-3d`
 * Purpose: The knowledge Graph's WebGL force-graph renderer, published on its own client-only subpath so every node draws the graph exactly as node-template does (task.0059).
 * Scope: A `KnowledgeGraphRendererProps` component over the optional peer `react-force-graph-3d`. Importing this subpath never loads the engine: it is fetched with a dynamic import after the component mounts in a browser. Hosts typically load the subpath itself lazily too (e.g. `next/dynamic(() => import("@cogni/knowledge-base-ui/graph-3d"), { ssr: false })`).
 * Invariants:
 *   - ENGINE_CLIENT_ONLY: `react-force-graph-3d` touches `window` when it loads, so it is imported only after mount; server render and plain-Node import render a placeholder.
 *   - DRAWS_PACKAGE_GEOMETRY: draws exactly the bounded `graphData` and callbacks `KnowledgeGraph` passes; link styling assumes typed citation edges only.
 * Side-effects: dynamic import of the peer `react-force-graph-3d`, which a host importing this subpath must install (declared optional only so work-board adopters are not auto-installed a WebGL engine). Without it the host's bundler fails to resolve the import at build time; there is no runtime fallback.
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

import type { KnowledgeGraphRendererProps } from "./knowledge-graph.js";
import type {
  KnowledgeGraphLink,
  KnowledgeGraphNode,
} from "./use-graph-focus.js";

/** The `react-force-graph-3d` props this renderer sets; the library's generics are erased by the lazy import. */
interface ForceGraph3DProps {
  readonly graphData: KnowledgeGraphRendererProps["graphData"];
  readonly width: number;
  readonly height: number;
  readonly backgroundColor: string;
  readonly showNavInfo: boolean;
  readonly nodeColor: (node: KnowledgeGraphNode) => string;
  readonly nodeVal: (node: KnowledgeGraphNode) => number;
  readonly nodeLabel: (node: KnowledgeGraphNode) => string;
  readonly nodeOpacity: number;
  readonly nodeResolution: number;
  readonly linkColor: (link: KnowledgeGraphLink) => string;
  readonly linkWidth: number;
  readonly linkDirectionalParticles: number;
  readonly linkDirectionalParticleWidth: number;
  readonly linkDirectionalArrowLength: number;
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
  return (
    <Suspense fallback={<Loading />}>
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
    </Suspense>
  );
}

// biome-ignore lint/style/noDefaultExport: lets hosts lazy-load the subpath directly
export default KnowledgeForceGraph3D;
