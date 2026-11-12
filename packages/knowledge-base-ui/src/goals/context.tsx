// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/goals` (context)
 * Purpose: The four things a node injects into the Goals capability, shared by the board, its chart and the evidence view without prop drilling: the read client, the query key prefix, link targets and the link component.
 * Scope: Defaults work for a node that mounts the metrics routes at `/api/v1/metrics` and the Knowledge pages at `/knowledge`; every default is replaceable.
 * Invariants: NO_ROUTER_IMPORT (links are an injected component, `<a>` by default); NO_HIDDEN_FETCH (the client is the only network path).
 * Side-effects: none
 * Links: ./client.ts
 * @internal
 */

"use client";

import {
  type ComponentType,
  type ReactNode,
  createContext,
  useContext,
  useMemo,
} from "react";

import { createGoalsClient, type GoalsClient } from "./client.js";
import { observationHref } from "./presentation.js";

export interface GoalsHrefs {
  /** A goal's entry page. Default `/knowledge/{id}`. */
  readonly goal: (goalId: string) => string;
  /** A metric's entry page. Default `/knowledge/{metricId}`. */
  readonly metric: (metricId: string) => string;
  /** One immutable reading's evidence. Default `/knowledge/{metricId}?observation={observationId}`. */
  readonly observation: (metricId: string, observationId: string) => string;
  /** "how goals work" under an empty board. Default `/knowledge/dao-goals-design`. */
  readonly help: string;
  /** Why a metric that serves no KPI is bloat. Default `/knowledge/goal-metrics-vs-telemetry`. */
  readonly axioms: string;
}

/** Only what the Goals views pass, so `next/link` and a plain anchor both fit under exactOptionalPropertyTypes. */
export interface GoalsLinkProps {
  readonly href: string;
  readonly className?: string;
  readonly "aria-label"?: string;
  readonly children?: ReactNode;
}
/** A router link (for example `next/link`) or the default anchor. */
export type GoalsLinkComponent = ComponentType<GoalsLinkProps>;

export interface GoalsHostOptions {
  /** Read client. Default `createGoalsClient()` against `/api/v1/metrics` with the page's cookie session. */
  readonly client?: GoalsClient;
  /** Prefixed to every query key, to scope or invalidate per node. Default `[]`. */
  readonly queryKeyPrefix?: readonly unknown[];
  readonly hrefs?: Partial<GoalsHrefs>;
  readonly LinkComponent?: GoalsLinkComponent;
}

export interface GoalsContextValue {
  readonly client: GoalsClient;
  readonly queryKeyPrefix: readonly unknown[];
  readonly hrefs: GoalsHrefs;
  readonly Link: GoalsLinkComponent;
}

const DefaultLink: GoalsLinkComponent = (props) => <a {...props} />;

export const DEFAULT_GOALS_HREFS: GoalsHrefs = {
  goal: (goalId) => `/knowledge/${encodeURIComponent(goalId)}`,
  metric: (metricId) => `/knowledge/${encodeURIComponent(metricId)}`,
  observation: observationHref,
  help: "/knowledge/dao-goals-design",
  axioms: "/knowledge/goal-metrics-vs-telemetry",
};

let defaultClient: GoalsClient | undefined;
function sharedDefaultClient(): GoalsClient {
  defaultClient ??= createGoalsClient();
  return defaultClient;
}

const GoalsContext = createContext<GoalsContextValue | null>(null);

export function GoalsProvider({
  client,
  queryKeyPrefix,
  hrefs,
  LinkComponent,
  children,
}: GoalsHostOptions & { readonly children: ReactNode }) {
  const parent = useContext(GoalsContext);
  const value = useMemo<GoalsContextValue>(
    () => ({
      client: client ?? parent?.client ?? sharedDefaultClient(),
      queryKeyPrefix: queryKeyPrefix ?? parent?.queryKeyPrefix ?? [],
      hrefs: { ...(parent?.hrefs ?? DEFAULT_GOALS_HREFS), ...hrefs },
      Link: LinkComponent ?? parent?.Link ?? DefaultLink,
    }),
    [client, queryKeyPrefix, hrefs, LinkComponent, parent]
  );
  return <GoalsContext.Provider value={value}>{children}</GoalsContext.Provider>;
}

const FALLBACK: GoalsContextValue = {
  get client() {
    return sharedDefaultClient();
  },
  queryKeyPrefix: [],
  hrefs: DEFAULT_GOALS_HREFS,
  Link: DefaultLink,
};

export function useGoalsHost(): GoalsContextValue {
  return useContext(GoalsContext) ?? FALLBACK;
}
