// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Bounded metadata overview and five-link replacement focus pages, reusing the
 * existing WebGL renderer and exact-ID detail sheet. Work endpoints remain links.
 * No synthetic hubs, full-graph read, body prefetch or accumulated geometry.
 * Browser cancellation guards intent; native source-byte/latency costs need live proof.
 * @internal
 */

"use client";

import type { KnowledgeBrowsePage } from "@cogni/node-contracts";
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import {
  type ComponentType,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { fetchBrowse, overviewKey } from "../_api/fetchBrowse";
import { KnowledgeDetail } from "./KnowledgeDetail";
import { useKnowledgeSelection } from "./KnowledgeSelection";
import { focusGeometry, useGraphFocus } from "./useGraphFocus";

interface GraphNodeObject {
  id: string;
  isHub: boolean;
  domain: string;
  title: string;
  entryType?: string;
  confidencePct?: number | null;
  sourceType?: string;
  entryCount?: number;
}

interface GraphLinkObject {
  source: string;
  target: string;
  kind: "member" | "cite";
  citationType?: string;
}

// Only the props we use. `next/dynamic` erases the lib's own generic prop types,
// so we re-declare them over our node/link shapes — keeps the JSX strongly typed.
interface ForceGraph3DProps {
  readonly graphData: {
    nodes: GraphNodeObject[];
    links: GraphLinkObject[];
  };
  readonly width?: number;
  readonly height?: number;
  readonly backgroundColor?: string;
  readonly showNavInfo?: boolean;
  readonly nodeColor?: (node: GraphNodeObject) => string;
  readonly nodeVal?: (node: GraphNodeObject) => number;
  readonly nodeLabel?: (node: GraphNodeObject) => string;
  readonly nodeOpacity?: number;
  readonly nodeResolution?: number;
  readonly linkColor?: (link: GraphLinkObject) => string;
  readonly linkWidth?: (link: GraphLinkObject) => number;
  readonly linkDirectionalParticles?: (link: GraphLinkObject) => number;
  readonly linkDirectionalParticleWidth?: number;
  readonly linkDirectionalArrowLength?: (link: GraphLinkObject) => number;
  readonly linkDirectionalArrowRelPos?: number;
  readonly onNodeClick?: (node: GraphNodeObject) => void;
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

// Citation-type palette for the graph's existing edge semantics.
const CITE_COLOR: Record<string, string> = {
  supports: "#34d399",
  validates: "#34d399",
  evidence_for: "#7dd3fc",
  extends: "#6ea8fe",
  derives_from: "#6ea8fe",
  supersedes: "#fbbf24",
  contradicts: "#f87171",
  invalidates: "#f87171",
};

// Confidence → hue ramp across the red→green arc of the HSL wheel:
// hue = pct * 1.2, so 0 = red, ~30 = orange, ~50 = yellow, 100 = green.
function confidenceColor(pct: number): string {
  const p = Math.max(0, Math.min(100, pct));
  return `hsl(${Math.round(p * 1.2)}, 80%, 55%)`;
}

// Domain hubs are structural anchors, not a classifier — render them neutral so
// the entries' confidence hue is the only color signal.
const HUB_COLOR = "#94a3b8";

// nodeLabel is injected as HTML by the graph lib; knowledge titles/ids are
// agent- and externally-authored (untrusted), so escape before interpolation.
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

type ColorMode = "confidence" | "domain";

// Domain palette (Domain color mode). Operator base domains are fixed; any
// extension domain hashes into a stable fallback hue.
const BASE_DOMAIN_COLOR: Record<string, string> = {
  meta: "#a78bfa",
  nodes: "#34d399",
  infrastructure: "#fbbf24",
  governance: "#f472b6",
};
const EXTENSION_PALETTE = [
  "#6ea8fe",
  "#2dd4bf",
  "#c084fc",
  "#f97316",
  "#22d3ee",
  "#e879f9",
];
function domainColor(domain: string): string {
  const base = BASE_DOMAIN_COLOR[domain];
  if (base) return base;
  let h = 0;
  for (let i = 0; i < domain.length; i++) {
    h = (h * 31 + domain.charCodeAt(i)) | 0;
  }
  return EXTENSION_PALETTE[Math.abs(h) % EXTENSION_PALETTE.length] ?? "#6ea8fe";
}

export function GraphView({
  initialData,
}: {
  readonly initialData?: KnowledgeBrowsePage | undefined;
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const [history, setHistory] = useState<Array<string | undefined>>([]);
  const query = cursor ? { cursor } : {};
  const graphQuery = useQuery({
    queryKey: overviewKey(query),
    queryFn: ({ signal }) => fetchBrowse(query, signal, "overview"),
    staleTime: 30_000,
    retry: false,
    initialData: !cursor ? initialData : undefined,
  });
  const lastOverview = useRef<KnowledgeBrowsePage | undefined>(initialData);
  if (graphQuery.data) lastOverview.current = graphQuery.data;
  const overview = graphQuery.data ?? lastOverview.current;
  const [colorMode, setColorMode] = useState<ColorMode>("confidence");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [entryId, setEntryId] = useState("");
  const focus = useGraphFocus(selectedId);
  const detail = useKnowledgeSelection(selectedId);
  const data = useMemo(
    () =>
      focusGeometry(overview?.items ?? [], detail.data ?? null, {
        links: focus.links,
      }),
    [overview, detail.data, focus.links]
  );

  const nodeColor = useCallback(
    (node: GraphNodeObject) => {
      if (colorMode === "domain") return domainColor(node.domain);
      if (node.isHub) return HUB_COLOR;
      return confidenceColor(node.confidencePct ?? 40);
    },
    [colorMode]
  );

  const nodeVal = useCallback((node: GraphNodeObject) => {
    if (node.isHub) return 22;
    return 2 + (node.confidencePct ?? 40) / 22;
  }, []);

  const nodeLabel = useCallback((node: GraphNodeObject) => {
    if (node.isHub) {
      return `<b>${escapeHtml(node.domain)}</b> · ${node.entryCount} entries`;
    }
    const meta = `${escapeHtml(node.id)} · ${escapeHtml(node.entryType ?? "")} · ${node.confidencePct ?? "?"}%`;
    return `<div style="max-width:240px"><b>${escapeHtml(node.title)}</b><br/><span style="opacity:.6">${meta}</span></div>`;
  }, []);

  const linkColor = useCallback((link: GraphLinkObject) => {
    if (link.kind === "member") return "rgba(120,128,140,.18)";
    return CITE_COLOR[link.citationType ?? ""] ?? "#9aa0aa";
  }, []);

  const onNodeClick = useCallback((node: GraphNodeObject) => {
    if (node.isHub) return;
    setSelectedId(node.id);
    setDetailOpen(true);
  }, []);

  // Size the WebGL canvas to its container (the lib defaults to window size).
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    });
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex items-center rounded-lg border border-border/60 bg-muted/40 p-0.5">
          {(["confidence", "domain"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setColorMode(m)}
              className={`rounded-md px-3 py-1 text-xs capitalize transition-colors ${
                colorMode === m
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (entryId) {
              setSelectedId(entryId);
              setDetailOpen(true);
            }
          }}
        >
          <input
            aria-label="Knowledge ID"
            placeholder="Open exact knowledge ID"
            value={entryId}
            onChange={(e) => setEntryId(e.target.value)}
            className="rounded border bg-background px-2 text-xs"
          />
          <button type="submit" className="text-xs underline">
            Open entry
          </button>
        </form>
        <span className="text-muted-foreground text-xs">
          {overview?.items.length ?? "…"} overview nodes · {focus.links.length}{" "}
          current links · hubs disabled
        </span>
        <button
          type="button"
          disabled={!history.length || graphQuery.isFetching}
          onClick={() => {
            setCursor(history[history.length - 1]);
            setHistory(history.slice(0, -1));
          }}
        >
          Previous overview
        </button>
        <button
          type="button"
          disabled={
            !overview?.nextCursor || graphQuery.isFetching || !!graphQuery.error
          }
          onClick={() => {
            if (overview?.nextCursor) {
              setHistory([...history, cursor]);
              setCursor(overview.nextCursor);
            }
          }}
        >
          More overview
        </button>
      </div>

      <div
        ref={wrapRef}
        className="relative h-[var(--height-knowledge-graph)] w-full overflow-hidden rounded-lg border border-border/60 bg-background"
      >
        {overview && (
          <ForceGraph3D
            graphData={data}
            width={size.width}
            height={size.height}
            backgroundColor="rgba(0,0,0,0)"
            showNavInfo={false}
            nodeColor={nodeColor}
            nodeVal={nodeVal}
            nodeLabel={nodeLabel}
            nodeOpacity={0.92}
            nodeResolution={12}
            linkColor={linkColor}
            linkWidth={(l: GraphLinkObject) => (l.kind === "cite" ? 1.2 : 0.4)}
            linkDirectionalParticles={(l: GraphLinkObject) =>
              l.kind === "cite" ? 2 : 0
            }
            linkDirectionalParticleWidth={1.4}
            linkDirectionalArrowLength={(l: GraphLinkObject) =>
              l.kind === "cite" ? 2.5 : 0
            }
            linkDirectionalArrowRelPos={1}
            onNodeClick={onNodeClick}
          />
        )}
        <GraphLegend
          colorMode={colorMode}
          edges={data.links}
          domains={[
            ...new Set(data.nodes.map((n) => n.domain).filter(Boolean)),
          ]}
        />
      </div>

      {graphQuery.error && (
        <p role="alert">
          Could not load overview.{" "}
          <button type="button" onClick={() => void graphQuery.refetch()}>
            Retry overview
          </button>
        </p>
      )}
      {selectedId && (
        <div className="flex flex-col gap-2 text-xs">
          <p>
            Focus: {selectedId} · {focus.links.length} links on this page
            {focus.pending ? " · loading…" : ""}
          </p>
          {focus.error && (
            <p role="alert">
              Could not load focus page.{" "}
              <button type="button" onClick={focus.retry}>
                Retry focus page
              </button>
            </p>
          )}
          {focus.links.map((link) => (
            <div key={link.id}>
              <span>
                {link.direction === "in" ? "Incoming" : "Outgoing"} ·{" "}
                {link.citationType} ·{" "}
              </span>
              <a href={link.source.href}>
                {link.source.title ?? link.source.id}
              </a>{" "}
              →{" "}
              <a href={link.target.href}>
                {link.target.title ?? link.target.id}
              </a>
            </div>
          ))}
          <div className="flex gap-3">
            <button
              type="button"
              disabled={!focus.nextCursor || focus.pending || focus.error}
              onClick={focus.more}
            >
              More focus links
            </button>
            <button
              type="button"
              disabled={focus.pending}
              onClick={focus.restart}
            >
              Restart focus
            </button>
            <button type="button" onClick={() => setSelectedId(null)}>
              Clear focus
            </button>
          </div>
        </div>
      )}
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

const SECTION_CLASS =
  "mb-1.5 font-medium text-[var(--text-knowledge-graph-section)] text-muted-foreground uppercase tracking-wider";

function GraphLegend({
  colorMode,
  edges,
  domains,
}: {
  readonly colorMode: ColorMode;
  readonly edges: ReadonlyArray<{ citationType: string }>;
  readonly domains: ReadonlyArray<string>;
}) {
  const citeTypes = [...new Set(edges.map((e) => e.citationType))];
  const ramp = [0, 25, 50, 75, 100];
  return (
    <div className="absolute bottom-3 left-3 w-[var(--width-knowledge-graph-legend)] rounded-lg border border-border/60 bg-background/80 p-3 backdrop-blur">
      <p className="mb-2.5 font-medium text-[var(--text-knowledge-graph-stat)] text-foreground tabular-nums">
        {edges.length} citation{edges.length === 1 ? "" : "s"} ·{" "}
        {domains.length} domain{domains.length === 1 ? "" : "s"}
      </p>

      {colorMode === "confidence" ? (
        <>
          <p className={SECTION_CLASS}>Confidence</p>
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <span>0</span>
            <span className="flex">
              {ramp.map((p) => (
                <span
                  key={p}
                  className="size-2.5"
                  style={{ backgroundColor: confidenceColor(p) }}
                />
              ))}
            </span>
            <span>100</span>
          </div>
        </>
      ) : (
        <>
          <p className={SECTION_CLASS}>Domains</p>
          {domains.slice(0, 8).map((d) => (
            <div key={d} className="flex items-center gap-2 text-xs">
              <span
                className="size-2.5 rounded-full"
                style={{ backgroundColor: domainColor(d) }}
              />
              {d}
            </div>
          ))}
        </>
      )}

      <p className={`${SECTION_CLASS} mt-2.5`}>Links · citations</p>
      {citeTypes.length > 0 ? (
        citeTypes.slice(0, 8).map((ct) => (
          <div key={ct} className="flex items-center gap-2 text-xs">
            <span
              className="h-0 w-4 border-t-2"
              style={{ borderColor: CITE_COLOR[ct] ?? "#9aa0aa" }}
            />
            {ct}
          </div>
        ))
      ) : (
        <span className="text-muted-foreground text-xs">
          none yet — agents cite as they learn
        </span>
      )}
    </div>
  );
}
