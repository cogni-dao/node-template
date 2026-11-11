// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/knowledge-graph`
 * Purpose: The knowledge Graph capability with the original node-template graph controls (Confidence | Domain colour toggle, "Domain hubs" toggle, bottom-left legend) plus instant Domain and Type dropdowns, over every entry and citation of the corpus (task.0059).
 * Scope: Client view over `useKnowledgeGraph`. The node injects its fetcher, a `renderer` (normally the package's `KnowledgeForceGraph3D` from `./graph-3d`, lazy-loaded) and what selecting opens (its detail sheet, via `selectedId` / `onSelect`).
 * Invariants:
 *   - HEADER_ROW: in order, Confidence (default) | Domain toggle, "Domain hubs" (checked), a Domain dropdown ("All domains", then "<domain> · <exact count>") and, when the data has entry types, a Type dropdown ("All types", "<type> · <exact count>"). Dropdowns apply on select; there are no free-text inputs or apply buttons. Toggle, checkbox and legend keep the pre-#264 GraphView classes and copy.
 *   - ACCURATE_COUNTS: `onEntriesChange` reports the exact shown and total entry counts so the page subtitle reads "Showing X of N entries" when narrowed; the legend states exact citation and domain counts.
 *   - NARROWING_IS_CLIENT_SIDE: dropdowns narrow the loaded corpus (entries, the citations between them, and their hubs); they never fetch.
 *   - WHOLE_CORPUS: every entry and every citation is drawn; domain hubs are synthetic visual anchors added on top (one per domain plus faint membership links), never replacing or hiding entries.
 *   - HIGHLIGHT_FROM_MEMORY: selecting an entry highlights it, its neighbours and its domain hub from the loaded edge set and dims the rest; no request. Hubs are not selectable.
 *   - STABLE_LAYOUT: the renderer's `graphData` changes only with the revision or the hubs toggle, never with selection or colour mode.
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.js";
import {
  type KnowledgeGraphFetcher,
  useKnowledgeGraph,
} from "./use-knowledge-graph.js";

type GraphEntry = KnowledgeGraphResponse["nodes"][number];

/** A drawn node: an entry, or a synthetic domain hub when hubs are shown. */
export interface KnowledgeGraphNode extends GraphEntry {
  readonly isHub: boolean;
  /** Hubs only: the domain's exact entry count. */
  readonly entryCount?: number;
}

/** A drawn link. Force renderers replace `source`/`target` ids with node objects in place. */
export interface KnowledgeGraphLink {
  readonly id: string;
  source: string | { readonly id: string };
  target: string | { readonly id: string };
  /** `cite`: a real citation. `member`: a synthetic entry→hub link. */
  readonly kind: "cite" | "member";
  readonly citationType?: string;
}

export type KnowledgeGraphColorMode = "confidence" | "domain";

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
const MEMBER_LINK_COLOR = "rgba(120,128,140,.18)";
// Domain hubs are structural anchors, not a classifier — neutral in Confidence mode.
const HUB_COLOR = "#94a3b8";
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

/** Stable colour per domain: fixed base domains, hashed hue for the rest. */
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

const endpoint = (end: KnowledgeGraphLink["source"]) =>
  typeof end === "string" ? end : end.id;
const hubId = (domain: string) => `domain:${domain}`;
/** Radix Select reserves "" — the "All" option uses this value. */
const ALL = "__all__";

export interface KnowledgeGraphRenderOptions {
  readonly hubs: boolean;
  /** One domain, or "" for all. */
  readonly domain?: string;
  /** One entry type, or "" for all. */
  readonly entryType?: string;
}

/** Shown and total entry counts, exact for the loaded revision. */
export interface KnowledgeGraphEntriesSummary {
  readonly shown: number;
  readonly total: number;
  /** True while a Domain or Type dropdown narrows the graph. */
  readonly narrowed: boolean;
}

/** "<value> · <exact count>" options, sorted by value. */
function facet(
  nodes: readonly GraphEntry[],
  pick: (node: GraphEntry) => string,
): [string, number][] {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const value = pick(node);
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Fresh renderer data: the entries matching the domain and type (all by
 * default), the citations between them, plus synthetic domain hubs when `hubs`
 * is on. Nothing is sampled or capped.
 */
export function knowledgeGraphRenderData(
  graph: Pick<KnowledgeGraphResponse, "nodes" | "edges">,
  { hubs, domain = "", entryType = "" }: KnowledgeGraphRenderOptions,
): KnowledgeGraphRendererProps["graphData"] {
  const visible =
    domain || entryType
      ? graph.nodes.filter(
          (node) =>
            (!domain || node.domain === domain) &&
            (!entryType || node.entryType === entryType),
        )
      : graph.nodes;
  const ids = visible === graph.nodes ? null : new Set(visible.map((n) => n.id));
  const entries: KnowledgeGraphNode[] = visible.map((node) => ({
    ...node,
    isHub: false,
  }));
  const edges = ids
    ? graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
    : graph.edges;
  const links: KnowledgeGraphLink[] = edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    kind: "cite",
    citationType: edge.citationType,
  }));
  if (!hubs) return { nodes: entries, links };
  const perDomain = new Map<string, number>();
  for (const node of visible)
    perDomain.set(node.domain, (perDomain.get(node.domain) ?? 0) + 1);
  const hubNodes: KnowledgeGraphNode[] = [...perDomain].map(
    ([domain, entryCount]) => ({
      id: hubId(domain),
      domain,
      title: domain,
      entryType: "",
      confidencePct: null,
      sourceType: "",
      isHub: true,
      entryCount,
    }),
  );
  const memberLinks: KnowledgeGraphLink[] = visible.map((node) => ({
    id: `member:${node.id}`,
    source: hubId(node.domain),
    target: node.id,
    kind: "member",
  }));
  return { nodes: [...hubNodes, ...entries], links: [...memberLinks, ...links] };
}

