// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/knowledge-base-ui/epochs/components/EpochCountdown`
 * Purpose: Monospace countdown timer with progress bar for the current epoch.
 * Scope: Governance feature component. Client-side timer with 60s interval. Does not perform data fetching or server-side logic.
 * Invariants: Progress computed from epoch start/end window. Timer updates every minute.
 * Side-effects: time
 * Links: src/features/governance/types.ts
 * @public
 */

"use client";

import { Clock } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { Badge, Card, CardContent, Progress } from "../ui/index";
import type { EpochView } from "../types";

interface EpochCountdownProps {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly status: EpochView["status"];
  readonly contributorCount: number;
  readonly totalPoints: string;
}

function useCountdown(periodStart: string, periodEnd: string) {
  const [timeLeft, setTimeLeft] = useState("");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const end = new Date(periodEnd).getTime();
    const start = new Date(periodStart).getTime();
    const tick = () => {
      const now = Date.now();
      const remaining = Math.max(0, end - now);
      const total = end - start;
      setProgress(Math.min(100, ((total - remaining) / total) * 100));
      const d = Math.floor(remaining / 86_400_000);
      const h = Math.floor((remaining % 86_400_000) / 3_600_000);
      const m = Math.floor((remaining % 3_600_000) / 60_000);
      setTimeLeft(`${d}d  ${h}h  ${String(m).padStart(2, "0")}m`);
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [periodStart, periodEnd]);

  return { timeLeft, progress };
}

function StatusBadge({
  status,
}: {
  status: EpochView["status"];
}): ReactElement {
  switch (status) {
    case "open":
      return (
        <Badge intent="default" size="sm" className="animate-pulse">
          ACTIVE
        </Badge>
      );
    case "review":
      return (
        <Badge intent="secondary" size="sm">
          IN REVIEW
        </Badge>
      );
    case "finalized":
      return (
        <Badge intent="secondary" size="sm">
          FINALIZED
        </Badge>
      );
  }
}

export function EpochCountdown({
  periodStart,
  periodEnd,
  status,
  contributorCount,
  totalPoints,
}: EpochCountdownProps): ReactElement {
  const { timeLeft, progress } = useCountdown(periodStart, periodEnd);

  return (
    <Card className="border-border/50 bg-card/50">
      <CardContent className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-muted-foreground flex items-center gap-2">
            <Clock className="h-4 w-4" />
            <span className="text-sm">
              {status === "open" ? "Time remaining" : "Epoch ended"}
            </span>
          </div>
          <StatusBadge status={status} />
        </div>
        <div className="text-foreground mb-2 font-mono text-2xl font-bold">
          {timeLeft}
        </div>
        <Progress value={progress} className="bg-secondary h-1.5" />
        <div className="text-muted-foreground mt-2 flex justify-between text-xs">
          <span>{contributorCount} contributors</span>
          <span>{totalPoints} total points</span>
        </div>
      </CardContent>
    </Card>
  );
}
