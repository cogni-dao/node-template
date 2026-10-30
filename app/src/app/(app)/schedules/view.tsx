// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: app/schedules/view
 * Purpose: Show active schedules and direct owners to their run history.
 * Scope: List/filter/configuration UI; catalog errors stay within the creation form.
 * Invariants: Active means enabled configuration, not worker health; paused history stays accessible.
 * Side-effects: IO (schedule reads and pause/resume)
 * Links: https://cognidao.org/work/items/task.5353
 * @public
 */
"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronUp, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
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
import { deleteSchedule } from "./_api/deleteSchedule";
import { fetchSchedules } from "./_api/fetchSchedules";
import { updateSchedule } from "./_api/updateSchedule";
import { CreateScheduleForm } from "./create-form";
import {
  agentLabel,
  cadence,
  scheduleModel,
  schedulePreview,
} from "./presentation";

export function SchedulesView() {
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [createPending, setCreatePending] = useState(false);
  const [filter, setFilter] = useState<"Active" | "Paused" | "All">("All");
  const query = useQuery({
    queryKey: ["schedules"],
    queryFn: fetchSchedules,
    staleTime: 30_000,
  });
  const toggle = useMutation({
    mutationFn: updateSchedule,
    onSuccess: (updated) => {
      client.setQueryData(["schedule", updated.id], updated);
      void client.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
  const remove = useMutation({
    mutationFn: deleteSchedule,
    onSuccess: async (_result, deletedId) => {
      const detail = { queryKey: ["schedule", deletedId], exact: true };
      const history = {
        queryKey: ["schedule-history", deletedId],
        exact: true,
      };
      await Promise.all([
        client.cancelQueries(detail),
        client.cancelQueries(history),
      ]);
      client.removeQueries(detail);
      client.removeQueries(history);
      void client.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
  const schedules = query.data?.schedules ?? [];
  const counts = {
    All: schedules.length,
    Active: schedules.filter((item) => item.enabled).length,
    Paused: schedules.filter((item) => !item.enabled).length,
  };
  const visible = schedules.filter(
    (item) => filter === "All" || item.enabled === (filter === "Active")
  );
  const mutationError = toggle.error ?? remove.error;
  const mutating = toggle.isPending || remove.isPending;
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-[var(--max-width-container-screen)] flex-col gap-8 p-4 md:p-8 lg:px-16">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-bold text-3xl tracking-tight">Schedules</h1>
        <Button
          size="sm"
          disabled={createPending}
          onClick={() => {
            if (!createPending) setCreating(!creating);
          }}
        >
          {creating ? (
            <ChevronUp className="mr-2 size-4" />
          ) : (
            <Plus className="mr-2 size-4" />
          )}
          {creating ? "Close" : "Create Schedule"}
        </Button>
      </div>
      {mutationError && (
        <p role="alert" className="text-destructive text-sm">
          {mutationError.message}
        </p>
      )}
      {creating && (
        <CreateScheduleForm
          onClose={() => setCreating(false)}
          onPendingChange={setCreatePending}
        />
      )}
      <fieldset className="flex gap-2" aria-label="Filter schedules">
        {(["All", "Active", "Paused"] as const).map((item) => (
          <Button
            key={item}
            size="sm"
            variant={filter === item ? "default" : "outline"}
            aria-pressed={filter === item}
            onClick={() => setFilter(item)}
          >
            {item} ({counts[item]})
          </Button>
        ))}
      </fieldset>
      {query.error && (
        <div role="alert" className="rounded-lg border p-6">
          <p>Unable to load schedules.</p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => void query.refetch()}
          >
            Try again
          </Button>
        </div>
      )}
      {query.isLoading ? (
        <output>Loading schedules…</output>
      ) : query.error && !query.data ? null : visible.length === 0 ? (
        <div className="rounded-lg border bg-card p-12 text-center">
          <p className="text-muted-foreground">
            {filter === "All"
              ? "No schedules"
              : `No ${filter.toLowerCase()} schedules`}
          </p>
          <p className="mt-2 text-muted-foreground text-sm">
            Create your first schedule to automate graph runs.
          </p>
        </div>
      ) : (
        <div className="min-w-0 overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Prompt</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead>Timezone</TableHead>
                <TableHead>History</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((schedule) => {
                const prompt = schedulePreview(schedule.input);
                return (
                  <TableRow key={schedule.id}>
                    <TableCell>
                      <Badge
                        intent={schedule.enabled ? "default" : "secondary"}
                        size="sm"
                      >
                        {schedule.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-medium">
                      {agentLabel(schedule.graphId)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {scheduleModel(schedule.input)}
                    </TableCell>
                    <TableCell className="max-w-xs truncate">
                      {prompt.length > 50
                        ? `${prompt.slice(0, 50)}...`
                        : prompt}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {cadence(schedule.cron)}
                    </TableCell>
                    <TableCell>{schedule.timezone}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      <Link
                        href={`/schedules/${schedule.id}`}
                        className="whitespace-nowrap underline"
                      >
                        View runs
                      </Link>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={mutating}
                          onClick={() => {
                            remove.reset();
                            toggle.mutate({
                              id: schedule.id,
                              data: { enabled: !schedule.enabled },
                            });
                          }}
                        >
                          {schedule.enabled ? "Disable" : "Enable"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Delete schedule ${agentLabel(schedule.graphId)}`}
                          disabled={mutating}
                          onClick={() => {
                            toggle.reset();
                            if (
                              window.confirm(
                                "Delete this schedule? Its configuration will be removed."
                              )
                            )
                              remove.mutate(schedule.id);
                          }}
                        >
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
