// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/metrics/_components/MetricsMount`
 * Purpose: This node's mount of the published Metrics view (`MetricsBoard`, story.0039).
 * Scope: One host (`LinkComponent: Link`) over the package-default cookie-session client at `/api/v1/metrics`. A fork that needs another client, `hrefs` or `queryKeyPrefix` changes only `METRICS_HOST`.
 * Invariants: Same client and query key as the goal entry page's board (`GOALS_QUERY_KEY`), so the goal read is one cache entry.
 * Side-effects: IO (via the package's GoalsClient)
 * Links: packages/knowledge-base-ui/AGENTS.md
 * @internal
 */

"use client";

import {
  type GoalsHostOptions,
  MetricsBoard,
} from "@cogni/knowledge-base-ui/goals";
import type { GoalsProgress } from "@cogni-dao/metrics/contracts";
import Link from "next/link";

/** Module-level so every render shares one identity. */
const METRICS_HOST: GoalsHostOptions = { LinkComponent: Link };

export function MetricsMount({
  initialData,
}: {
  readonly initialData?: GoalsProgress | undefined;
}) {
  return <MetricsBoard {...METRICS_HOST} initialData={initialData} />;
}
