// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/payments/FundStewardAction.client`
 * Purpose: The steward-wallet row's `fund-steward` action: move USDC operator wallet → steward wallet
 *   (withdrawToSteward) so a human can pay vendors from it.
 * Scope: Client component. Amount input + the existing POST; renders the broadcast tx or the error.
 * Invariants: AMOUNT_ONLY — the destination is pinned server-side; the client sends only `amountUsd`.
 * Side-effects: IO (fetch POST → on-chain transfer)
 * Links: src/app/api/v1/payments/steward-withdrawal/route.ts, MoneyPlaneTable.tsx
 * @public
 */

"use client";

import { ExternalLink, Loader2 } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useId, useState } from "react";

import { Button, Input } from "@/components";

type Phase = "idle" | "submitting" | "success" | "error";

function shortHash(h: string): string {
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
}

export function FundStewardAction({
  disabled,
}: {
  disabled: boolean;
}): ReactElement {
  const amountId = useId();
  const [amount, setAmount] = useState("1");
  const [phase, setPhase] = useState<Phase>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setPhase("submitting");
    setError(null);
    setTxHash(null);
    try {
      const res = await fetch("/api/v1/payments/steward-withdrawal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountUsd: Number(amount) }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        txHash?: string;
        error?: string;
        detail?: string;
        code?: string;
      };
      if (!res.ok) {
        setError(
          data.detail ?? data.error ?? data.code ?? `HTTP ${res.status}`
        );
        setPhase("error");
        return;
      }
      setTxHash(data.txHash ?? null);
      setPhase("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [amount]);

  const amountValid = Number(amount) > 0 && Number.isFinite(Number(amount));

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <label htmlFor={amountId} className="sr-only">
          Fund steward (USD)
        </label>
        <Input
          id={amountId}
          type="number"
          min="0"
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={phase === "submitting"}
          className="h-8 w-20"
        />
        <Button
          size="sm"
          onClick={submit}
          disabled={disabled || phase === "submitting" || !amountValid}
        >
          {phase === "submitting" ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Funding…
            </>
          ) : (
            "Fund steward"
          )}
        </Button>
      </div>
      {phase === "success" && txHash ? (
        <a
          href={`https://basescan.org/tx/${txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-mono text-success text-xs hover:underline"
        >
          Broadcast {shortHash(txHash)}
          <ExternalLink className="h-3 w-3" />
        </a>
      ) : null}
      {phase === "error" && error ? (
        <p className="max-w-56 text-right text-destructive text-xs">{error}</p>
      ) : null}
    </div>
  );
}
