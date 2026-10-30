// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: app/schedules/create-form
 * Purpose: Configure an agent, prompt, cadence and timezone using existing schedule creation.
 * Scope: Form UI and catalog reads; does not schedule execution itself.
 * Invariants: Catalog availability affects this form only; explicit cadence/timezone confirmation.
 * Side-effects: IO (catalog and creation requests)
 * Links: https://cognidao.org/work/items/task.5353
 * @internal
 */
"use client";
import type { ModelRef } from "@cogni/ai-core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components";
import { ModelPicker } from "@/features/ai/components/ModelPicker";
import { useModels } from "@/features/ai/hooks/useModels";
import { createSchedule } from "./_api/createSchedule";
import { fetchAgents } from "./_api/fetchAgents";
import { SCHEDULE_PRESETS, TIMEZONES } from "./presentation";

export function CreateScheduleForm({
  onClose,
  onPendingChange,
}: {
  onClose: () => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const [agent, setAgent] = useState("");
  const [cron, setCron] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [modelRef, setModelRef] = useState<ModelRef | null>(null);
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: fetchAgents,
    staleTime: 60_000,
  });
  const models = useModels();
  const selectedModel = modelRef ?? models.data?.defaultRef;
  const create = useMutation({
    mutationFn: createSchedule,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["schedules"] });
      onPendingChange(false);
      onClose();
    },
    onSettled: () => onPendingChange(false),
  });
  const catalogError = agents.error ?? models.error;
  const canCreate =
    prompt.trim() &&
    agent &&
    cron &&
    selectedModel &&
    !catalogError &&
    (models.data?.models.length ?? 0) > 0;
  return (
    <form
      className="rounded-lg border bg-card p-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (create.isPending || !canCreate || !selectedModel) return;
        onPendingChange(true);
        create.mutate({
          graphId: agent,
          input: {
            messages: [{ role: "user", content: prompt.trim() }],
            modelRef: selectedModel,
          },
          cron,
          timezone,
        });
      }}
    >
      <h2 className="mb-4 font-semibold text-lg">New Schedule</h2>
      {(agents.isLoading || models.isLoading) && (
        <output className="mb-4 block text-sm">
          Loading creation options…
        </output>
      )}
      {catalogError && (
        <div role="alert" className="mb-4 text-sm">
          Creation options are unavailable. Existing schedules remain
          accessible.{" "}
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              void agents.refetch();
              void models.refetch();
            }}
          >
            Try again
          </Button>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2 md:col-span-2">
          <label htmlFor="schedule-prompt" className="font-medium text-sm">
            Prompt
          </label>
          <Input
            id="schedule-prompt"
            required
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Enter the prompt for this scheduled run..."
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="schedule-agent" className="font-medium text-sm">
            Agent
          </label>
          <Select value={agent} onValueChange={setAgent}>
            <SelectTrigger id="schedule-agent">
              <SelectValue
                placeholder={
                  agents.isLoading ? "Loading agents…" : "Select an agent"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {agents.data?.agents.map((item) => (
                <SelectItem key={item.graphId} value={item.graphId}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {agents.data?.agents.length === 0 && (
            <p className="text-muted-foreground text-sm">
              No agents are available yet.
            </p>
          )}
        </div>
        <div className="space-y-2">
          <p className="font-medium text-sm">Model</p>
          <ModelPicker
            models={models.data?.models ?? []}
            value={selectedModel?.modelId ?? ""}
            onValueChange={setModelRef}
            disabled={models.isLoading || !models.data?.models.length}
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="schedule-frequency" className="font-medium text-sm">
            Frequency
          </label>
          <Select value={cron} onValueChange={setCron}>
            <SelectTrigger id="schedule-frequency">
              <SelectValue placeholder="Select frequency" />
            </SelectTrigger>
            <SelectContent>
              {SCHEDULE_PRESETS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <label htmlFor="schedule-timezone" className="font-medium text-sm">
            Timezone
          </label>
          <Select value={timezone} onValueChange={setTimezone}>
            <SelectTrigger id="schedule-timezone">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIMEZONES.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {create.error && (
        <p role="alert" className="text-destructive text-sm">
          {create.error.message}
        </p>
      )}
      <div className="mt-4 flex items-end">
        <Button type="submit" disabled={!canCreate || create.isPending}>
          {create.isPending ? "Creating..." : "Create Schedule"}
        </Button>
      </div>
    </form>
  );
}
