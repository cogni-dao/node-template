// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/knowledge-graph`
 * Purpose: The bounded knowledge Graph capability minus the drawing engine: overview windows, color modes, exact-id open, replacement focus pages with their link list, typed-edge palette, legend and revision prompt (task.0059).
 * Scope: Client view over `useKnowledgeOverview`, `useGraphFocus` and `knowledgeFocusGeometry`. The node injects its fetchers, the selected atom's row (from its own detail read) and a `renderer` that draws `graphData`: normally the package's `KnowledgeForceGraph3D` from the client-only `./graph-3d` subpath, lazy-loaded, so this entry never pulls the WebGL engine.
 * Invariants:
 *   - BOUNDED_GEOMETRY: the renderer receives ≤ 26 fresh nodes and ≤ 5 typed edges; no hubs, full-graph read, body prefetch or accumulated geometry.
 *   - SELECTION_IS_NODE_STATE: `selectedId` is controlled; the node decides what selecting opens (its detail sheet).
 *   - LABELS_ESCAPED: `nodeLabel` returns HTML with every agent-authored string escaped.
 *   - EXPLICIT_OVERVIEW_PAGING: More / Previous / Restart overview each request one window; the last window keeps drawing while the next loads or fails.
 * Side-effects: IO (through the injected fetchers)
 * Links: task.0059
 * @public
 */

"use client";

