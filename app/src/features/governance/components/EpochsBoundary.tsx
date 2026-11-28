// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

"use client";
import { CUMULATIVE_MERKLE_DISTRIBUTOR_ABI } from "@cogni/cogni-contracts";
/** Bind node endpoints, session transport, URL state and wallet IO to the public epoch capability. */
import {
  type EpochNavigationState,
  type EpochsClient,
  EpochsProvider,
} from "@cogni/knowledge-base-ui/epochs";
import { getTransactionExplorerUrl } from "@cogni/node-shared/browser";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { type ReactNode, useId, useMemo, useRef } from "react";
import {
  useAccount,
  useChainId,
  useReadContract,
  useSignTypedData,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { WalletConnectButton } from "@/components";
import { getChainName } from "../lib/proposal-utils";

const epochEndpoint = (id: string, suffix: string) =>
  `/api/v1/attribution/epochs/${encodeURIComponent(id)}/${suffix}`;

export function EpochsBoundary({ children }: { readonly children: ReactNode }) {
  const { data: session, status } = useSession();
  // This host has fixed same-origin node endpoints. Rotate on the authenticated
  // principal/session boundary, independently of wallet or transport identity.
  const boundaryId = useId();
  const principal = session?.user?.id ?? null;
  const scope = useRef({ status, principal, generation: 0 });
  if (scope.current.status !== status || scope.current.principal !== principal)
    scope.current = {
      status,
      principal,
      generation: scope.current.generation + 1,
    };
  // The cache sees only this opaque generation, never the session identity.
  const dataScope = `${boundaryId}:${scope.current.generation}`;
  const { signTypedDataAsync } = useSignTypedData();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const client = useMemo<EpochsClient>(
    () => ({
      dataScope,
      request: (url, init) => fetch(url, init),
      signTypedData: (typedData) => signTypedDataAsync(typedData),
      endpoints: {
        epochs: "/api/v1/attribution/epochs",
        lifecycle: "/api/v1/attribution/settlement-lifecycle",
        collect: "/api/v1/attribution/epochs/collect",
        projections: (id) => epochEndpoint(id, "user-projections"),
        claimants: (id) => epochEndpoint(id, "claimants"),
        activity: (id) => epochEndpoint(id, "activity"),
        overrides: (id) => epochEndpoint(id, "review-subject-overrides"),
        review: (id) => epochEndpoint(id, "review"),
        signData: (id) => epochEndpoint(id, "sign-data"),
        finalize: (id) => epochEndpoint(id, "finalize"),
        distribution: (id) => epochEndpoint(id, "distribution-tx"),
      },
      wallet: {
        useAccount,
        useChainId,
        useReadContract,
        useSwitchChain,
        useWaitForTransactionReceipt,
        useWriteContract,
        distributorAbi: CUMULATIVE_MERKLE_DISTRIBUTOR_ABI,
        ConnectWalletComponent: WalletConnectButton,
        getChainName,
        getTransactionExplorerUrl: (chainId, hash) =>
          getTransactionExplorerUrl(chainId, hash),
      },
    }),
    [signTypedDataAsync, dataScope],
  );
  const rawOffset = params.get("epochOffset");
  const offset = rawOffset && /^\d+$/.test(rawOffset) ? Number(rawOffset) : 0;
  let contributorPages: Record<string, number> = {};
  try {
    const raw = JSON.parse(params.get("epochPages") ?? "{}");
    if (raw && typeof raw === "object" && !Array.isArray(raw))
      contributorPages = Object.fromEntries(
        Object.entries(raw).filter(
          ([key, value]) =>
            /^\d+$/.test(key) &&
            typeof value === "number" &&
            Number.isSafeInteger(value) &&
            value >= 0,
        ),
      ) as Record<string, number>;
  } catch {
    /* Invalid URL state uses the first page. */
  }
  const expandedEpochIds = params
    .getAll("expandedEpoch")
    .filter((id) => /^\d+$/.test(id))
    .slice(0, 200);
  const state: EpochNavigationState = {
    ...(expandedEpochIds.length ? { expandedEpochIds } : {}),
    contributorPages,
    historyOffset: Number.isSafeInteger(offset) ? offset : 0,
    selectedEpochId: params.get("epoch"),
  };
  const setState = (next: EpochNavigationState) => {
    const query = new URLSearchParams(params.toString());
    query.delete("expandedEpoch");
    for (const id of next.expandedEpochIds ?? [])
      query.append("expandedEpoch", id);
    if (
      next.contributorPages &&
      Object.values(next.contributorPages).some((value) => value > 0)
    )
      query.set("epochPages", JSON.stringify(next.contributorPages));
    else query.delete("epochPages");
    if (next.historyOffset)
      query.set("epochOffset", String(next.historyOffset));
    else query.delete("epochOffset");
    if (next.selectedEpochId) query.set("epoch", next.selectedEpochId);
    else query.delete("epoch");
    router.replace(`${pathname}${query.size ? `?${query}` : ""}`, {
      scroll: false,
    });
  };
  return (
    <EpochsProvider client={client} state={state} onStateChange={setState}>
      {children}
    </EpochsProvider>
  );
}
