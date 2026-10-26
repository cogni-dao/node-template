// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/payments/ProviderFundingSection`
 * Purpose: The existing Provider Funding rail (Fund steward, Top up OpenRouter) under an h2, below the Financials table.
 * Scope: Presentation wrapper shared by the admin page and the development preview; balances arrive as props.
 * Invariants: The panel is rendered unchanged; the only write on the page stays the panel's Fund-steward POST.
 * Side-effects: none
 * Links: AiFundingPanel.client.tsx, funding.server.ts, https://cognidao.org/knowledge/fund-cogni-vendors
 * @public
 */

import type { ReactElement } from "react";

import { Separator } from "@/components";

import { AiFundingPanel } from "./AiFundingPanel.client";
import type { AiFunding } from "./funding.server";

export function ProviderFundingSection({
  funding,
}: {
  funding: AiFunding;
}): ReactElement {
  return (
    <>
      <Separator />
      <section aria-labelledby="provider-funding" className="space-y-4">
        <div className="space-y-1">
          <h2
            id="provider-funding"
            className="font-semibold text-foreground text-lg"
          >
            Provider funding
          </h2>
          <p className="text-muted-foreground text-sm">
            The money chain that keeps AI alive: user payments → operator wallet
            → steward wallet → OpenRouter. Top up OpenRouter in USDC — no card.
          </p>
        </div>
        <AiFundingPanel funding={funding} />
      </section>
    </>
  );
}
