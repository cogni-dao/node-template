// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/work-board`
 * Purpose: Read-only ReUI board projection of per-status column pages of work summaries, shared across the fleet (task.0041, task.0055).
 * Scope: Pure presentation. The consuming node owns data loading, URL state, routing and authentication; it injects navigation through `onOpenItem`, column paging through `onLoadMore` and, optionally, `goalHref` / `renderGoalLink`.
 * Invariants:
 *   - COLUMN_PAGES_ONLY: the board renders the column pages it is given; there is no rows-from-a-full-array mode, so an adopter that fetches every item cannot compile against it. A column that has more shows `N+` and a Load more button.
 *   - EMPTY_IS_NOT_END: a column with no cards but `hasMore` (a capped text scan found nothing yet) shows "Search further (N scanned)" and never says "No items".
 *   - NOT_STARTED_LOADS_FIRST_PAGE: a column the board's budget did not reach shows "Load"; `onLoadMore` then fetches its first page.
 *   - ONE_HOVER_SURFACE: each card has one hover/focus surface; the open button stretches over the card and only the goal link sits above it.
 *   - ONE_GOAL_LINK: at most one goal pointer per card, from a `goal:<slug>` or `goal:goal-<slug>` label with a safe kebab-case slug.
 *   - RANK_FROM_PACKAGE: the rank label comes from `@cogni/work-items` `rankScore`, never re-derived here.
 *   - SAFE_UPDATED: an unparseable or missing `updatedAt` renders "Updated —" with no `<time>` element.
 * Side-effects: none
 * Links: task.0041, story.0018
 * @public
 */

"use client";

import { rankScore, type WorkItemScores } from "@cogni/work-items";
import { type ReactElement, type ReactNode, useMemo } from "react";

import { Kanban, KanbanBoard, KanbanColumn, KanbanColumnContent } from "./reui-kanban.js";
import { cn } from "./cn.js";
import { RelativeTime } from "./relative-time.js";
import { Button } from "./ui/button.js";
import { StatusPill, TypeIcon } from "./work-item-icons.js";
import { WorkMetricSummary, workMetricVerdict, type WorkMetric } from "./work-metrics.js";

/** The structural subset of a work item the board renders. */
export interface WorkBoardItem {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly status: string;
  readonly labels: readonly string[];
  readonly updatedAt?: string | null | undefined;
  readonly scores?: WorkItemScores | null | undefined;
  readonly projectId?: string | undefined;
  readonly moves?: readonly WorkMetric[] | undefined;
}

/** What a node needs to render a card's goal pointer with its own link component. */
export interface WorkBoardGoalLink {
  /** Goal slug without the `goal-` prefix, e.g. `ai-work-converges`. */
  readonly slug: string;
  /** The original label text, used as the visible link text. */
  readonly label: string;
  readonly href: string;
  readonly className: string;
}

/** One status column: the pages loaded so far and whether the node holds more. */
export interface WorkBoardColumnState<TItem extends WorkBoardItem> {
  readonly status: string;
  readonly items: readonly TItem[];
  /** True while the node can serve a further page for this column. */
  readonly hasMore: boolean;
  /** True while that further page is in flight. */
  readonly isLoadingMore?: boolean | undefined;
  /** True when the board's budget did not reach this column: "Load" fetches its first page. */
  readonly notStarted?: boolean | undefined;
  /** Rows the store has scanned for this column so far (text search). */
  readonly rowsScanned?: number | undefined;
}

export interface WorkBoardProps<TItem extends WorkBoardItem> {
  readonly columns: readonly WorkBoardColumnState<TItem>[];
  readonly isLoading: boolean;
  readonly onOpenItem: (item: TItem) => void;
  /** Requests the next page of one column; the node fetches it and passes it back in `columns`. */
  readonly onLoadMore: (status: string) => void;
  /** Builds a goal link href from its slug. Defaults to `/knowledge/goal-<slug>`. */
  readonly goalHref?: (slug: string) => string;
  /** Renders the goal link, e.g. with a router link. Defaults to a plain `<a>`. */
  readonly renderGoalLink?: (link: WorkBoardGoalLink) => ReactNode;
}

