// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `app/dev/finance-preview/page`
 * Purpose: Preview the actual Financials component inside its real node shell.
 * Scope: Fixture-only development route; protected report auth is unchanged.
 * Invariants: Production/test return404; shell treasury reads are locally disabled.
 * Side-effects: none
 * Links: admin/payments/MoneyPlaneTable.tsx
 * @internal
 */
import type { TreasurySnapshotResponseV1 } from "@cogni/node-contracts";
import { notFound } from "next/navigation";
import { AdminShell } from "@/app/(admin)/AdminShell";
import { MoneyPlaneTable } from "@/app/(admin)/admin/payments/MoneyPlaneTable";
import { AdminText, Button, PageContainer } from "@/components";
import { getEnv } from "@/shared/env";
import { FixtureBoundary } from "./FixtureBoundary";
import { richPreview, sparsePreview } from "./fixture";

export default async function FinancePreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ scenario?: string }>;
}) {
  if (getEnv("NODE_ENV") !== "development") notFound();
  const rich = (await searchParams).scenario === "rich";
  const report = rich ? richPreview : sparsePreview;
  const treasury = report.rows.find(
    (row) => row.plane === report.treasuryPlane,
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
              balanceWei: "1207071234",
              balanceFormatted: String(treasury.balance),
              decimals: 6,
            },
          ],
          timestamp: Date.parse(report.takenAt),
        }
      : undefined;
  return (
    <FixtureBoundary
      key={rich ? "rich" : "sparse"}
      {...(snapshot ? { snapshot } : {})}
    >
      <AdminShell>
        <PageContainer maxWidth="full">
          <div className="mx-auto mb-6 flex max-w-6xl flex-wrap items-center justify-between gap-2">
            <AdminText variant="detail">
              Demo data ·{" "}
              {rich
                ? "Synthetic rich scenario"
                : "Current coverage shape · synthetic values"}
            </AdminText>
            <Button variant="outline" size="sm" asChild>
              <a
                href={
                  rich
                    ? "/dev/finance-preview"
                    : "/dev/finance-preview?scenario=rich"
                }
              >
                {rich ? "Sparse scenario" : "Rich scenario"}
              </a>
            </Button>
          </div>
          <MoneyPlaneTable {...report} />
        </PageContainer>
      </AdminShell>
    </FixtureBoundary>
  );
}
