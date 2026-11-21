// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

"use client";
/** Node-owned transport, URL state and wallet IO. Shared controls never choose an auth identity or endpoint. */
import {
  createContext,
  useContext,
  useState,
  type ReactNode,
  type ComponentType,
} from "react";
import type { Abi } from "viem";
import type { SignDataResponse } from "./hooks/useSignEpoch";

export interface EpochEndpoints {
  readonly epochs: string;
  readonly lifecycle: string;
  readonly collect: string;
  readonly projections: (epochId: string) => string;
  readonly claimants: (epochId: string) => string;
  readonly activity: (epochId: string) => string;
  readonly overrides: (epochId: string) => string;
  readonly review: (epochId: string) => string;
  readonly signData: (epochId: string) => string;
  readonly finalize: (epochId: string) => string;
  readonly distribution: (epochId: string) => string;
}
export type EpochWallet = Pick<
  typeof import("wagmi"),
  | "useAccount"
  | "useChainId"
  | "useReadContract"
  | "useSwitchChain"
  | "useWaitForTransactionReceipt"
  | "useWriteContract"
> & {
  readonly distributorAbi: Abi;
  readonly ConnectWalletComponent: ComponentType;
  readonly getChainName: (chainId: number) => string;
  readonly getTransactionExplorerUrl: (
    chainId: number,
    hash: string
  ) => string | null;
};
export interface EpochsClient {
  readonly request: (url: string, init?: RequestInit) => Promise<Response>;
  readonly endpoints: EpochEndpoints;
  readonly wallet: EpochWallet;
  readonly signTypedData?: (data: SignDataResponse) => Promise<string>;
}
export interface EpochNavigationState {
  readonly historyOffset: number;
  readonly selectedEpochId: string | null;
  readonly expandedEpochIds?: readonly string[];
  readonly contributorPages?: Readonly<Record<string, number>>;
}
interface EpochContextValue {
  readonly client: EpochsClient;
  readonly state: EpochNavigationState;
  readonly setState: (state: EpochNavigationState) => void;
}
const EpochContext = createContext<EpochContextValue | null>(null);
export function EpochsProvider({
  client,
  state,
  onStateChange,
  children,
}: {
  readonly client: EpochsClient;
  readonly state?: EpochNavigationState;
  readonly onStateChange?: (state: EpochNavigationState) => void;
  readonly children: ReactNode;
}) {
  const [localState, setLocalState] = useState<EpochNavigationState>({
    historyOffset: 0,
    selectedEpochId: null,
  });
  return (
    <EpochContext.Provider
      value={{
        client,
        state: state ?? localState,
        setState: onStateChange ?? setLocalState,
      }}
    >
      {children}
    </EpochContext.Provider>
  );
}
export function useEpochContext(): EpochContextValue {
  const context = useContext(EpochContext);
  if (!context)
    throw new Error("EpochsProvider is required for epoch controls");
  return context;
}
export function withEpochQuery(
  url: string,
  params: Record<string, string | number>
) {
  return `${url}${url.includes("?") ? "&" : "?"}${new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]))}`;
}
