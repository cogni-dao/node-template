// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/payments/page`
 * Purpose: Financials — one table of this node's money planes with balance, burn, runway and the row actions
 *   that move money along user USDC → operator wallet → steward wallet → OpenRouter.
 * Scope: Server component. The snapshot helper authorizes the repo-spec approver before any read; the admin layout
 *   also gates the shell. money-plane.server.ts is the page's only read path.
 * Invariants: The table is the page; the only write is the Fund-steward row action's POST. Addresses from repo-spec.
 * Side-effects: IO (snapshot reads via getMoneyPlaneSnapshot)
 * Links: money-plane.server.ts, MoneyPlaneTable.tsx, RowAction.client.tsx,
 *   https://cognidao.org/knowledge/fund-cogni-vendors
 * @public
 */

import type { ReactElement } from "react";

import { PageContainer } from "@/components";

import { MoneyPlaneTable } from "./MoneyPlaneTable";
import { getMoneyPlaneSnapshot } from "./money-plane.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function FinancialsPage(): Promise<ReactElement> {
  const snapshot = await getMoneyPlaneSnapshot();

  return (
    <PageContainer maxWidth="full">
      <MoneyPlaneTable
        rows={snapshot.rows}
        takenAt={snapshot.takenAt}
        treasuryPlane={snapshot.treasuryPlane}
      />
    </PageContainer>
  );
}
