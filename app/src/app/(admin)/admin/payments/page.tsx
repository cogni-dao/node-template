// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/payments/page`
 * Purpose: The node's money planes on one page: a `@cogni/money-plane` snapshot of every plane this node pays for
 *   (its OpenRouter account and its repo-spec wallets), rendered as one table.
 * Scope: Server component. Access gating handled upstream by `(admin)/layout.tsx`.
 * Invariants: Read-only here; the only write is the steward row's Fund-steward POST. Addresses from repo-spec.
 *   NO_FUNDS_MOVED by the read path.
 * Side-effects: IO (snapshot reads via getMoneyPlaneSnapshot, session read for the steward check)
 * Links: money-plane.server.ts, MoneyPlaneTable.tsx, https://cognidao.org/knowledge/money-plane-snapshot-design
 * @public
 */

import { Badge } from "@cogni/node-ui-kit/reui/badge";
import type { ReactElement } from "react";

import { PageContainer } from "@/components";
import { getServerSessionUser } from "@/lib/auth/server";
import { getStewardWalletConfig } from "@/shared/config";

import { MoneyPlaneTable } from "./MoneyPlaneTable";
import { getMoneyPlaneSnapshot } from "./money-plane.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function MoneyPlanesPage(): Promise<ReactElement> {
  const [snapshot, user] = await Promise.all([
    getMoneyPlaneSnapshot(),
    getServerSessionUser(),
  ]);
  // The withdrawal route is STEWARD_SELF_AUTHORIZED: an approver that is not the
  // steward would get a 403, so the action is disabled for them up front.
  const steward = getStewardWalletConfig()?.address?.toLowerCase();
  const wallet = user?.walletAddress?.toLowerCase();
  const canFundSteward = !!steward && !!wallet && steward === wallet;

  return (
    <PageContainer maxWidth="2xl">
      <div className="space-y-1">
        <h1 className="font-bold text-2xl tracking-tight">Money planes</h1>
        <p className="text-muted-foreground text-sm">
          Every account this node pays from or holds: balance, burn, runway and
          grade. A plane that cannot be read shows UNKNOWN with its reason,
          never GREEN. Fund the steward wallet from the operator wallet on its
          row; top up OpenRouter from the steward wallet.
        </p>
      </div>
      <p className="text-muted-foreground text-xs">
        Snapshot {snapshot.takenAt.replace("T", " ").slice(0, 19)} UTC · worst{" "}
        <Badge variant="outline" size="sm">
          {snapshot.worst}
        </Badge>
      </p>
      <MoneyPlaneTable rows={snapshot.rows} canFundSteward={canFundSteward} />
    </PageContainer>
  );
}
