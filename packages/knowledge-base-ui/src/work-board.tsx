// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/work-board`
 * Purpose: Read-only ReUI board projection of a node's already filtered, sorted page of work items, shared across the fleet (task.0041).
 * Scope: Pure presentation. The consuming node owns data loading, URL state, routing and authentication; it injects navigation through `onOpenItem` and, optionally, `goalHref` / `renderGoalLink`.
 * Invariants:
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

import {
  Kanban,
  KanbanBoard,
  KanbanColumn,
  KanbanColumnContent,
} from "./reui-kanban.js";
import { RelativeTime } from "./relative-time.js";
import { StatusPill, TypeIcon } from "./work-item-icons.js";

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

export interface WorkBoardProps<TItem extends WorkBoardItem> {
  readonly items: readonly TItem[];
  readonly statuses: readonly string[];
  readonly isLoading: boolean;
  readonly onOpenItem: (item: TItem) => void;
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

function firstGoal(
  labels: readonly string[],
): { slug: string; label: string } | undefined {
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

function BoardSkeleton({ className }: { readonly className: string }) {
  return (
    <div className={`animate-pulse rounded-md bg-primary/10 ${className}`} />
  );
}

export function WorkBoard<TItem extends WorkBoardItem>({
  items,
  statuses,
  isLoading,
  onOpenItem,
  goalHref = defaultGoalHref,
  renderGoalLink = defaultGoalLink,
}: WorkBoardProps<TItem>): ReactElement {
  const columns = useMemo(() => {
    const result: Record<string, TItem[]> = Object.fromEntries(
      statuses.map((status) => [status, []]),
    );
    for (const item of items) {
      result[item.status]?.push(item);
    }
    return result;
  }, [items, statuses]);

  return (
    <Kanban
      value={columns}
      onValueChange={() => {}}
      getItemValue={(item) => item.id}
    >
      <KanbanBoard
        className="flex items-start gap-4 overflow-x-auto pb-4"
        aria-label="Work board"
        role="region"
      >
        {Object.entries(columns).map(([status, cards]) => (
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
                title={`${cards.length} items on this page`}
              >
                {cards.length}
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
                  No items on this page
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
                        aria-label={`${item.id}: ${item.title}`}
                      >
                        <span className="flex w-full items-center justify-between gap-2">
                          <span
                            className="shrink-0 font-mono text-muted-foreground text-xs"
                            title="Rank score"
                          >
                            {score === undefined
                              ? "Unscored"
                              : `Rank ${score.toFixed(1)}`}
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
            </KanbanColumnContent>
          </KanbanColumn>
        ))}
      </KanbanBoard>
    </Kanban>
  );
}
