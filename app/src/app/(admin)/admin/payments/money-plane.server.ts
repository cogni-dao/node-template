// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/payments/money-plane.server`
 * Purpose: This node's money-plane composition: which planes it reads (repo-spec wallets + its own OpenRouter key),
 *   which row carries which action, and one snapshot through `@cogni/money-plane`.
 * Scope: Server-only. Reads repo-spec + server env and hands them to the package readers. Does not move funds,
 *   decide alerts, or render.
 * Invariants: READERS_NEVER_THROW (takeSnapshot never rejects, so the page always renders). Fund steward stays reachable
 *   as the steward-wallet row's `payAction: fund-steward`. Forks read only planes they pay for (wallets + OpenRouter).
 * Side-effects: IO (OpenRouter HTTPS GET, Base JSON-RPC reads), one terminal MONEY_PLANE_SNAPSHOT log event.
 * Links: packages/money-plane, https://cognidao.org/knowledge/money-plane-snapshot-design
 * @public
 */

import "server-only";

import {
  BASE_PUBLIC_RPC_URL,
  baseWalletReader,
  type FetchLike,
  type MoneyPlaneSnapshot,
  openRouterReader,
  takeSnapshot,
} from "@cogni/money-plane";

import {
  getDaoTreasuryAddress,
  getOperatorWalletConfig,
  getStewardWalletConfig,
} from "@/shared/config";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";
import { USDC_TOKEN_ADDRESS } from "@/shared/web3";

const log = makeLogger({ route: "admin.payments" });

const SNAPSHOT_TIMEOUT_MS = 8_000;
const OPENROUTER_TOP_UP_URL = "https://openrouter.ai/settings/credits";

const noStoreFetch: FetchLike = (url, init) =>
  fetch(url, { ...init, cache: "no-store" });

function readers() {
  const env = serverEnv();
  const wallet = {
    rpcUrl: env.EVM_RPC_URL ?? BASE_PUBLIC_RPC_URL,
    fetch: noStoreFetch,
    usdcAddress: USDC_TOKEN_ADDRESS,
  };
  return [
    openRouterReader({
      apiKey: env.OPENROUTER_API_KEY,
      fetch: noStoreFetch,
      payAction: {
        kind: "external",
        url: OPENROUTER_TOP_UP_URL,
        label: "Top up OpenRouter",
      },
    }),
    baseWalletReader({
      ...wallet,
      name: "operator-wallet",
      label: "Operator wallet",
      address: getOperatorWalletConfig()?.address,
    }),
    baseWalletReader({
      ...wallet,
      name: "steward-wallet",
      label: "Steward wallet",
      address: getStewardWalletConfig()?.address,
      payAction: { kind: "fund-steward" },
    }),
    baseWalletReader({
      ...wallet,
      name: "dao-treasury",
      label: "DAO treasury",
      address: getDaoTreasuryAddress(),
    }),
  ];
}

/** Exactly one terminal MONEY_PLANE_SNAPSHOT event per call: success, or error with a stable errorCode. */
export async function getMoneyPlaneSnapshot(): Promise<MoneyPlaneSnapshot> {
  const started = Date.now();
  try {
    const snapshot = await takeSnapshot(readers(), {
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
    return snapshot;
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
