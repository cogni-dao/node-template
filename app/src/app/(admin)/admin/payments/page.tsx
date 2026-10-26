// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/payments/page`
 * Purpose: Financials — the read-only money-plane report, then the existing Provider Funding rail
 *   (Fund steward, Top up OpenRouter) that moves money along user USDC → operator wallet → steward → OpenRouter.
 * Scope: Server component. The snapshot helper authorizes the repo-spec approver before any read; the admin layout
 *   also gates the shell. Funding balances are read only after that authorization.
 * Invariants: The table is read-only; the only write on the page is the panel's Fund-steward POST. Addresses from repo-spec.
 * Side-effects: IO (snapshot reads via getMoneyPlaneSnapshot, OpenRouter + on-chain reads via getAiFunding)
 * Links: money-plane.server.ts, MoneyPlaneTable.tsx, funding.server.ts, AiFundingPanel.client.tsx,
 *   https://cognidao.org/knowledge/fund-cogni-vendors
 * @public
 */

import type { ReactElement } from "react";

import { PageContainer } from "@/components";

import { getAiFunding } from "./funding.server";
import { MoneyPlaneTable } from "./MoneyPlaneTable";
import { getMoneyPlaneSnapshot } from "./money-plane.server";
import { ProviderFundingSection } from "./ProviderFundingSection";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function FinancialsPage(): Promise<ReactElement> {
  // Authorization lives in getMoneyPlaneSnapshot; funding balances read only after it admits the session.
  const snapshot = await getMoneyPlaneSnapshot();
  const funding = await getAiFunding();

  return (
    <PageContainer maxWidth="full">
      <MoneyPlaneTable
        rows={snapshot.rows}
        takenAt={snapshot.takenAt}
        treasuryPlane={snapshot.treasuryPlane}
      />
      <ProviderFundingSection funding={funding} />
    </PageContainer>
  );
}
