// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** ReUI board projection of the existing table's filtered, sorted page. */
"use client";

import type { WorkItemDto } from "@cogni/node-contracts";
import { Skeleton } from "@cogni/node-ui-kit/shadcn/skeleton";
import { rankScore } from "@cogni/work-items";
import { useMemo } from "react";
import {
  Kanban,
  KanbanBoard,
  KanbanColumn,
  KanbanColumnContent,
  KanbanItem,
} from "./reui-kanban";
import { StatusPill, TypeIcon } from "./work-item-icons";

interface WorkKanbanProps {
  readonly items: readonly WorkItemDto[];
  readonly statuses: readonly string[];
  readonly isLoading: boolean;
  readonly onOpenItem: (item: WorkItemDto) => void;
}

export function WorkKanban({
  items,
  statuses,
  isLoading,
  onOpenItem,
}: WorkKanbanProps) {
  const columns = useMemo(() => {
    const result: Record<string, WorkItemDto[]> = Object.fromEntries(
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
                  <Skeleton className="h-32 rounded-lg" />
                  <Skeleton className="h-28 rounded-lg" />
                </>
              ) : cards.length === 0 ? (
                <p className="rounded-lg border border-dashed px-3 py-8 text-center text-muted-foreground text-xs">
                  No items on this page
                </p>
              ) : (
                cards.map((item) => {
                  const score = rankScore(item.scores);
                  return (
                    <KanbanItem key={item.id} value={item.id} asChild>
                      <button
                        type="button"
                        onClick={() => onOpenItem(item)}
                        className="flex w-full flex-col gap-3 rounded-lg border bg-card p-4 text-left shadow-xs transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={`${item.id}: ${item.title}`}
                      >
                        <span className="flex w-full items-center justify-between gap-2">
                          <span className="flex items-center gap-2">
                            <TypeIcon type={item.type} />
                            <span className="font-mono text-muted-foreground text-xs">
                              {item.id}
                            </span>
                          </span>
                          {item.priority != null && (
                            <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground text-xs">
                              P{item.priority}
                            </span>
                          )}
                        </span>
                        <span className="line-clamp-3 font-medium text-sm leading-relaxed">
                          {item.title}
                        </span>
                        <span className="flex w-full items-center justify-between gap-3 text-muted-foreground text-xs">
                          <span className="truncate">
                            {item.projectId?.replace("proj.", "") ?? ""}
                          </span>
                          <span
                            className="shrink-0 font-mono"
                            title="Rank score"
                          >
                            {score === undefined
                              ? "Unscored"
                              : `Rank ${score.toFixed(1)}`}
                          </span>
                        </span>
                      </button>
                    </KanbanItem>
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
