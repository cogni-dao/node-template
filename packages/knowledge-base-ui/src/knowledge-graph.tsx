// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/knowledge-graph`
 * Purpose: The knowledge Graph capability: every entry and every citation of the corpus, drawn at once with exact counts, domain/confidence coloring, client-side narrowing, in-memory neighbor highlighting and exact-id open (task.0059).
 * Scope: Client view over `useKnowledgeGraph`. The node injects its fetcher, a `renderer` (normally the package's `KnowledgeForceGraph3D` from `./graph-3d`, lazy-loaded) and what selecting opens (its detail sheet, via `selectedId` / `onSelect`).
 * Invariants:
 *   - ACCURATE_COUNTS: the header states the exact entry and citation counts of the loaded revision ("5,046 entries · 12,300 citations"); when narrowed, "Showing X of N".
 *   - WHOLE_CORPUS: nothing is capped, paged or sampled; narrowing filters the loaded set client-side and never fetches.
 *   - HIGHLIGHT_FROM_MEMORY: selecting an entry highlights it and its neighbors from the loaded edge set and dims the rest; no request.
 *   - STABLE_LAYOUT: the renderer's `graphData` changes only with the revision or the narrowing, never with selection or color mode, so selecting does not restart the simulation.
 *   - LABELS_ESCAPED: `nodeLabel` returns HTML with every agent-authored string escaped.
 * Side-effects: IO (through the injected fetcher)
 * Links: task.0059
 * @public
 */

"use client";

import type { KnowledgeGraphResponse } from "@cogni/knowledge-store/contracts";
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
import {
  type KnowledgeGraphFetcher,
  useKnowledgeGraph,
} from "./use-knowledge-graph.js";

export type KnowledgeGraphNode = KnowledgeGraphResponse["nodes"][number];

/** A drawn edge. Force renderers replace `source`/`target` ids with node objects in place. */
export interface KnowledgeGraphLink {
  readonly id: string;
  source: string | { readonly id: string };
  target: string | { readonly id: string };
  readonly citationType: string;
}

export type KnowledgeGraphColorMode = "domain" | "confidence";

/** What a drawing engine receives. `graphData` holds fresh objects the engine may mutate. */
export interface KnowledgeGraphRendererProps {
  readonly graphData: {
    readonly nodes: KnowledgeGraphNode[];
    readonly links: KnowledgeGraphLink[];
  };
  readonly width: number;
  readonly height: number;
  readonly nodeColor: (node: KnowledgeGraphNode) => string;
  readonly nodeVal: (node: KnowledgeGraphNode) => number;
  /** Escaped HTML tooltip, shown on hover. */
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
const DIMMED = "rgba(100,116,139,0.18)";

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

const count = (n: number) => n.toLocaleString("en-US");
const endpoint = (end: KnowledgeGraphLink["source"]) =>
  typeof end === "string" ? end : end.id;

export interface KnowledgeGraphNarrowing {
  /** Case-insensitive match on id, title, domain or entry type. */
  readonly text: string;
  /** One domain, or "" for all. */
  readonly domain: string;
}

/** The narrowed subgraph as fresh objects: matching entries and the citations between them. */
export function narrowKnowledgeGraph(
  graph: Pick<KnowledgeGraphResponse, "nodes" | "edges">,
  { text, domain }: KnowledgeGraphNarrowing,
): KnowledgeGraphRendererProps["graphData"] {
  const needle = text.trim().toLowerCase();
  const nodes = graph.nodes
    .filter(
      (node) =>
        (!domain || node.domain === domain) &&
        (!needle ||
          [node.id, node.title, node.domain, node.entryType].some((value) =>
            value.toLowerCase().includes(needle),
          )),
    )
    .map((node) => ({ ...node }));
  const visible = new Set(nodes.map((node) => node.id));
  const links = graph.edges
    .filter((edge) => visible.has(edge.source) && visible.has(edge.target))
    .map((edge) => ({ ...edge }));
  return { nodes, links };
}

export interface KnowledgeGraphProps {
  readonly fetchGraph: KnowledgeGraphFetcher;
  readonly renderer: ComponentType<KnowledgeGraphRendererProps>;
  readonly selectedId: string | null;
  /** Select an entry (graph click or exact id), or `null` to clear. */
  readonly onSelect: (id: string | null) => void;
  readonly staleTime?: number;
  readonly queryKeyPrefix?: readonly unknown[];
  /** Classes of the canvas container (e.g. the node's height token). */
  readonly canvasClassName?: string;
}

export function KnowledgeGraph({
  fetchGraph,
  renderer: Renderer,
  selectedId,
  onSelect,
  staleTime,
  queryKeyPrefix,
  canvasClassName,
}: KnowledgeGraphProps): ReactElement {
  const { graph, neighbors, isLoading, error, retry } = useKnowledgeGraph({
    fetchGraph,
    ...(staleTime !== undefined && { staleTime }),
    ...(queryKeyPrefix && { queryKeyPrefix }),
  });
  const [colorMode, setColorMode] = useState<KnowledgeGraphColorMode>("domain");
  const [draft, setDraft] = useState("");
  const [narrowing, setNarrowing] = useState<KnowledgeGraphNarrowing>({
    text: "",
    domain: "",
  });
  const [entryId, setEntryId] = useState("");
  const data = useMemo(
    () => (graph ? narrowKnowledgeGraph(graph, narrowing) : null),
    [graph, narrowing],
  );
  const highlighted = useMemo(() => {
    if (!selectedId) return null;
    return new Set([selectedId, ...(neighbors.get(selectedId) ?? [])]);
  }, [selectedId, neighbors]);

  const nodeColor = useCallback(
    (node: KnowledgeGraphNode) => {
      if (highlighted && !highlighted.has(node.id)) return DIMMED;
      return colorMode === "domain"
        ? knowledgeDomainColor(node.domain)
        : knowledgeConfidenceColor(node.confidencePct ?? 40);
    },
    [colorMode, highlighted],
  );
  const nodeVal = useCallback(
    (node: KnowledgeGraphNode) =>
      node.id === selectedId ? 8 : 2 + (node.confidencePct ?? 40) / 40,
    [selectedId],
  );
  const nodeLabel = useCallback((node: KnowledgeGraphNode) => {
    const meta = `${escapeHtml(node.id)} · ${escapeHtml(node.domain)} · ${escapeHtml(node.entryType)} · ${node.confidencePct ?? "?"}%`;
    return `<div style="max-width:240px"><b>${escapeHtml(node.title)}</b><br/><span style="opacity:.6">${meta}</span></div>`;
  }, []);
  const linkColor = useCallback(
    (link: KnowledgeGraphLink) => {
      if (
        selectedId &&
        endpoint(link.source) !== selectedId &&
        endpoint(link.target) !== selectedId
      )
        return DIMMED;
      return KNOWLEDGE_CITATION_COLORS[link.citationType] ?? DEFAULT_LINK_COLOR;
    },
    [selectedId],
  );
  const onNodeClick = useCallback(
    (node: KnowledgeGraphNode) => onSelect(node.id),
    [onSelect],
  );

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

  const narrowed = Boolean(narrowing.text || narrowing.domain);
  const selected = selectedId
    ? graph?.nodes.find((node) => node.id === selectedId)
    : undefined;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <div
          role="group"
          aria-label="Graph color mode"
          className="inline-flex items-center rounded-lg border border-border/60 bg-muted/40 p-0.5"
        >
          {(["domain", "confidence"] as const).map((mode) => (
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
          role="search"
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setNarrowing((current) => ({ ...current, text: draft }));
          }}
        >
          <input
            aria-label="Filter graph"
            placeholder="Filter by id, title, domain, type"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="rounded border bg-background px-2 py-1 text-xs"
          />
          <button type="submit" className="text-xs underline">
            Filter
          </button>
        </form>
        <select
          aria-label="Graph domain"
          value={narrowing.domain}
          onChange={(event) =>
            setNarrowing((current) => ({ ...current, domain: event.target.value }))
          }
          className="rounded border bg-background px-2 py-1 text-xs"
        >
          <option value="">All domains</option>
          {(graph?.domains ?? []).map((domain) => (
            <option key={domain} value={domain}>
              {domain}
            </option>
          ))}
        </select>
        {narrowed && (
          <button
            type="button"
            className="text-xs underline"
            onClick={() => {
              setDraft("");
              setNarrowing({ text: "", domain: "" });
            }}
          >
            Show all
          </button>
        )}
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
            className="rounded border bg-background px-2 py-1 text-xs"
          />
          <button type="submit" className="text-xs underline">
            Open entry
          </button>
        </form>
      </div>
      <p className="text-muted-foreground text-xs" role="status">
        {graph && data
          ? narrowed
            ? `Showing ${count(data.nodes.length)} of ${count(graph.nodes.length)} entries · ${count(data.links.length)} of ${count(graph.edges.length)} citations`
            : `${count(graph.nodes.length)} entries · ${count(graph.edges.length)} citations`
          : isLoading
            ? "Loading graph…"
            : "Graph not loaded"}
        {graph && ` · revision ${graph.revision.slice(0, 12)}`}
      </p>
      <div
        ref={wrapRef}
        className={cn(
          "relative h-[32rem] w-full overflow-hidden rounded-lg border border-border/60 bg-background",
          canvasClassName,
        )}
      >
        {data && (
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
        {data && (
          <KnowledgeGraphLegend
            colorMode={colorMode}
            data={data}
          />
        )}
      </div>
      {Boolean(error) && (
        <p role="alert">
          Could not load the graph.{" "}
          <button type="button" className="underline" onClick={retry}>
            Retry graph
          </button>
        </p>
      )}
      {selectedId && (
        <p className="text-xs">
          Selected: {selected?.title ?? selectedId} ·{" "}
          {count(neighbors.get(selectedId)?.size ?? 0)} connected entries{" "}
          <button
            type="button"
            className="underline"
            onClick={() => onSelect(null)}
          >
            Clear selection
          </button>
        </p>
      )}
    </>
  );
}

const SECTION_CLASS =
  "mb-1.5 font-medium text-[0.6875rem] text-muted-foreground uppercase tracking-wider";

function KnowledgeGraphLegend({
  colorMode,
  data,
}: {
  readonly colorMode: KnowledgeGraphColorMode;
  readonly data: KnowledgeGraphRendererProps["graphData"];
}): ReactElement {
  const domains = useMemo(
    () => [...new Set(data.nodes.map((node) => node.domain))].sort(),
    [data],
  );
  const citeTypes = useMemo(
    () => [...new Set(data.links.map((link) => link.citationType))].sort(),
    [data],
  );
  const ramp = [0, 25, 50, 75, 100];
  return (
    <div className="absolute bottom-3 left-3 max-h-[70%] w-52 overflow-y-auto rounded-lg border border-border/60 bg-background/80 p-3 backdrop-blur">
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
          <p className={SECTION_CLASS}>Domains · {count(domains.length)}</p>
          {domains.map((domain) => (
            <div key={domain} className="flex items-center gap-2 text-xs">
              <span
                className="size-2.5 rounded-full"
                style={{ backgroundColor: knowledgeDomainColor(domain) }}
              />
              {domain}
            </div>
          ))}
        </>
      )}
      <p className={`${SECTION_CLASS} mt-2.5`}>Citations</p>
      {citeTypes.length > 0 ? (
        citeTypes.map((type) => (
          <div key={type} className="flex items-center gap-2 text-xs">
            <span
              className="h-0 w-4 border-t-2"
              style={{
                borderColor: KNOWLEDGE_CITATION_COLORS[type] ?? DEFAULT_LINK_COLOR,
              }}
            />
            {type}
          </div>
        ))
      ) : (
        <span className="text-muted-foreground text-xs">none yet</span>
      )}
    </div>
  );
}