const GOAL_LABEL = /^goal:(?:goal-)?([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const GOAL_LINK_CLASS =
  "relative z-10 truncate underline hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function defaultGoalHref(slug: string): string {
  return `/knowledge/${encodeURIComponent(`goal-${slug}`)}`;
}

function defaultGoalLink(link: WorkBoardGoalLink): ReactNode {
  return (
    <a href={link.href} className={link.className}>
      {link.label}
    </a>
  );
}

export function firstGoal(labels: readonly string[]): { slug: string; label: string } | undefined {
  for (const label of labels) {
    const slug = GOAL_LABEL.exec(label)?.[1];
    if (slug) return { slug, label };
  }
  return undefined;
}

function updatedIso(updatedAt: string | null | undefined): string | undefined {
  if (!updatedAt) return undefined;
  const updated = new Date(updatedAt);
  return Number.isFinite(updated.getTime()) ? updated.toISOString() : undefined;
}

function loadLabel(
  loading: boolean,
  notStarted: boolean,
  cards: number,
  rowsScanned: number | undefined,
): string {
  if (loading) return "Loading…";
  if (notStarted) return "Load";
  if (cards === 0) {
    return rowsScanned
      ? `Search further (${rowsScanned.toLocaleString("en-US")} scanned)`
      : "Search further";
  }
  return "Load more";
}

function BoardSkeleton({ className }: { readonly className: string }) {
  return <div className={cn("animate-pulse rounded-md bg-primary/10", className)} />;
}

export function WorkBoard<TItem extends WorkBoardItem>({
  columns,
  isLoading,
  onOpenItem,
  onLoadMore,
  goalHref = defaultGoalHref,
  renderGoalLink = defaultGoalLink,
}: WorkBoardProps<TItem>): ReactElement {
  const byStatus = useMemo(
    () =>
      Object.fromEntries(columns.map((column) => [column.status, [...column.items]])) as Record<
        string,
        TItem[]
      >,
    [columns],
  );

  return (
    <Kanban value={byStatus} onValueChange={() => {}} getItemValue={(item) => item.id}>
      <KanbanBoard
        className="flex items-start gap-4 overflow-x-auto pb-4"
        aria-label="Work board"
        role="region"
      >
        {columns.map(
          ({ status, items: cards, hasMore, isLoadingMore, notStarted, rowsScanned }) => (
            <KanbanColumn
              key={status}
              value={status}
              disabled
              className="w-72 shrink-0 gap-3 rounded-xl bg-muted/30 p-3 opacity-100"
            >
              <div className="flex items-center justify-between gap-2 px-1">
                <h2>
                  <StatusPill status={status} className="px-0" />
                </h2>
                <span
                  className="font-mono text-muted-foreground text-xs"
                  title={
                    notStarted && cards.length === 0
                      ? "Not loaded yet"
                      : hasMore
                        ? `${cards.length} loaded, more available`
                        : `${cards.length} items`
                  }
                >
                  {notStarted && cards.length === 0
                    ? "–"
                    : hasMore
                      ? `${cards.length}+`
                      : cards.length}
                </span>
              </div>
              <KanbanColumnContent value={status} className="min-h-40 gap-3">
                {isLoading ? (
                  <>
                    <BoardSkeleton className="h-32 rounded-lg" />
                    <BoardSkeleton className="h-28 rounded-lg" />
                  </>
                ) : cards.length === 0 ? (
                  <p className="rounded-lg border border-dashed px-3 py-8 text-center text-muted-foreground text-xs">
                    {notStarted
                      ? "Not loaded yet"
                      : hasMore
                        ? "No matches in the rows searched so far"
                        : "No items"}
                  </p>
                ) : (
                  cards.map((item) => {
                    const score = rankScore(item.scores);
                    const goal = firstGoal(item.labels);
                    return (
                      <div
                        key={item.id}
                        data-slot="kanban-item"
                        className="relative flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-xs transition-colors focus-within:ring-2 focus-within:ring-ring hover:bg-accent/40"
                      >
                        {/* One card, one hover/focus surface: the button stretches over the
                          whole card; only the goal link sits above it. */}
                        <button
                          type="button"
                          onClick={() => onOpenItem(item)}
                          className="flex w-full flex-col gap-3 text-left after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none"
                          aria-label={`${item.id}: ${item.title}${item.moves?.[0] ? `, ${item.moves[0].current?.metricTitle ?? item.moves[0].metricId}: ${workMetricVerdict(item.moves[0])}` : ""}`}
                        >
                          <span className="flex w-full items-center justify-between gap-2">
                            <span
                              className="shrink-0 font-mono text-muted-foreground text-xs"
                              title="Rank score"
                            >
                              {score === undefined ? "Unscored" : `Rank ${score.toFixed(1)}`}
                            </span>
                            <span className="flex items-center gap-2">
                              <TypeIcon type={item.type} />
                              <span className="font-mono text-muted-foreground text-xs">
                                {item.id}
                              </span>
                            </span>
                          </span>
                          <span className="line-clamp-3 font-medium text-sm leading-relaxed">
                            {item.title}
                          </span>
                          {item.moves?.[0] && <WorkMetricSummary move={item.moves[0]} />}
                        </button>
                        <div className="flex items-center justify-between gap-3 text-muted-foreground text-xs">
                          <span className="flex min-w-0 flex-wrap gap-1">
                            {goal
                              ? renderGoalLink({
                                  slug: goal.slug,
                                  label: goal.label,
                                  href: goalHref(goal.slug),
                                  className: GOAL_LINK_CLASS,
                                })
                              : null}
                          </span>
                          <span className="shrink-0">
                            Updated <RelativeTime iso={updatedIso(item.updatedAt)} />
                          </span>
                        </div>
                      </div>
                    );
                  })
                )}
                {!isLoading && (hasMore || notStarted) ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isLoadingMore === true}
                    aria-label={`${notStarted ? "Load" : cards.length === 0 ? "Search further" : "Load more"} ${status}`}
                    onClick={() => onLoadMore(status)}
                  >
                    {loadLabel(
                      isLoadingMore === true,
                      notStarted === true,
                      cards.length,
                      rowsScanned,
                    )}
                  </Button>
                ) : null}
              </KanbanColumnContent>
            </KanbanColumn>
          ),
        )}
      </KanbanBoard>
    </Kanban>
  );
}
