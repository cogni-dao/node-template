// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: app/schedules/[scheduleId]/view
 * Purpose: Inspect schedule configuration, execution history and saved responses.
 * Scope: Read UI with existing pause/resume/delete controls; no execution side effects.
 * Invariants: Metadata and saved output are distinct; complete output loads only on expansion.
 * Side-effects: IO (schedule reads and explicit management mutations)
 * Links: https://cognidao.org/work/items/task.5353
 * @public
 */
"use client";
import type { ScheduleRunSummary } from "@cogni/node-contracts";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ArrowLeft, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button } from "@/components";
import { deleteSchedule } from "../_api/deleteSchedule";
import {
  fetchSchedule,
  fetchScheduleHistory,
  fetchScheduleOutput,
} from "../_api/readHistory";
import { updateSchedule } from "../_api/updateSchedule";
import { agentLabel, cadence, runTime, schedulePrompt } from "../presentation";

const STATUS_LABELS = {
  pending: "Waiting",
  running: "Running",
  success: "Completed",
  error: "Failed",
  timeout: "Timed out",
  skipped: "Skipped",
  cancelled: "Cancelled",
} as const;

function RunRow({
  scheduleId,
  run,
  timezone,
}: {
  scheduleId: string;
  run: ScheduleRunSummary;
  timezone: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const output = useQuery({
    queryKey: ["schedule-output", scheduleId, run.runId],
    queryFn: () => fetchScheduleOutput(scheduleId, run.runId),
    enabled: expanded,
    staleTime: 30_000,
  });
  const failed = run.status === "error" || run.status === "timeout";
  return (
    <li className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">{runTime(run.scheduledFor, timezone)}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
            <Badge intent={failed ? "destructive" : "secondary"} size="sm">
              {STATUS_LABELS[run.status]}
            </Badge>
            {run.completedAt ? (
              <span>Finished {runTime(run.completedAt, timezone)}</span>
            ) : run.startedAt ? (
              <span>Started {runTime(run.startedAt, timezone)}</span>
            ) : null}
          </div>
        </div>
        <Button
          variant="ghost"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-controls={`response-${run.id}`}
        >
          {expanded ? "Hide response" : "View response"}
          {expanded ? (
            <ChevronUp className="ml-2 size-4" />
          ) : (
            <ChevronDown className="ml-2 size-4" />
          )}
        </Button>
      </div>
      {expanded && (
        <section
          id={`response-${run.id}`}
          className="mt-4 rounded-lg border bg-background p-4"
          aria-label="Saved response"
        >
          <h3 className="mb-3 font-medium text-sm">Saved response</h3>
          {output.isPending ? (
            <output className="text-muted-foreground text-sm">
              Loading response…
            </output>
          ) : output.error ? (
            <div role="alert">
              <p className="text-destructive text-sm">
                Unable to load this response.
              </p>
              <Button variant="ghost" onClick={() => output.refetch()}>
                Try again
              </Button>
            </div>
          ) : output.data?.availability === "available" ? (
            <div className="whitespace-pre-wrap break-words text-sm leading-7">
              {output.data.text}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              {output.data?.availability === "empty"
                ? "This run saved a response without text."
                : run.status === "pending" || run.status === "running"
                  ? "The response will be available after the run finishes. Refresh to check again."
                  : "No saved response is available for this run. It may not have been saved or may have been removed."}
            </p>
          )}
        </section>
      )}
    </li>
  );
}

export function ScheduleDetailView({ scheduleId }: { scheduleId: string }) {
  const client = useQueryClient();
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState(false);
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
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["schedules"] });
      void client.invalidateQueries({ queryKey: ["schedule", scheduleId] });
    },
  });
  const remove = useMutation({
    mutationFn: deleteSchedule,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["schedules"] });
      router.push("/schedules");
    },
  });
  const refresh = () => {
    void client.resetQueries({ queryKey: ["schedule-history", scheduleId] });
    void client.invalidateQueries({
      queryKey: ["schedule-output", scheduleId],
    });
    void schedule.refetch();
  };
  const current = schedule.data;
  const runs = history.data?.pages.flatMap((page) => page.runs) ?? [];
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-8">
      <Link
        href="/schedules"
        className="flex w-fit items-center gap-2 text-muted-foreground text-sm hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Schedules
      </Link>
      {schedule.isPending ? (
        <output>Loading schedule…</output>
      ) : schedule.error || !current ? (
        <div role="alert" className="rounded-xl border p-6">
          <h1 className="font-semibold text-xl">Schedule unavailable</h1>
          <p className="mt-2 text-muted-foreground text-sm">
            This schedule may have been removed, or you may not have access.
          </p>
          <Button
            className="mt-4"
            variant="secondary"
            onClick={() => schedule.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="mb-3 flex items-center gap-2">
                <Badge intent="secondary">
                  {current.enabled ? "Active" : "Paused"}
                </Badge>
                <span className="text-muted-foreground text-sm">
                  {agentLabel(current.graphId)}
                </span>
              </div>
              <h1 className="line-clamp-2 font-semibold text-2xl tracking-tight">
                {schedulePrompt(current.input) || agentLabel(current.graphId)}
              </h1>
              <p className="mt-2 text-muted-foreground text-sm">
                {cadence(current.cron)} · {current.timezone}
              </p>
            </div>
            <Button
              variant="outline"
              disabled={toggle.isPending}
              onClick={() =>
                toggle.mutate({
                  id: scheduleId,
                  data: { enabled: !current.enabled },
                })
              }
            >
              {toggle.isPending
                ? "Saving…"
                : current.enabled
                  ? "Pause schedule"
                  : "Resume schedule"}
            </Button>
          </div>
          {toggle.error && (
            <p role="alert" className="text-destructive text-sm">
              {toggle.error.message}
            </p>
          )}
          <details className="rounded-xl border bg-card p-5" open>
            <summary className="cursor-pointer font-medium text-sm">
              Scheduled instructions
            </summary>
            <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7">
              {schedulePrompt(current.input) ||
                "No prompt was provided for this schedule."}
            </p>
          </details>
          <section aria-labelledby="run-history-heading">
            <div className="mb-4 flex items-center justify-between gap-4">
              <div>
                <h2 id="run-history-heading" className="font-semibold text-xl">
                  Run history
                </h2>
                <p className="mt-1 text-muted-foreground text-sm">
                  Newest scheduled runs first · {current.timezone}
                </p>
              </div>
              <Button
                variant="ghost"
                onClick={refresh}
                disabled={history.isFetching}
              >
                <RefreshCw className="mr-2 size-4" />
                Refresh
              </Button>
            </div>
            {history.isPending ? (
              <output className="py-8 text-center text-muted-foreground">
                Loading run history…
              </output>
            ) : (
              <>
                {history.error && (
                  <div role="alert" className="mb-4 rounded-lg border p-4">
                    <p className="text-destructive text-sm">
                      {history.error.message}
                    </p>
                    <Button
                      className="mt-2"
                      variant="secondary"
                      onClick={refresh}
                    >
                      Refresh history
                    </Button>
                  </div>
                )}
                {runs.length > 0 ? (
                  <ul className="divide-y rounded-xl border bg-card">
                    {runs.map((run) => (
                      <RunRow
                        key={run.id}
                        scheduleId={scheduleId}
                        run={run}
                        timezone={current.timezone}
                      />
                    ))}
                  </ul>
                ) : (
                  !history.error && (
                    <div className="rounded-xl border border-dashed p-10 text-center">
                      <h3 className="font-medium">No runs yet</h3>
                      <p className="mt-2 text-muted-foreground text-sm">
                        {current.enabled
                          ? "Results will appear here after this schedule runs."
                          : "Resume this schedule when you want it to run again."}
                      </p>
                    </div>
                  )
                )}
                {history.hasNextPage && (
                  <div className="mt-4 flex justify-center">
                    <Button
                      variant="outline"
                      disabled={history.isFetchingNextPage}
                      onClick={() => history.fetchNextPage()}
                    >
                      {history.isFetchingNextPage
                        ? "Loading…"
                        : "Load older runs"}
                    </Button>
                  </div>
                )}
              </>
            )}
          </section>
          <div className="mt-4 border-t pt-5">
            {confirmDelete ? (
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-muted-foreground text-sm">
                  Delete this schedule? Its history will no longer be available
                  here.
                </p>
                <Button
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(scheduleId)}
                >
                  {remove.isPending ? "Deleting…" : "Delete schedule"}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setConfirmDelete(false)}
                  disabled={remove.isPending}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
                Delete schedule…
              </Button>
            )}
            {remove.error && (
              <p role="alert" className="mt-2 text-destructive text-sm">
                {remove.error.message}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