import type {
  KnowledgeBrowsePage,
  KnowledgeSummary,
} from "@cogni/knowledge-store/contracts";
import {
  type ComponentType,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "./cn.js";
import type { KnowledgeWindowFetcher } from "./knowledge-browse-query.js";
import {
  type KnowledgeCitationFetcher,
  type KnowledgeGraphGeometry,
  type KnowledgeGraphLink,
  type KnowledgeGraphNode,
  knowledgeFocusGeometry,
  useGraphFocus,
} from "./use-graph-focus.js";
import { useKnowledgeOverview } from "./use-knowledge-windows.js";

export type KnowledgeGraphColorMode = "confidence" | "domain";

/** What a node's drawing engine receives. Callbacks are stable per color mode. */
export interface KnowledgeGraphRendererProps {
  readonly graphData: KnowledgeGraphGeometry;
  readonly width: number;
  readonly height: number;
  readonly nodeColor: (node: KnowledgeGraphNode) => string;
  readonly nodeVal: (node: KnowledgeGraphNode) => number;
  /** Escaped HTML tooltip. */
  readonly nodeLabel: (node: KnowledgeGraphNode) => string;
  readonly linkColor: (link: KnowledgeGraphLink) => string;
  readonly onNodeClick: (node: KnowledgeGraphNode) => void;
}

/** Citation-type palette for typed edges. */
export const KNOWLEDGE_CITATION_COLORS: Readonly<Record<string, string>> = {
  supports: "#34d399",
  validates: "#34d399",
  evidence_for: "#7dd3fc",
  extends: "#6ea8fe",
  derives_from: "#6ea8fe",
  supersedes: "#fbbf24",
  contradicts: "#f87171",
  invalidates: "#f87171",
};
const DEFAULT_LINK_COLOR = "#9aa0aa";

/** Confidence → hue across red (0) to green (100). */
export function knowledgeConfidenceColor(pct: number): string {
  const p = Math.max(0, Math.min(100, pct));
  return `hsl(${Math.round(p * 1.2)}, 80%, 55%)`;
}

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

/** Stable color per domain: fixed base domains, hashed hue for the rest. */
export function knowledgeDomainColor(domain: string): string {
  const base = BASE_DOMAIN_COLOR[domain];
  if (base) return base;
  let h = 0;
  for (let i = 0; i < domain.length; i++) h = (h * 31 + domain.charCodeAt(i)) | 0;
  return EXTENSION_PALETTE[Math.abs(h) % EXTENSION_PALETTE.length] ?? "#6ea8fe";
}

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

export interface KnowledgeGraphProps {
  readonly fetchOverview: KnowledgeWindowFetcher;
  readonly fetchCitationLinks: KnowledgeCitationFetcher;
  readonly renderer: ComponentType<KnowledgeGraphRendererProps>;
  /** SSR seed for the first overview window. */
  readonly initialData?: KnowledgeBrowsePage | undefined;
  readonly selectedId: string | null;
  /** Select an atom (graph click or exact id), or `null` to clear focus. */
  readonly onSelect: (id: string | null) => void;
  /** The selected atom's row, from the node's detail read, so it is drawn even off the overview. */
  readonly selected?: KnowledgeSummary | null;
  readonly staleTime?: number;
  readonly queryKeyPrefix?: readonly unknown[];
  /** Classes of the canvas container (e.g. the node's height token). */
  readonly canvasClassName?: string;
}

export function KnowledgeGraph({
  fetchOverview,
  fetchCitationLinks,
  renderer: Renderer,
  initialData,
  selectedId,
  onSelect,
  selected = null,
  staleTime,
  queryKeyPrefix,
  canvasClassName,
}: KnowledgeGraphProps): ReactElement {
  const overview = useKnowledgeOverview({
    fetchOverview,
    initialData,
    ...(staleTime !== undefined && { staleTime }),
    ...(queryKeyPrefix && { queryKeyPrefix }),
  });
  const focus = useGraphFocus({ id: selectedId, fetchCitationLinks });
  const [colorMode, setColorMode] = useState<KnowledgeGraphColorMode>(
    "confidence",
  );
  const [entryId, setEntryId] = useState("");
  const page = overview.page;
  const data = useMemo(
    () =>
      knowledgeFocusGeometry(
        page?.items ?? [],
        selected && selected.id === selectedId ? selected : null,
        { links: focus.links },
      ),
    [page, selected, selectedId, focus.links],
  );

  const nodeColor = useCallback(
    (node: KnowledgeGraphNode) =>
      colorMode === "domain"
        ? knowledgeDomainColor(node.domain)
        : knowledgeConfidenceColor(node.confidencePct ?? 40),
    [colorMode],
  );
  const nodeVal = useCallback(
    (node: KnowledgeGraphNode) => 2 + (node.confidencePct ?? 40) / 22,
    [],
  );
  const nodeLabel = useCallback((node: KnowledgeGraphNode) => {
    const meta = `${escapeHtml(node.id)} · ${escapeHtml(node.entryType)} · ${node.confidencePct ?? "?"}%`;
    return `<div style="max-width:240px"><b>${escapeHtml(node.title)}</b><br/><span style="opacity:.6">${meta}</span></div>`;
  }, []);
  const linkColor = useCallback(
    (link: KnowledgeGraphLink) =>
      KNOWLEDGE_CITATION_COLORS[link.citationType] ?? DEFAULT_LINK_COLOR,
    [],
  );
  const onNodeClick = useCallback(
    (node: KnowledgeGraphNode) => onSelect(node.id),
    [onSelect],
  );

  // Size the canvas to its container.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () =>
      setSize({ width: el.clientWidth, height: el.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <div
          role="group"
          aria-label="Graph color mode"
          className="inline-flex items-center rounded-lg border border-border/60 bg-muted/40 p-0.5"
        >
          {(["confidence", "domain"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={colorMode === mode}
              onClick={() => setColorMode(mode)}
              className={cn(
                "rounded-md px-3 py-1 text-xs capitalize transition-colors",
                colorMode === mode
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {mode}
            </button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (entryId) onSelect(entryId);
          }}
        >
          <input
            aria-label="Knowledge ID"
            placeholder="Open exact knowledge ID"
            value={entryId}
            onChange={(event) => setEntryId(event.target.value)}
            className="rounded border bg-background px-2 text-xs"
          />
          <button type="submit" className="text-xs underline">
            Open entry
          </button>
        </form>
        <span className="text-muted-foreground text-xs">
          {page?.items.length ?? "…"} overview nodes · {focus.links.length}{" "}
          current links
        </span>
        <button
          type="button"
          className="text-xs underline disabled:no-underline disabled:opacity-50"
          disabled={!overview.canPrevious}
          onClick={overview.previous}
        >
          Previous overview
        </button>
        <button
          type="button"
          className="text-xs underline"
          onClick={overview.restart}
        >
          Restart overview
        </button>
        {overview.restartNeeded && (
          <span role="status" className="text-xs">
            Knowledge changed. Restart overview to begin a new live traversal.
          </span>
        )}
        {page && (
          <span className="text-xs">
            Observed revision: {page.revision} · live read
          </span>
        )}
        <button
          type="button"
          className="text-xs underline disabled:no-underline disabled:opacity-50"
          disabled={!overview.canNext}
          onClick={overview.next}
        >
          More overview
        </button>
      </div>

      <div
        ref={wrapRef}
        className={cn(
          "relative h-[32rem] w-full overflow-hidden rounded-lg border border-border/60 bg-background",
          canvasClassName,
        )}
      >
        {page && (
          <Renderer
            graphData={data}
            width={size.width}
            height={size.height}
            nodeColor={nodeColor}
            nodeVal={nodeVal}
            nodeLabel={nodeLabel}
            linkColor={linkColor}
            onNodeClick={onNodeClick}
          />
        )}
        <KnowledgeGraphLegend
          colorMode={colorMode}
          edges={data.links}
          domains={[...new Set(data.nodes.map((n) => n.domain).filter(Boolean))]}
        />
      </div>

      {Boolean(overview.error) && (
        <p role="alert">
          Could not load overview.{" "}
          <button type="button" className="underline" onClick={overview.retry}>
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
              <button type="button" className="underline" onClick={focus.retry}>
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
              <a href={link.source.href}>{link.source.title ?? link.source.id}</a>{" "}
              →{" "}
              <a href={link.target.href}>{link.target.title ?? link.target.id}</a>
            </div>
          ))}
          <div className="flex gap-3">
            <button
              type="button"
              className="underline disabled:no-underline disabled:opacity-50"
              disabled={!focus.nextCursor || focus.pending || focus.error}
              onClick={focus.more}
            >
              More focus links
            </button>
            <button
              type="button"
              className="underline disabled:no-underline disabled:opacity-50"
              disabled={focus.pending}
              onClick={focus.restart}
            >
              Restart focus
            </button>
            <button
              type="button"
              className="underline"
              onClick={() => onSelect(null)}
            >
              Clear focus
            </button>
          </div>
        </div>
      )}
    </>
  );
}

const SECTION_CLASS =
  "mb-1.5 font-medium text-[0.6875rem] text-muted-foreground uppercase tracking-wider";

function KnowledgeGraphLegend({
  colorMode,
  edges,
  domains,
}: {
  readonly colorMode: KnowledgeGraphColorMode;
  readonly edges: readonly { readonly citationType: string }[];
  readonly domains: readonly string[];
}): ReactElement {
  const citeTypes = [...new Set(edges.map((e) => e.citationType))];
  const ramp = [0, 25, 50, 75, 100];
  return (
    <div className="absolute bottom-3 left-3 w-52 rounded-lg border border-border/60 bg-background/80 p-3 backdrop-blur">
      <p className="mb-2.5 font-medium text-foreground text-sm tabular-nums">
        {edges.length} citation{edges.length === 1 ? "" : "s"} · {domains.length}{" "}
        domain{domains.length === 1 ? "" : "s"}
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
                  style={{ backgroundColor: knowledgeConfidenceColor(p) }}
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
                style={{ backgroundColor: knowledgeDomainColor(d) }}
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
              style={{
                borderColor: KNOWLEDGE_CITATION_COLORS[ct] ?? DEFAULT_LINK_COLOR,
              }}
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
