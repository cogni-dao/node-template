// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/credits/CreditsPage.client`
 * Purpose: Client-side credits page UI handling balance display and USDC payment flow.
 * Scope: Fetches credits data via React Query, renders native USDC payment flow, and refreshes balance on success. Does not handle backend payment verification or wallet connection.
 * Invariants: Payment amounts stored as integer cents (no float math).
 * Side-effects: IO (fetch API via React Query).
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/payments-design.md
 * @public
 */

"use client";

import { isValidAmountInput, parseDollarsToCents } from "@cogni/node-shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Info } from "lucide-react";
import type { ReactElement } from "react";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Card,
  HintText,
  PageContainer,
  SectionCard,
  SplitInput,
  UsdcPaymentFlow,
} from "@/components";
import {
  creditsToUsd,
  useCreditsSummary,
  usePaymentFlow,
} from "@/features/payments/public";

function formatDollars(credits: number): string {
  const dollars = creditsToUsd(credits);
  return dollars.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** The org account's name for the funding header, from the single org view the Fund link names (`orgId`); null until known or when the view is not this account. */
function useOrgName(
  orgId: string | undefined,
  billingAccountId: string | undefined,
): string | null {
  const query = useQuery({
    queryKey: ["org-name", orgId],
    enabled: Boolean(orgId && billingAccountId),
    staleTime: 60_000,
    queryFn: async (): Promise<{ name: string; billingAccountId?: string }> => {
      const res = await fetch(`/api/v1/orgs/${encodeURIComponent(orgId ?? "")}`, {
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`org view ${res.status}`);
      const body = (await res.json()) as {
        org: { name: string; billingAccountId?: string };
      };
      return body.org;
    },
  });
  return query.data && query.data.billingAccountId === billingAccountId
    ? query.data.name
    : null;
}

export function CreditsPageClient(): ReactElement {
  const [amountInput, setAmountInput] = useState<string>("");
  const queryClient = useQueryClient();
  // Fund an org account (story.0080): the org page's Fund link names it; the server decides (org:admin only).
  const params = useSearchParams();
  const billingAccountId = params.get("billingAccountId") ?? undefined;
  const orgName = useOrgName(params.get("orgId") ?? undefined, billingAccountId);

  const summaryQuery = useCreditsSummary({ limit: 1, billingAccountId });

  // Parse amount using string-to-cents utility (no float math)
  const amountCents = parseDollarsToCents(amountInput);
  const isValidAmount = amountCents !== null;

  const paymentFlow = usePaymentFlow({
    amountUsdCents: amountCents ?? 200, // Default to $2.00 if invalid
    billingAccountId,
    onSuccess: () => {
      // Refetch balance but DON'T clear amount (would unmount dialog)
      void queryClient.invalidateQueries({
        queryKey: ["payments-summary", { limit: 1, billingAccountId }],
      });
    },
  });

  // Wrap reset to also clear amount (called from "Done" button)
  const handleResetAndClear = () => {
    paymentFlow.reset();
    setAmountInput(""); // Clear after user acknowledges success
  };

  const balance = summaryQuery.data?.balanceCredits ?? 0;
  const balanceDisplay = summaryQuery.isLoading ? "—" : formatDollars(balance);
  const isNegative = balance < 0;

  return (
    <PageContainer maxWidth="2xl">
      {/* Balance Card */}
      <Card className="flex items-center justify-between p-6">
        {billingAccountId ? (
          <span className="font-semibold text-lg">{orgName ?? "Org"}</span>
        ) : null}
        <span
          className={`font-bold text-4xl ${isNegative ? "text-destructive" : ""}`}
        >
          $ {balanceDisplay}
        </span>
      </Card>

      {/* Buy Credits Section */}
      <SectionCard title="Buy Credits">
        <SplitInput
          label="Amount"
          value={amountInput}
          onChange={(val) => {
            // Allow typing: digits with optional decimal and up to 2 decimal places
            if (isValidAmountInput(val)) {
              setAmountInput(val);
            }
          }}
          placeholder="2.00 - 100000.00"
          disabled={
            // Lock input when: on-chain tx exists OR terminal state (requires explicit reset)
            paymentFlow.state.txHash !== null ||
            paymentFlow.state.result !== null
          }
        />

        {/* Payment Flow */}
        {isValidAmount ? (
          <UsdcPaymentFlow
            amountUsdCents={amountCents}
            state={paymentFlow.state}
            onStartPayment={paymentFlow.startPayment}
            onReset={handleResetAndClear}
            disabled={summaryQuery.isLoading}
          />
        ) : (
          <button
            type="button"
            disabled
            className="w-full cursor-not-allowed rounded-md bg-muted px-4 py-2 text-muted-foreground"
          >
            Invalid amount
          </button>
        )}

        <HintText icon={<Info size={16} />}>
          Transactions may take many minutes to confirm
        </HintText>
      </SectionCard>
    </PageContainer>
  );
}