export interface KnowledgeGraphProps {
  readonly fetchGraph: KnowledgeGraphFetcher;
  readonly renderer: ComponentType<KnowledgeGraphRendererProps>;
  readonly selectedId: string | null;
  /** Select an entry (graph click), or `null` to clear. */
  readonly onSelect: (id: string | null) => void;
  readonly staleTime?: number;
  readonly queryKeyPrefix?: readonly unknown[];
  /** Classes of the canvas container (e.g. the node's height token). */
  readonly canvasClassName?: string;
  /** Exact shown/total entry counts whenever the graph or the narrowing changes (`null` until loaded). */
  readonly onEntriesChange?: (summary: KnowledgeGraphEntriesSummary | null) => void;
}

export function KnowledgeGraph({
  fetchGraph,
  renderer: Renderer,
  selectedId,
  onSelect,
  staleTime,
  queryKeyPrefix,
  canvasClassName,
  onEntriesChange,
}: KnowledgeGraphProps): ReactElement {
  const { graph, neighbors, error } = useKnowledgeGraph({
    fetchGraph,
    ...(staleTime !== undefined && { staleTime }),
    ...(queryKeyPrefix && { queryKeyPrefix }),
  });
  const [colorMode, setColorMode] =
    useState<KnowledgeGraphColorMode>("confidence");
  const [showHubs, setShowHubs] = useState(true);
  const [domain, setDomain] = useState("");
  const [entryType, setEntryType] = useState("");
  const domainOptions = useMemo(
    () => (graph ? facet(graph.nodes, (node) => node.domain) : []),
    [graph],
  );
  const typeOptions = useMemo(
    () => (graph ? facet(graph.nodes, (node) => node.entryType) : []),
    [graph],
  );
  const data = useMemo(
    () =>
      graph
        ? knowledgeGraphRenderData(graph, { hubs: showHubs, domain, entryType })
        : null,
    [graph, showHubs, domain, entryType],
  );
  const shown = data?.nodes.filter((node) => !node.isHub).length ?? 0;
  const total = graph?.nodes.length;
  const report = useRef(onEntriesChange);
  useEffect(() => {
    report.current = onEntriesChange;
  });
  const narrowed = Boolean(domain || entryType);
  useEffect(() => {
    report.current?.(
      total === undefined ? null : { shown, total, narrowed },
    );
  }, [shown, total, narrowed]);
  const highlighted = useMemo(() => {
    if (!selectedId) return null;
    const set = new Set([selectedId, ...(neighbors.get(selectedId) ?? [])]);
    const domain = graph?.nodes.find((node) => node.id === selectedId)?.domain;
    if (domain !== undefined) set.add(hubId(domain));
    return set;
  }, [selectedId, neighbors, graph]);

  const nodeColor = useCallback(
    (node: KnowledgeGraphNode) => {
      if (highlighted && !highlighted.has(node.id)) return DIMMED;
      if (colorMode === "domain") return knowledgeDomainColor(node.domain);
      if (node.isHub) return HUB_COLOR;
      return knowledgeConfidenceColor(node.confidencePct ?? 40);
    },
    [colorMode, highlighted],
  );
  const nodeVal = useCallback(
    (node: KnowledgeGraphNode) =>
      node.isHub ? 22 : 2 + (node.confidencePct ?? 40) / 22,
    [],
  );
  const nodeLabel = useCallback((node: KnowledgeGraphNode) => {
    if (node.isHub)
      return `<b>${escapeHtml(node.domain)}</b> · ${node.entryCount ?? 0} entries`;
    const meta = `${escapeHtml(node.id)} · ${escapeHtml(node.entryType)} · ${node.confidencePct ?? "?"}%`;
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
      if (link.kind === "member") return MEMBER_LINK_COLOR;
      return (
        KNOWLEDGE_CITATION_COLORS[link.citationType ?? ""] ?? DEFAULT_LINK_COLOR
      );
    },
    [selectedId],
  );
  const onNodeClick = useCallback(
    (node: KnowledgeGraphNode) => {
      if (!node.isHub) onSelect(node.id);
    },
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

  if (error) {
    return (
      <p className="py-8 text-center text-destructive">
        Failed to load knowledge graph.
      </p>
    );
  }

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
              className={`rounded-md px-3 py-1 text-xs capitalize transition-colors ${
                colorMode === mode
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {mode}
            </button>
          ))}
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-muted-foreground text-xs">
          <input
            type="checkbox"
            checked={showHubs}
            onChange={(event) => setShowHubs(event.target.checked)}
            className="size-3.5 accent-primary"
          />
          Domain hubs
        </label>
        <Select
          value={domain || ALL}
          onValueChange={(value) => setDomain(value === ALL ? "" : value)}
          disabled={!graph}
        >
          <SelectTrigger
            aria-label="Domain"
            className="w-full min-w-0 sm:w-56"
          >
            <SelectValue placeholder="All domains" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All domains</SelectItem>
            {domainOptions.map(([value, n]) => (
              <SelectItem key={value} value={value}>
                {value} · {n.toLocaleString("en-US")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {typeOptions.length > 0 && (
          <Select
            value={entryType || ALL}
            onValueChange={(value) => setEntryType(value === ALL ? "" : value)}
          >
            <SelectTrigger aria-label="Type" className="w-full min-w-0 sm:w-44">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All types</SelectItem>
              {typeOptions.map(([value, n]) => (
                <SelectItem key={value} value={value}>
                  {value} · {n.toLocaleString("en-US")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div
        ref={wrapRef}
        className={cn(
          "relative h-[var(--height-knowledge-graph)] w-full overflow-hidden rounded-lg border border-border/60 bg-background",
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
        <GraphLegend
          colorMode={colorMode}
          edges={graph?.edges ?? []}
          domains={graph?.domains ?? []}
        />
      </div>
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
  readonly colorMode: KnowledgeGraphColorMode;
  readonly edges: ReadonlyArray<{ citationType: string }>;
  readonly domains: ReadonlyArray<string>;
}): ReactElement {
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
