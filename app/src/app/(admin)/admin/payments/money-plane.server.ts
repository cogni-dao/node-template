// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/payments/money-plane.server`
 * Purpose: This node's money-plane composition: configured wallet custody and explicitly unavailable operator-funded node cost shares,
 *   one read-only report through `@cogni/money-plane`.
 * Scope: Server-only. Reads repo-spec + server env and hands them to the package readers. Does not move funds,
 *   decide alerts, or render.
 * Invariants: Repo-spec approver authorization precedes credentials and provider reads. READERS_NEVER_THROW. Wallet custody never proves DAO spendable cash. Operator coverage is separate from measured node share.
 * Side-effects: IO (Base JSON-RPC reads), one terminal MONEY_PLANE_SNAPSHOT log event.
 * Links: packages/money-plane, https://cognidao.org/knowledge/money-plane-snapshot-design
 * @public
 */

import "server-only";


import {
  BASE_PUBLIC_RPC_URL,
  baseWalletReader,
  type CostRateEvidence,
  type FetchLike,
  type MoneyPlaneSnapshot,
  type PlaneReader,
  takeSnapshot,
  unknownRow,
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

const noStoreFetch: FetchLike = (url, init) =>
  fetch(url, { ...init, cache: "no-store" });

export interface NodeFinanceSnapshot extends MoneyPlaneSnapshot {
  treasuryPlane: string | null;
  costRateEvidence: CostRateEvidence[];
}

function readers(): { readers: PlaneReader[]; treasuryPlane: string | null } {
  const env = serverEnv();
  const wallet = {
    rpcUrl: env.EVM_RPC_URL ?? BASE_PUBLIC_RPC_URL,
    fetch: noStoreFetch,
    usdcAddress: USDC_TOKEN_ADDRESS,
  };
  const configured = [
    {
      name: "operator-wallet",
      label: "Operator wallet",
      address: getOperatorWalletConfig()?.address,
    },
    {
      name: "steward-wallet",
      label: "Steward wallet",
      address: getStewardWalletConfig()?.address,
    },
    {
      name: "dao-treasury",
      label: "DAO treasury",
      address: getDaoTreasuryAddress(),
    },
  ];
  let treasuryPlane: string | null = null;
  const accounts = new Map<string, (typeof configured)[number]>();
  for (const account of configured) {
    const address = account.address;
    const key =
      address && /^0x[0-9a-fA-F]{40}$/.test(address)
        ? `base:${wallet.usdcAddress.toLowerCase()}:${address.toLowerCase()}`
        : account.name;
    const prior = accounts.get(key);
    if (
      account.name === "dao-treasury" &&
      address &&
      /^0x[0-9a-fA-F]{40}$/.test(address)
    )
      treasuryPlane = `base:${prior?.name ?? account.name}`;
    if (prior) prior.label = `${prior.label} / ${account.label}`;
    else accounts.set(key, { ...account });
  }
  return {
    treasuryPlane,
    readers: [
      ...[...accounts.values()].map((account) =>
        baseWalletReader({ ...wallet, ...account })
      ),
      {
        plane: "ai:operator-covered",
        label: "Node AI share",
        kind: "usage",
        async read() {
          return {
            ...unknownRow({
              plane: "ai:operator-covered",
              label: "Node AI share",
              kind: "usage",
              reasonCode: "unconfigured",
              observedAt: new Date().toISOString(),
              detail:
                "Scoped node cost unavailable; shared provider account is not a node balance",
            }),
            source: "Operator sponsorship",
            payer: "Operator",
            beneficiary: "This node",
            coverage: "operator-covered",
          };
        },
      },
      {
        plane: "hosting:operator-covered",
        label: "Node hosting share",
        kind: "usage",
        async read() {
          return {
            ...unknownRow({
              plane: "hosting:operator-covered",
              label: "Node hosting share",
              kind: "usage",
              reasonCode: "unconfigured",
              observedAt: new Date().toISOString(),
              detail: "Node cost share unavailable",
            }),
            source: "Operator sponsorship",
            payer: "Operator",
            beneficiary: "This node",
            coverage: "operator-covered",
          };
        },
      },
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
    return {
      ...snapshot,
      treasuryPlane: composition.treasuryPlane,
      costRateEvidence: [],
    };
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
