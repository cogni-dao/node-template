// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `app/dev/finance-preview/page`
 * Purpose: Preview the actual Financials component inside its real node shell with synthetic rows.
 * Scope: Fixture-only development route; protected report auth is unchanged.
 * Invariants: Production/test return 404; shell treasury reads are locally disabled.
 * Side-effects: none
 * Links: admin/payments/FinanceReportClient.client.tsx, fixture.ts
 * @internal
 */
import type { TreasurySnapshotResponseV1 } from "@cogni/node-contracts";
import { notFound } from "next/navigation";
import { AdminShell } from "@/app/(admin)/AdminShell";
import { FinanceReportClient } from "@/app/(admin)/admin/payments/FinanceReportClient.client";
import { AdminText, Button, PageContainer } from "@/components";
import { getEnv } from "@/shared/env";
import { FixtureBoundary } from "./FixtureBoundary";
import { previewFor } from "./fixture";

export default async function FinancePreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ scenario?: string }>;
}) {
  if (getEnv("NODE_ENV") !== "development") notFound();
  const { scenario, report } = previewFor((await searchParams).scenario);
  const treasury = report.rows.find(
    (row) => row.plane === report.treasuryPlane
  );
  const snapshot: TreasurySnapshotResponseV1 | undefined =
    treasury?.balance != null
      ? {
          treasuryAddress: "0x1111111111111111111111111111111111111111",
          chainId: 8453,
          blockNumber: "0",
          balances: [
            {
              token: "USDC",
              tokenAddress: null,
              balanceWei: String(Math.round(treasury.balance * 1e6)),
              balanceFormatted: String(treasury.balance),
              decimals: 6,
            },
          ],
          timestamp: Date.parse(report.takenAt),
        }
      : undefined;
  const other = scenario === "sparse" ? "live-shaped" : "sparse";
  return (
    <FixtureBoundary key={scenario} {...(snapshot ? { snapshot } : {})}>
      <AdminShell>
        <PageContainer maxWidth="full">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
            <AdminText variant="detail">
              Demo data · {scenario} scenario · synthetic values
            </AdminText>
            <Button variant="outline" size="sm" asChild>
              <a href={`/dev/finance-preview?scenario=${other}`}>
                {other} scenario
              </a>
            </Button>
          </div>
          <FinanceReportClient report={report} />
        </PageContainer>
      </AdminShell>
    </FixtureBoundary>
  );
}
