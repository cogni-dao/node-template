// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/payments/money-plane.server`
 * Purpose: This node's money-plane composition: the repo-spec wallets, the OpenRouter credit this node's key can read,
 *   and the operator-funded Hosting and AI lines, as one read-only report through `@cogni/money-plane`.
 * Scope: Server-only. Reads repo-spec + server env and hands them to the package readers. Does not move funds,
 *   decide alerts, or render.
 * Invariants: Repo-spec approver authorization precedes credentials and provider reads. READERS_NEVER_THROW.
 *   Unreadable is UNKNOWN, never GREEN. Treasury is identified only from configuration.
 * Side-effects: IO (Base JSON-RPC + OpenRouter reads), one terminal MONEY_PLANE_SNAPSHOT log event.
 * Links: packages/money-plane, https://cognidao.org/knowledge/finances-expert
 * @public
 */

import "server-only";

import {
  BASE_PUBLIC_RPC_URL,
  baseWalletReader,
  type FetchLike,
  type MoneyPlaneRow,
  type MoneyPlaneSnapshot,
  openRouterReader,
  type PayAction,
  type PlaneReader,
  takeSnapshot,
} from "@cogni/money-plane";
import { redirect } from "next/navigation";

import { getServerSessionUser } from "@/lib/auth/server";
import {
  getDaoTreasuryAddress,
  getOperatorWalletConfig,
  getStewardWalletConfig,
  isLedgerApprover,
} from "@/shared/config";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";
import { USDC_TOKEN_ADDRESS } from "@/shared/web3";

const log = makeLogger({ route: "admin.payments" });

const SNAPSHOT_TIMEOUT_MS = 8_000;
/** The human checkout the steward wallet pays into; the row's Action opens it. */
export const OPENROUTER_CHECKOUT_URL = "https://openrouter.ai/settings/credits";

const noStoreFetch: FetchLike = (url, init) =>
  fetch(url, { ...init, cache: "no-store" });

export interface NodeFinanceSnapshot extends MoneyPlaneSnapshot {
  /** Plane id of the configured DAO treasury row, or null when repo-spec names none. */
  treasuryPlane: string | null;
}

/**
 * A cost the operator pays on this node's behalf. The node holds no credential for it,
 * so balance and burn stay null until the operator shares the scoped cost (task.5354).
 * Note: the package grading floor normalizes a non-wallet INFO row to UNKNOWN.
 */
function operatorCoveredReader(
  plane: string,
  label: string,
  detail: string
): PlaneReader {
  return {
    plane,
    label,
    kind: "usage",
    async read(): Promise<MoneyPlaneRow> {
      return {
        plane,
        label,
        kind: "usage",
        balance: null,
        currency: null,
        burnPerDay: null,
        runwayDays: null,
        grade: "INFO",
        observedAt: new Date().toISOString(),
        source: "Operator sponsorship",
        sourceObservedAt: null,
        freshness: "unknown",
        payer: "Operator",
        beneficiary: "This node",
        coverage: "operator-covered",
        reasonCode: "unconfigured",
        detail,
      };
    },
  };
}

function readers(): { readers: PlaneReader[]; treasuryPlane: string | null } {
  const env = serverEnv();
  const wallet = {
    rpcUrl: env.EVM_RPC_URL ?? BASE_PUBLIC_RPC_URL,
    fetch: noStoreFetch,
    usdcAddress: USDC_TOKEN_ADDRESS,
  };
  const operator = getOperatorWalletConfig()?.address;
  const steward = getStewardWalletConfig()?.address;
  const configured: {
    name: string;
    label: string;
    address: string | null | undefined;
    payAction?: PayAction;
  }[] = [
    { name: "dao-treasury", label: "DAO treasury", address: getDaoTreasuryAddress() },
    {
      name: "operator-wallet",
      label: "Operator wallet",
      address: operator,
      // Fund-steward moves operator USDC to the steward; without a steward there is nowhere to send it.
      ...(steward ? { payAction: { kind: "fund-steward" as const } } : {}),
    },
    { name: "steward-wallet", label: "Steward wallet", address: steward },
  ];
  // One reader per distinct address: two roles on the same account are one balance, not two.
  let treasuryPlane: string | null = null;
  const accounts = new Map<string, (typeof configured)[number]>();
  for (const account of configured) {
    const address = account.address;
    const key =
      address && /^0x[0-9a-fA-F]{40}$/.test(address)
        ? `base:${wallet.usdcAddress.toLowerCase()}:${address.toLowerCase()}`
        : account.name;
    const prior = accounts.get(key);
    if (account.name === "dao-treasury" && address)
      treasuryPlane = `base:${prior?.name ?? account.name}`;
    if (prior) {
      prior.label = `${prior.label} / ${account.label}`;
      if (prior.payAction === undefined && account.payAction !== undefined)
        prior.payAction = account.payAction;
    } else accounts.set(key, { ...account });
  }
  return {
    treasuryPlane,
    readers: [
      ...[...accounts.values()].map((account) =>
        baseWalletReader({ ...wallet, ...account })
      ),
      openRouterReader({
        apiKey: env.OPENROUTER_API_KEY,
        fetch: noStoreFetch,
        label: "OpenRouter credit",
        payAction: {
          kind: "steward-checkout",
          vendor: "openrouter",
          checkoutUrl: OPENROUTER_CHECKOUT_URL,
        },
      }),
      operatorCoveredReader(
        "hosting:operator-covered",
        "Hosting",
        "Funded by operator · cost not yet shared"
      ),
      operatorCoveredReader(
        "ai:operator-covered",
        "AI",
        "Funded by operator · usage not yet shared"
      ),
    ],
  };
}

/** Authorize at the data boundary, then emit one terminal event per admitted report read. */
export async function getMoneyPlaneSnapshot(): Promise<NodeFinanceSnapshot> {
  // Layouts may render concurrently with their children; gate before credentials or IO.
  const user = await getServerSessionUser();
  if (!isLedgerApprover(user?.walletAddress ?? null)) redirect("/dashboard");

  const started = Date.now();
  try {
    const composition = readers();
    const snapshot = await takeSnapshot(composition.readers, {
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
    });
    log.info(
      {
        event: EVENT_NAMES.MONEY_PLANE_SNAPSHOT,
        outcome: "success",
        durationMs: Date.now() - started,
        worst: snapshot.worst,
        planes: snapshot.rows.map((r) => ({
          plane: r.plane,
          grade: r.grade,
          reasonCode: r.reasonCode ?? null,
        })),
      },
      EVENT_NAMES.MONEY_PLANE_SNAPSHOT
    );
    return { ...snapshot, treasuryPlane: composition.treasuryPlane };
  } catch (error) {
    // takeSnapshot never rejects; this is the composition failing (env or
    // repo-spec unreadable). Log the enum, never the raw message.
    log.error(
      {
        event: EVENT_NAMES.MONEY_PLANE_SNAPSHOT,
        outcome: "error",
        errorCode: "composition_failed",
        durationMs: Date.now() - started,
        worst: "UNKNOWN",
        planes: [],
      },
      EVENT_NAMES.MONEY_PLANE_SNAPSHOT
    );
    throw error;
  }
}
