// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/AnalyticsPanel`
 * Purpose: Explain observed activity and coverage inside the node's Knowledge page.
 * Scope: Node-owned presentation, filtering and authenticated fetching; shared report semantics.
 * Invariants: UNKNOWN_IS_NOT_ZERO; MISSION_IMPACT_UNMEASURED; NO_BROWSER_CREDENTIALS.
 * Side-effects: GET analytics while mounted; refresh every twenty minutes while visible.
 * Links: /api/v1/knowledge/analytics
 * @internal
 */
"use client";
import { KnowledgeAnalyticsSchema } from "@cogni/knowledge-store/analytics";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button, Input } from "@/components";

export function AnalyticsPanel() {
  const [hours, setHours] = useState("168");
  const [search, setSearch] = useState("");
  const [domain, setDomain] = useState("");
  const [rank, setRank] = useState("changes");
  const query = useQuery({
    queryKey: ["knowledge", "analytics", hours],
    queryFn: async ({ signal }) => {
      const response = await fetch(
        `/api/v1/knowledge/analytics?hours=${hours}`,
        { signal, cache: "no-store" }
      );
      if (!response.ok)
        throw new Error(`Analytics could not refresh (${response.status}).`);
      return KnowledgeAnalyticsSchema.parse(await response.json());
    },
    staleTime: 60_000,
    refetchInterval: 1_200_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const report = query.data;
  const domains = useMemo(
    () =>
      [
        ...new Set(
          report?.rows.flatMap((row) => (row.domain ? [row.domain] : [])) ?? []
        ),
      ].sort(),
    [report]
  );
  const rows = useMemo(
    () =>
      (report?.rows ?? [])
        .filter(
          (row) =>
            (!domain || row.domain === domain) &&
            `${row.title} ${row.id}`
              .toLowerCase()
              .includes(search.toLowerCase())
        )
        .sort(
          (a, b) =>
            (rank === "lookups"
              ? (b.lookupEvents ?? -1) - (a.lookupEvents ?? -1)
              : (b.mergedChanges ?? -1) - (a.mergedChanges ?? -1)) ||
            a.id.localeCompare(b.id)
        )
        .slice(0, 50),
    [report, domain, search, rank]
  );
  const selectClass =
    "rounded-md border border-input bg-background px-3 py-2 text-sm";
  return (
    <section className="flex flex-col gap-4" aria-label="Knowledge analytics">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-lg">What needs attention?</h2>
          <p className="text-muted-foreground text-sm">
            Mission impact is not yet measured. Activity helps choose what to
            review.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Window
          <select
            className={selectClass}
            value={hours}
            onChange={(event) => setHours(event.target.value)}
          >
            <option value="24">1 day</option>
            <option value="168">7 days</option>
            <option value="720">30 days</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Current domain
          <select
            className={selectClass}
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
          >
            <option value="">All domains</option>
            {domains.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Review lens
          <select
            className={selectClass}
            value={rank}
            onChange={(event) => setRank(event.target.value)}
          >
            <option value="changes">Most changed</option>
            <option
              value="lookups"
              disabled={report?.coverage.lookups.status === "unavailable"}
            >
              Most looked up
            </option>
          </select>
        </label>
        <label
          htmlFor="knowledge-analytics-search"
          className="flex min-w-48 flex-1 flex-col gap-1 text-sm"
        >
          Find an atom
          <Input
            id="knowledge-analytics-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Title or ID"
          />
        </label>
      </div>
      {query.isError && (
        <p role="alert" className="text-destructive text-sm">
          {report
            ? "Refresh failed. The last successful snapshot remains below. "
            : ""}
          {query.error.message}
        </p>
      )}
      {!report && query.isPending && (
        <p role="status" className="text-muted-foreground text-sm">
          Reading knowledge activity…
        </p>
      )}
      {report && (
        <>
          <p className="text-muted-foreground text-xs">
            {report.window.start.slice(0, 10)} to{" "}
            {report.window.endExclusive.replace("T", " ").slice(0, 19)} UTC ·
            Generated {report.generatedAt.replace("T", " ").slice(0, 19)} UTC ·
            Refreshes every 20 minutes while open
          </p>
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
            <p>
              {report.summary.currentAtoms ?? "Unavailable"} observed current
              atoms · {report.summary.mergedChanges ?? "Unavailable"} observed
              content changes · {report.summary.openInboxes ?? "Unavailable"}{" "}
              open inboxes
            </p>
            <p className="mt-1 text-muted-foreground">
              {report.coverage.lookups.status === "unavailable"
                ? "Lookups unavailable: this node has no authorized activity source bound."
                : `${report.summary.lookupEvents} observed lookup events; HTTP success and use are unproven.`}
            </p>
            {Object.entries(report.coverage)
              .filter(([, source]) => source.status !== "complete")
              .map(([name, source]) => (
                <p key={name} className="mt-1 text-muted-foreground">
                  {name}: {source.status} ({source.reason?.replaceAll("_", " ")}
                  )
                </p>
              ))}
          </div>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <caption className="p-3 text-left text-muted-foreground text-xs">
                Observed top 50 in this lens. Rare critical guidance needs a
                separate reviewed opportunity sample.
              </caption>
              <thead className="border-b bg-muted/40">
                <tr>
                  {[
                    "Atom",
                    "Lookups*",
                    "Content changes*",
                    "Policy score now*",
                  ].map((label) => (
                    <th key={label} className="p-3 font-medium">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b last:border-0">
                    <td className="min-w-56 p-3">
                      {row.current ? (
                        <a
                          href={`/knowledge/${encodeURIComponent(row.id)}`}
                          className="font-medium underline-offset-4 hover:underline"
                        >
                          {row.title}
                        </a>
                      ) : (
                        <span className="font-medium">{row.title}</span>
                      )}
                      <p className="text-muted-foreground text-xs">
                        {row.domain ??
                          (row.current === false
                            ? "Not in current inventory"
                            : "Inventory membership unknown")}{" "}
                        · {row.id}
                      </p>
                      {row.contributionIds.map((id) => (
                        <a
                          key={id}
                          href={`/knowledge/inbox/${encodeURIComponent(id)}`}
                          className="mr-2 text-muted-foreground text-xs underline"
                        >
                          Change evidence
                        </a>
                      ))}
                    </td>
                    <td className="p-3 tabular-nums">
                      {row.lookupEvents ?? "—"}
                    </td>
                    <td className="p-3 tabular-nums">
                      {row.mergedChanges ?? "—"}
                    </td>
                    <td className="p-3 tabular-nums">
                      {row.policyConfidence ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && (
              <p className="p-4 text-muted-foreground text-sm">
                No matching atoms in the available sources.
              </p>
            )}
          </div>
          <details className="text-muted-foreground text-sm">
            <summary className="cursor-pointer">
              Definitions and missing evidence
            </summary>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {report.limitations.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="mt-2">
              Metadata collected by: {report.inventoryAsOf}. Measuring missed
              guidance requires a reviewed opportunity and the guidance expected
              at that moment.
            </p>
          </details>
        </>
      )}
    </section>
  );
}
