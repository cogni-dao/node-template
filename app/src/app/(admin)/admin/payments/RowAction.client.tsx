// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `admin/payments/RowAction.client`
 * Purpose: Render a money-plane row's `payAction` as its Action cell: the inline Fund-steward control
 *   (amount + POST /api/v1/payments/steward-withdrawal + BaseScan link) or a small outline checkout link.
 * Scope: Client component. The only write on the Financials page is the Fund-steward POST; the destination is
 *   pinned server-side (AMOUNT_ONLY). Vendor checkouts are external human steps we only link to.
 * Invariants: ONE_ROW_MODEL — an action is a `payAction` value, never a new row shape. Semantic color tokens only.
 * Side-effects: IO (fetch POST → on-chain transfer)
 * Links: src/app/api/v1/payments/steward-withdrawal/route.ts, packages/money-plane/src/types.ts,
 *   https://cognidao.org/knowledge/fund-cogni-vendors
 * @public
 */
"use client";

import type { PayAction } from "@cogni/money-plane";
import { ExternalLink, Loader2 } from "lucide-react";
import { type ReactElement, useId, useState } from "react";

import { Button, Input } from "@/components";

export const STEWARD_WITHDRAWAL_PATH = "/api/v1/payments/steward-withdrawal";

export type FundStewardResult =
  | { ok: true; txHash: string | null }
  | { ok: false; error: string };

/** POST the amount-only steward withdrawal; never throws. */
export async function fundSteward(
  amountUsd: number,
  fetchImpl: typeof fetch = fetch
): Promise<FundStewardResult> {
  try {
    const res = await fetchImpl(STEWARD_WITHDRAWAL_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amountUsd }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      txHash?: string;
      error?: string;
      detail?: string;
      code?: string;
    };
    if (!res.ok) {
      return {
        ok: false,
        error: data.detail ?? data.error ?? data.code ?? `HTTP ${res.status}`,
      };
    }
    return { ok: true, txHash: data.txHash ?? null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

type Phase = "idle" | "submitting" | "success" | "error";

function FundStewardControl({ label }: { label: string }): ReactElement {
  const id = useId();
  const [amount, setAmount] = useState("1");
  const [phase, setPhase] = useState<Phase>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const valid = Number(amount) > 0 && Number.isFinite(Number(amount));

  async function submit() {
    setPhase("submitting");
    setError(null);
    setTxHash(null);
    const result = await fundSteward(Number(amount));
    if (result.ok) {
      setTxHash(result.txHash);
      setPhase("success");
    } else {
      setError(result.error);
      setPhase("error");
    }
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <label htmlFor={id} className="sr-only">
        Fund steward from {label}, amount in USD
      </label>
      <Input
        id={id}
        type="number"
        min="0"
        step="0.01"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        disabled={phase === "submitting"}
        className="h-9 w-20 tabular-nums"
      />
      <Button
        size="sm"
        onClick={submit}
        disabled={phase === "submitting" || !valid}
      >
        {phase === "submitting" ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            Funding…
          </>
        ) : (
          "Fund steward"
        )}
      </Button>
      {phase === "success" && txHash ? (
        <a
          href={`https://basescan.org/tx/${txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-mono text-success text-xs hover:underline"
        >
          Sent {shortHash(txHash)}
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      ) : null}
      {phase === "error" && error ? (
        <span className="w-full text-danger text-xs">{error}</span>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {phase === "submitting"
          ? "Funding the steward wallet"
          : phase === "success"
            ? "Transfer broadcast"
            : ""}
      </span>
    </div>
  );
}

function OutlineLink({
  href,
  children,
}: {
  href: string;
  children: string;
}): ReactElement {
  return (
    <Button variant="outline" size="sm" asChild>
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      </a>
    </Button>
  );
}

/** The Action cell for one row; nothing when the row carries no payAction. */
export function RowAction({
  action,
  label,
}: {
  action: PayAction | undefined;
  label: string;
}): ReactElement | null {
  if (!action) return null;
  if (action.kind === "fund-steward") return <FundStewardControl label={label} />;
  if (action.kind === "steward-checkout")
    return <OutlineLink href={action.checkoutUrl}>Top up</OutlineLink>;
  return <OutlineLink href={action.url}>{action.label}</OutlineLink>;
}
