// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni-dao/knowledge-base-ui/epochs/hooks/useSignEpoch`
 * Purpose: Orchestrates EIP-712 epoch signing flow — seal review snapshot, fetch sign-data, wallet signature, POST finalize.
 * Scope: Client-side state machine for sign & finalize. Does not access database or server-side logic.
 * Invariants: WRITE_ROUTES_APPROVER_GATED (server enforces), SIGNATURE_SCOPE_BOUND, SIGNATURE_DEPLOYMENT_BOUND (server-supplied environment is signed).
 * Side-effects: IO (HTTP fetch, wagmi wallet signing)
 * Links: packages/node-contracts/src/attribution.sign-data.v2.contract.ts, packages/node-contracts/src/attribution.finalize-epoch.v1.contract.ts
 * @public
 */

"use client";

import type { FinalizeEpochOutput } from "@cogni/attribution-ledger/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { type EpochsClient, useEpochContext } from "../context";
import { ReviewRefusal, reviewResponseError } from "../review-errors";

// Types mirrored from contracts (features must_not_import contracts layer)

/** EIP-712 typed data returned by the sign-data endpoint. */
export interface SignDataResponse {
  readonly domain: { name: string; version: string; chainId: number };
  readonly types: {
    AttributionStatement: readonly { name: string; type: string }[];
  };
  readonly primaryType: "AttributionStatement";
  readonly message: {
    nodeId: string;
    scopeId: string;
    epochId: string;
    deploymentEnvironment:
      | "local"
      | "test"
      | "candidate-a"
      | "preview"
      | "production";
    finalAllocationSetHash: string;
    poolTotalCredits: string;
  };
}

/** Response from the finalize endpoint. */
type FinalizeResponse = FinalizeEpochOutput;

// ── State machine ────────────────────────────────────────────────────────────

export type SignEpochPhase =
  | "IDLE"
  | "FETCHING_DATA"
  | "AWAITING_SIGNATURE"
  | "SUBMITTING"
  | "SUCCESS"
  | "ERROR";

export interface SignEpochState {
  readonly phase: SignEpochPhase;
  readonly isInFlight: boolean;
  readonly result: FinalizeResponse | null;
  readonly errorMessage: string | null;
}

type InternalState =
  | { phase: "IDLE" }
  | { phase: "FETCHING_DATA" }
  | { phase: "AWAITING_SIGNATURE" }
  | { phase: "SUBMITTING" }
  | { phase: "SUCCESS"; result: FinalizeResponse }
  | { phase: "ERROR"; message: string };

type Action =
  | { type: "START_FETCH" }
  | { type: "DATA_FETCHED" }
  | { type: "SIGNATURE_RECEIVED" }
  | { type: "FINALIZE_SUCCESS"; result: FinalizeResponse }
  | { type: "FAIL"; message: string }
  | { type: "RESET" };

function reducer(state: InternalState, action: Action): InternalState {
  switch (action.type) {
    case "START_FETCH":
      return { phase: "FETCHING_DATA" };
    case "DATA_FETCHED":
      return { phase: "AWAITING_SIGNATURE" };
    case "SIGNATURE_RECEIVED":
      return { phase: "SUBMITTING" };
    case "FINALIZE_SUCCESS":
      return { phase: "SUCCESS", result: action.result };
    case "FAIL":
      return { phase: "ERROR", message: action.message };
    case "RESET":
      return { phase: "IDLE" };
    default:
      return state;
  }
}

function derivePublicState(internal: InternalState): SignEpochState {
  const isInFlight =
    internal.phase === "FETCHING_DATA" ||
    internal.phase === "AWAITING_SIGNATURE" ||
    internal.phase === "SUBMITTING";

  switch (internal.phase) {
    case "IDLE":
    case "FETCHING_DATA":
    case "AWAITING_SIGNATURE":
    case "SUBMITTING":
      return {
        phase: internal.phase,
        isInFlight,
        result: null,
        errorMessage: null,
      };
    case "SUCCESS":
      return {
        phase: "SUCCESS",
        isInFlight: false,
        result: internal.result,
        errorMessage: null,
      };
    case "ERROR":
      return {
        phase: "ERROR",
        isInFlight: false,
        result: null,
        errorMessage: internal.message,
      };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchSignData(
  client: EpochsClient,
  epochId: string,
): Promise<SignDataResponse> {
  const res = await client.request(client.endpoints.signData(epochId), {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!res.ok) {
    throw await reviewResponseError(res, "read");
  }
  return res.json() as Promise<SignDataResponse>;
}

/**
 * Idempotently seal (or repair) the unsigned review snapshot before typed data
 * is built. This keeps sign-data GET read-only while recovering reviews created
 * by the former manual open→review path that did not lock claimant rows.
 */
async function sealReviewSnapshot(
  client: EpochsClient,
  epochId: string,
): Promise<void> {
  const res = await client.request(client.endpoints.review(epochId), {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!res.ok) {
    throw await reviewResponseError(res, "save");
  }
}

async function postFinalize(
  client: EpochsClient,
  epochId: string,
  signature: string,
): Promise<FinalizeResponse> {
  const res = await client.request(client.endpoints.finalize(epochId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ signature }),
  });
  if (!res.ok) {
    throw await reviewResponseError(res, "save");
  }
  return res.json() as Promise<FinalizeResponse>;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export interface UseSignEpochReturn {
  state: SignEpochState;
  sign: () => Promise<void>;
  reset: () => void;
}

export function useSignEpoch(epochId: string): UseSignEpochReturn {
  const [internal, dispatch] = useReducer(reducer, { phase: "IDLE" });
  const { client, queryKeyPrefix, isCurrentScope } = useEpochContext();
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, [epochId]);
  const assertActive = useCallback(() => {
    if (!active.current || !isCurrentScope())
      throw new Error("Review session ended");
  }, [isCurrentScope]);
  const signTypedDataAsync = client.signTypedData;
  const queryClient = useQueryClient();

  const sign = useCallback(async () => {
    if (internal.phase !== "IDLE") return;

    try {
      // 1. Idempotently seal/repair the unsigned review snapshot.
      dispatch({ type: "START_FETCH" });
      await sealReviewSnapshot(client, epochId);
      assertActive();

      // 2. Fetch EIP-712 typed data from server.
      const typedData = await fetchSignData(client, epochId);
      assertActive();

      // 3. Request wallet signature
      dispatch({ type: "DATA_FETCHED" });
      if (!signTypedDataAsync)
        throw new Error("Connect a signing wallet to continue");
      const signature = await signTypedDataAsync({
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      });

      assertActive();

      // 4. POST signature to finalize endpoint
      dispatch({ type: "SIGNATURE_RECEIVED" });
      const result = await postFinalize(client, epochId, signature);
      assertActive();

      dispatch({ type: "FINALIZE_SUCCESS", result });
      void queryClient.invalidateQueries({ queryKey: queryKeyPrefix });
    } catch (err) {
      if (!active.current || !isCurrentScope()) return;
      const message =
        err instanceof ReviewRefusal
          ? err.message
          : "Signing was not completed. Check your wallet and refresh current values.";
      dispatch({ type: "FAIL", message });
    }
  }, [
    internal.phase,
    epochId,
    signTypedDataAsync,
    queryClient,
    client,
    queryKeyPrefix,
    isCurrentScope,
    assertActive,
  ]);

  const reset = useCallback(() => {
    dispatch({ type: "RESET" });
  }, []);

  return {
    state: derivePublicState(internal),
    sign,
    reset,
  };
}
