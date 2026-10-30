// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: app/schedules/[scheduleId]/view
 * Purpose: Inspect schedule configuration and execution history; open existing chat threads.
 * Scope: Read UI with pause/resume controls; no execution side effects.
 * Invariants: One row per run; nullable locators stay unavailable; runtime status is not task success.
 * Side-effects: IO (schedule reads and explicit management mutations)
 * Links: https://cognidao.org/work/items/task.5353
 * @public
 */
"use client";
import { presentScheduleRun } from "@cogni/scheduling/presentation";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import Link from "next/link";
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components";
import { fetchSchedule, fetchScheduleHistory } from "../_api/readHistory";
import { updateSchedule } from "../_api/updateSchedule";
import { schedulePrompt } from "../presentation";

export function ScheduleDetailView({ scheduleId }: { scheduleId: string }) {
  const client = useQueryClient();
  const schedule = useQuery({
    queryKey: ["schedule", scheduleId],
    queryFn: () => fetchSchedule(scheduleId),
    staleTime: 30_000,
  });
  const history = useInfiniteQuery({
    queryKey: ["schedule-history", scheduleId],
    queryFn: ({ pageParam }) => fetchScheduleHistory(scheduleId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: !!schedule.data,
    staleTime: 30_000,
  });
  const toggle = useMutation({
    mutationFn: updateSchedule,
    onSuccess: (updated) => {
      client.setQueryData(["schedule", updated.id], updated);
      void client.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
  const refresh = () => {
    void client.resetQueries({ queryKey: ["schedule-history", scheduleId] });
    void schedule.refetch();
  };
  const current = schedule.data;
  const runs = history.data?.pages.flatMap((page) => page.runs) ?? [];
  if (!current)
    return (
      <div className="p-6">
        <Link href="/schedules" className="text-sm underline">
          All schedules
        </Link>
        <p role={schedule.isError ? "alert" : "status"} className="my-4">
          {schedule.error?.message ?? "Loading schedule…"}
        </p>
        {schedule.isError && (
          <Button variant="outline" onClick={() => void schedule.refetch()}>
            Try again
          </Button>
        )}
      </div>
    );
  const prompt = schedulePrompt(current.input);
  return (
    <main className="mx-auto w-full min-w-0 max-w-5xl space-y-6 p-4 md:p-6">
      <Link
        href="/schedules"
        className="text-muted-foreground text-sm hover:underline"
      >
        ← All schedules
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 break-words">
          <h1 className="font-semibold text-2xl">
            {current.graphId.split(":").pop() ?? current.graphId}
          </h1>
          <p className="mt-2 text-muted-foreground text-sm">
            {current.cron} · {current.timezone}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge intent={current.enabled ? "default" : "secondary"}>
            {current.enabled ? "Active" : "Paused"}
          </Badge>
          <Button
            variant="outline"
            disabled={toggle.isPending || schedule.isError}
            onClick={() => {
              if (schedule.isError) return;
              toggle.mutate({
                id: scheduleId,
                data: { enabled: !current.enabled },
              });
            }}
          >
            {toggle.isPending
              ? "Saving…"
              : current.enabled
                ? "Pause"
                : "Resume"}
          </Button>
        </div>
      </div>
      {schedule.isError && (
        <div role="alert" className="text-sm">
          <p>Unable to refresh schedule. Showing previously loaded details.</p>
          <p className="text-destructive">{schedule.error.message}</p>
          <Button
            variant="outline"
            className="mt-2"
            disabled={schedule.isFetching}
            onClick={() => void schedule.refetch()}
          >
            Try again
          </Button>
        </div>
      )}
      {toggle.isError && (
        <p role="alert" className="text-destructive text-sm">
          {toggle.error.message}
        </p>
      )}
      <details className="rounded-lg border p-4">
        <summary className="cursor-pointer font-medium">Instructions</summary>
        <p className="mt-3 whitespace-pre-wrap break-words text-sm">
          {prompt || "No text instructions"}
        </p>
      </details>
      <section aria-label="Run history" className="min-w-0">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="font-semibold text-lg">Run history</h2>
          <Button
            variant="ghost"
            disabled={history.isFetching}
            onClick={() => refresh()}
          >
            Refresh
          </Button>
        </div>
        {history.isError && (
          <div role="alert" className="mb-3 text-sm">
            <p>{history.error.message}</p>
            <Button variant="outline" onClick={() => refresh()}>
              Try again
            </Button>
          </div>
        )}
        {history.isPending ? (
          <output>Loading history…</output>
        ) : !runs.length && !history.isError ? (
          <p className="py-8 text-center text-muted-foreground">No runs yet</p>
        ) : runs.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border">
            <Table className="min-w-[540px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Scheduled time</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Conversation</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => {
                  const row = presentScheduleRun(run, {
                    timezone: current.timezone,
                  });
                  return (
                    <TableRow key={row.id}>
                      <TableCell className="whitespace-nowrap">
                        <time
                          dateTime={row.exactScheduledFor ?? undefined}
                          title={row.exactScheduledFor ?? undefined}
                        >
                          {row.timeLabel}
                        </time>
                      </TableCell>
                      <TableCell>{row.statusLabel}</TableCell>
                      <TableCell>{row.durationLabel}</TableCell>
                      <TableCell>
                        {row.conversationKey ? (
                          <Link
                            className="underline"
                            href={`/chat?thread=${encodeURIComponent(row.conversationKey)}`}
                          >
                            Open conversation
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">
                            Unavailable
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : null}
        {history.hasNextPage && (
          <Button
            className="mt-4"
            variant="outline"
            disabled={history.isFetching}
            onClick={() => void history.fetchNextPage()}
          >
            {history.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        )}
      </section>
    </main>
  );
}
