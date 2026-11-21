// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

"use client";
import { useQueryClient } from "@tanstack/react-query";
/** Node-owned transport, URL state and wallet IO. Shared controls never choose an auth identity or endpoint. */
import {
  type ComponentType,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
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
    hash: string,
  ) => string | null;
};
export interface EpochsClient {
  /** Opaque host generation. Rotate on principal, node, authorization or endpoint changes. Never a credential or identity. */
  readonly dataScope: string;
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
  readonly queryKeyPrefix: readonly string[];
  readonly isCurrentScope: () => boolean;
  readonly client: EpochsClient;
  readonly state: EpochNavigationState;
  readonly setState: (state: EpochNavigationState) => void;
}
const EpochContext = createContext<EpochContextValue | null>(null);
function EpochScope({
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
  const queryClient = useQueryClient();
  const id = useId();
  const lifetime = useRef(new AbortController());
  const queryKeyPrefix = useMemo(() => ["governance", "epoch-scope", id], [id]);
  useLayoutEffect(() => {
    // Effect replay in StrictMode must create a live boundary before query effects.
    if (lifetime.current.signal.aborted)
      lifetime.current = new AbortController();
    return () => {
      lifetime.current.abort();
      void queryClient.cancelQueries({ queryKey: queryKeyPrefix });
      queryClient.removeQueries({ queryKey: queryKeyPrefix });
    };
  }, [queryClient, queryKeyPrefix]);
  const scopedClient = useMemo<EpochsClient>(
    () => ({
      ...client,
      request: async (url, init) => {
        const boundary = lifetime.current;
        boundary.signal.throwIfAborted();
        const response = await client.request(url, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([boundary.signal, init.signal])
            : boundary.signal,
        });
        boundary.signal.throwIfAborted();
        return response;
      },
    }),
    [client, lifetime],
  );
  const isCurrentScope = useCallback(
    () => !lifetime.current.signal.aborted,
    [],
  );
  const [localState, setLocalState] = useState<EpochNavigationState>({
    historyOffset: 0,
    selectedEpochId: null,
  });
  return (
    <EpochContext.Provider
      value={{
        client: scopedClient,
        queryKeyPrefix,
        isCurrentScope,
        state: state ?? localState,
        setState: onStateChange ?? setLocalState,
      }}
    >
      {children}
    </EpochContext.Provider>
  );
}
/** Shared local state and query lifetime end at the host's explicit data-scope boundary. */
export function EpochsProvider(props: Parameters<typeof EpochScope>[0]) {
  return <EpochScope key={props.client.dataScope} {...props} />;
}
export function useEpochContext(): EpochContextValue {
  const context = useContext(EpochContext);
  if (!context)
    throw new Error("EpochsProvider is required for epoch controls");
  return context;
}
export function withEpochQuery(
  url: string,
  params: Record<string, string | number>,
) {
  return `${url}${url.includes("?") ? "&" : "?"}${new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]))}`;
}
