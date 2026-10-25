// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/payments/page`
 * Purpose: Shared financial evidence in a node-owned read-only table, with unavailable node cost share explicit.
 * Scope: Server component. The snapshot helper authorizes the repo-spec approver before reading data; the admin layout also gates the shell.
 * Invariants: Reporting only, no payment controls. Custody is not DAO available cash.
 * Side-effects: IO (snapshot reads via getMoneyPlaneSnapshot)
 * Links: money-plane.server.ts, MoneyPlaneTable.tsx, https://cognidao.org/knowledge/money-plane-snapshot-design
 * @public
 */

import type { ReactElement } from "react";

import { PageContainer } from "@/components";

import { MoneyPlaneTable } from "./MoneyPlaneTable";
import { getMoneyPlaneSnapshot } from "./money-plane.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function MoneyPlanesPage(): Promise<ReactElement> {
  const snapshot = await getMoneyPlaneSnapshot();

  return (
    <PageContainer maxWidth="2xl">
      <MoneyPlaneTable
        rows={snapshot.rows}
        takenAt={snapshot.takenAt}
        treasuryPlane={snapshot.treasuryPlane}
        costRateEvidence={snapshot.costRateEvidence}
      />
    </PageContainer>
  );
}
