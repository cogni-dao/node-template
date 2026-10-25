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

import { Badge } from "@cogni/node-ui-kit/reui/badge";
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
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">DAO finances</h1>
        <p className="text-muted-foreground text-sm">
          Configured balances and cost evidence, with missing burn and runway
          shown explicitly. The operator currently covers node expenses; the
          measured node share is not yet available here. Treasury, operator
          float and steward custody remain separate holdings.
        </p>
      </div>
      <p className="text-muted-foreground text-xs">
        Snapshot {snapshot.takenAt.replace("T", " ").slice(0, 19)} UTC · worst{" "}
        <Badge variant="outline" size="sm">
          {snapshot.worst}
        </Badge>
      </p>
      <MoneyPlaneTable rows={snapshot.rows} />
      <section className="space-y-1">
        <h2 className="text-lg font-semibold">Payment evidence</h2>
        <p className="text-muted-foreground text-sm">
          Individual vendor payment history is unavailable from these sources.
          Wallet balances and changes in prepaid credit are not payment
          receipts.
        </p>
      </section>
    </PageContainer>
  );
}
