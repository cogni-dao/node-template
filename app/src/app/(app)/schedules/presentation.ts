// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: app/schedules/presentation
 * Purpose: Shared labels for schedule configuration and run history.
 * Scope: Pure presentation; does not infer execution health.
 * Invariants: Unknown cadence retains its literal expression and timezone.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5353
 * @internal
 */
export const SCHEDULE_PRESETS = [
  { label: "Every minute", value: "* * * * *" },
  { label: "Every 2 minutes", value: "*/2 * * * *" },
  { label: "Every 5 minutes", value: "*/5 * * * *" },
  { label: "Every 10 minutes", value: "*/10 * * * *" },
  { label: "Every 15 minutes", value: "*/15 * * * *" },
  { label: "Every 30 minutes", value: "*/30 * * * *" },
  { label: "Hourly", value: "0 * * * *" },
  { label: "Daily at 9:00 AM", value: "0 9 * * *" },
  { label: "Daily at 6:00 PM", value: "0 18 * * *" },
  { label: "Weekly (Monday 9 AM)", value: "0 9 * * 1" },
];

export const TIMEZONES = [
  { label: "UTC", value: "UTC" },
  { label: "Eastern (US)", value: "America/New_York" },
  { label: "Pacific (US)", value: "America/Los_Angeles" },
  { label: "Central European", value: "Europe/Paris" },
  { label: "Manila", value: "Asia/Manila" },
];

export function cadence(cron: string) {
  return SCHEDULE_PRESETS.find((item) => item.value === cron)?.label ?? cron;
}
export function schedulePrompt(input: Record<string, unknown>): string {
  const messages = input.messages;
  if (!Array.isArray(messages)) return "";
  return messages
    .map((message: unknown) =>
      message && typeof message === "object" && "content" in message
        ? String(message.content ?? "")
        : ""
    )
    .filter(Boolean)
    .join("\n\n");
}
export function schedulePreview(input: Record<string, unknown>): string {
  const messages = input.messages;
  const first = Array.isArray(messages) ? messages[0] : undefined;
  return first && typeof first === "object" && "content" in first
    ? String(first.content ?? "")
    : "—";
}

export function scheduleModel(input: Record<string, unknown>): string {
  const ref = input.modelRef;
  if (
    ref &&
    typeof ref === "object" &&
    "modelId" in ref &&
    typeof ref.modelId === "string" &&
    ref.modelId
  ) {
    return ref.modelId;
  }
  return typeof input.model === "string" && input.model ? input.model : "—";
}
export function agentLabel(graphId: string) {
  return graphId.split(":").at(-1) ?? graphId;
}
export { formatRunTime as runTime } from "@cogni/scheduling/presentation";
