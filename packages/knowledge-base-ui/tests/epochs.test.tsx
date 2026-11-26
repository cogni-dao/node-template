// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

// @vitest-environment jsdom
/** Public-entry fixtures exercise the whole epoch capability without node app imports or real wallet actions. */
import "@testing-library/jest-dom/vitest";
import type { FinalizeEpochOutput } from "@cogni/attribution-ledger/contracts";
import { DAO_ABI } from "@cogni/attribution-ledger/distribution/publish-permission";
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactElement, type ReactNode, StrictMode, useState } from "react";
import { decodeFunctionData } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchEpochView } from "../src/epochs/hooks/useEpochsPage";
import {
  type ApiIngestionReceipt,
  applyOverridesToEpochView,
  CurrentEpochView,
  composeEpochView,
  composeEpochViewFromClaimants,
  composeEpochViewFromSummary,
  type EpochDto,
  type EpochNavigationState,
  type EpochsClient,
  EpochsProvider,
  type EpochWallet,
  type FinishEpochWorkspaceData,
  ExecuteDistributionPanel,
  ReviewView,
  type SignDataResponse,
  useCollectEpoch,
} from "../src/epochs";

vi.mock("recharts", async (original) => {
  const actual = await original<typeof import("recharts")>();
  const React = await import("react");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      React.createElement(
        "div",
        {},
        React.cloneElement(children as ReactElement<Record<string, unknown>>, {
          width: 360,
          height: 192,
        }),
      ),
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  onlineManager.setOnline(true);
});
const WALLET = `0x${"11".repeat(20)}` as const;
const ZERO = `0x${"00".repeat(32)}` as const;
const ROOT = `0x${"44".repeat(32)}` as const;
const epoch: EpochDto = {
  id: "15",
  status: "open",
  periodStart: "2026-11-16T00:00:00Z",
  periodEnd: "2026-11-23T00:00:00Z",
  poolTotalCredits: null,
  weightConfig: { "github:pr_merged": 1000 },
};
const past: EpochDto = {
  ...epoch,
  id: "14",
  status: "finalized",
  poolTotalCredits: "100",
};
const event = (id: string, user = "a") => ({
  receiptId: id,
  source: "github",
  eventType: "pr_merged",
  platformUserId: user,
  platformLogin: "Alpha",
  artifactUrl: `https://example.com/${id}`,
  metadata: { title: `Contribution ${id}` },
  eventTime: epoch.periodStart,
  selection: { userId: user, included: true, weightOverrideMilli: null },
});
const typedData: SignDataResponse = {
  domain: { name: "Cogni Attribution", version: "2", chainId: 8453 },
  types: { AttributionStatement: [] },
  primaryType: "AttributionStatement",
  message: {
    nodeId: "node",
    scopeId: "scope",
    epochId: "15",
    deploymentEnvironment: "candidate-a",
    finalAllocationSetHash: "fixed-hash",
    poolTotalCredits: "100",
  },
};

const finalizeResponse = {
  statementId: "fixture-statement",
  poolTotalCredits: "100",
  finalAllocationSetHash: "fixed-hash",
  statementLineCount: 1,
  cumulativeDistribution: {
    distributionId: "fixture-distribution",
    merkleRoot: ROOT,
    mintDelta: "100",
    cumulativeTotal: "100",
    leafCount: 1,
    tokenAddress: WALLET,
    chainId: 8453,
    distributorAddress: WALLET,
  },
} satisfies FinalizeEpochOutput;

function fixture(initialNavigation?: EpochNavigationState) {
  let savedNavigation: EpochNavigationState = initialNavigation ?? {
    historyOffset: 0,
    selectedEpochId: null,
  };
  const state = {
    current: epoch as EpochDto | null,
    scope: "fixture-scope",
    reviewEpochId: "15",
    empty: false,
    failList: false,
    failLifecycle: false,
    events: [event("r1"), event("r2")] as ApiIngestionReceipt[],
    history: [past],
    failReceipts: false,
    failOverrideMethod: null as "GET" | "PATCH" | "DELETE" | null,
    collectStatus: 200,
    kind: "finalize" as "open_review" | "finalize" | "publish",
    isNodeAdmin: true,
    connected: true,
    chainId: 8453,
    permission: "authorized",
    published: false,
    pendingPublish: false,
    confirmedPublish: false,
    nullExplorer: false,
    failRootRefetch: false,
    rootRefetch: null as (() => Promise<void>) | null,
    error: null as Error | null,
    overrides: [] as {
      id: string;
      subjectRef: string;
      overrideUnits: string;
      overrideReason: string | null;
    }[],
  };
  const requests: { url: string; method: string }[] = [];
  const writeContract = vi.fn();
  const switchChain = vi.fn();
  function useReadContract(args: {
    functionName: "hasPermission";
    args: readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`];
  }): {
    data: boolean | undefined;
    isLoading: boolean;
    error: null;
    refetch: () => Promise<void>;
  };
  function useReadContract(args: { functionName: "merkleRoot" }): {
    data: `0x${string}`;
    isLoading: boolean;
    error: null;
    refetch: () => Promise<void>;
  };
  function useReadContract(args: {
    functionName: "hasPermission" | "merkleRoot";
    args?: readonly [
      `0x${string}`,
      `0x${string}`,
      `0x${string}`,
      `0x${string}`,
    ];
  }): {
    data: boolean | `0x${string}` | undefined;
    isLoading: boolean;
    error: null;
    refetch: () => Promise<void>;
  } {
    if (args.functionName === "merkleRoot")
      return {
        data: state.published ? ROOT : ZERO,
        isLoading: false,
        error: null,
        refetch: async () => {
          await state.rootRefetch?.();
          if (state.failRootRefetch)
            throw new Error("fixture root read unavailable");
        },
      };
    const decoded = args.args?.[3]
      ? decodeFunctionData({
          abi: DAO_ABI,
          data: args.args[3],
        })
      : null;
    const allowed =
      decoded?.functionName === "execute" && decoded.args[2] === 0n;
    return {
      data:
        state.permission === "unknown"
          ? undefined
          : state.permission === "authorized" && allowed,
      isLoading: state.permission === "unknown",
      error: null,
      refetch: async () => undefined,
    };
  }
  const wallet = {
    useAccount: () => ({
      address: state.connected ? WALLET : undefined,
      isConnected: state.connected,
    }),
    useChainId: () => state.chainId,
    useSwitchChain: () => ({ switchChain }),
    useWriteContract: () => ({
      writeContract,
      isPending: state.pendingPublish,
      error: state.error,
      data: state.confirmedPublish ? ROOT : undefined,
    }),
    useWaitForTransactionReceipt: () => ({
      isLoading: false,
      isSuccess: state.confirmedPublish,
    }),
    useReadContract,
    distributorAbi: [
      {
        type: "function",
        name: "setMerkleRoot",
        stateMutability: "nonpayable",
        inputs: [{ type: "bytes32" }],
        outputs: [],
      },
    ],
    ConnectWalletComponent: () => (
      <button type="button">Connect fixture wallet</button>
    ),
    getChainName: () => "Base",
    getTransactionExplorerUrl: () => state.nullExplorer ? null : "https://example.com/tx",
  } satisfies EpochWallet;
  const client: EpochsClient = {
    dataScope: "fixture-scope",
    wallet,
    signTypedData: vi.fn(async () => "0xfixture-signature"),
    endpoints: {
      epochs: "/fixture/epochs",
      lifecycle: "/fixture/lifecycle",
      collect: "/fixture/collect",
      projections: (id) => `/fixture/${id}/projections`,
      claimants: (id) => `/fixture/${id}/claimants`,
      activity: (id) => `/fixture/${id}/activity`,
      overrides: (id) => `/fixture/${id}/overrides`,
      review: (id) => `/fixture/${id}/review`,
      signData: (id) => `/fixture/${id}/sign-data`,
      finalize: (id) => `/fixture/${id}/finalize`,
      distribution: (id) => `/fixture/${id}/distribution`,
    },
    request: async (url, init) => {
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      const parsed = new URL(url, "https://fixture.invalid");
      const path = parsed.pathname;
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (path === "/fixture/epochs")
        return state.failList
          ? json({ error: "fixture unavailable" }, 500)
          : json({
              current: state.empty ? null : state.current,
              epochs: state.empty
                ? []
                : state.history.slice(
                    Number(parsed.searchParams.get("offset") ?? 0),
                    Number(parsed.searchParams.get("offset") ?? 0) + 200,
                  ),
              total: state.empty ? 0 : state.history.length,
            });
      if (path === "/fixture/lifecycle")
        return state.failLifecycle
          ? json({}, 503)
          : json({
              publicationEvidence: "not_published",
              liveRevision: null,
              latestRevision: null,
              epochs: [],
              finishSelection: {
                kind: state.kind,
                epoch: {
                  ...epoch,
                  id: state.reviewEpochId,
                  status:
                    state.kind === "open_review"
                      ? "open"
                      : state.kind === "publish"
                        ? "finalized"
                        : "review",
                  approvers: [WALLET],
                },
                lifecycle: null,
              },
            });
      if (path === "/fixture/collect")
        return state.collectStatus === 200
          ? json({ workflowId: "fixture" })
          : json(
              { error: "fixture sync error", retryAfterSeconds: 1 },
              state.collectStatus,
            );
      if (path.endsWith("/projections") || path.endsWith("/claimants")) {
        const groups = new Map<
          string,
          {
            claimantKey: string;
            claimantKind: "user" | "identity";
            isLinked: boolean;
            displayName: string | null;
            claimantLabel: string;
            units: bigint;
            receiptCount: number;
          }
        >();
        const unresolved = new Map<
          string,
          {
            claimantKey: string;
            source: string;
            platformLogin: string | null;
            eventCount: number;
          }
        >();
        for (const receipt of state.events) {
          if (!receipt.selection?.included) continue;
          const user = receipt.selection.userId;
          const claimantKey = user
            ? `user:${user}`
            : `identity:${receipt.source}:${receipt.platformUserId}`;
          if (!user) {
            const identity = unresolved.get(claimantKey) ?? {
              claimantKey,
              source: receipt.source,
              platformLogin: receipt.platformLogin,
              eventCount: 0,
            };
            identity.eventCount++;
            unresolved.set(claimantKey, identity);
          }
          const base = BigInt(
            receipt.selection.weightOverrideMilli ??
              epoch.weightConfig[`${receipt.source}:${receipt.eventType}`] ??
              0,
          );
          if (base <= 0n) continue;
          const units = BigInt(
            state.overrides.find(
              (item) => item.subjectRef === receipt.receiptId,
            )?.overrideUnits ?? base,
          );
          const group = groups.get(claimantKey) ?? {
            claimantKey,
            claimantKind: user ? "user" : "identity",
            isLinked: !!user,
            displayName: receipt.platformLogin,
            claimantLabel: user ? "Linked account" : "GitHub account",
            units: 0n,
            receiptCount: 0,
          };
          group.units += units;
          group.receiptCount++;
          groups.set(claimantKey, group);
        }
        const all = [...groups.values()].sort((a, b) =>
          a.units === b.units
            ? a.claimantKey.localeCompare(b.claimantKey)
            : a.units > b.units
              ? -1
              : 1,
        );
        const totalUnits = all.reduce((sum, item) => sum + item.units, 0n);
        const offset = Number(parsed.searchParams.get("offset") ?? 0);
        return json({
          epochId: path.split("/")[2],
          items: all.slice(offset, offset + 200).map((item) => ({
            ...item,
            units: String(item.units),
            creditShare: totalUnits
              ? Number((item.units * 1000n) / totalUnits) / 10
              : 0,
          })),
          total: all.length,
          totalUnits: String(totalUnits),
          totalPoints: String(
            all.reduce((sum, item) => sum + (item.units + 500n) / 1000n, 0n),
          ),
          totalReceiptCount: all.reduce(
            (sum, item) => sum + item.receiptCount,
            0,
          ),
          unresolvedCount: [...unresolved.values()].reduce(
            (sum, item) => sum + item.eventCount,
            0,
          ),
          unresolvedActivityTotal: unresolved.size,
          unresolvedActivities: [...unresolved.values()].slice(0, 200),
          limit: 200,
          offset,
        });
      }
      if (path.endsWith("/activity")) {
        const claimantKey = parsed.searchParams.get("claimantKey");
        if (claimantKey && state.failReceipts)
          return json({ error: "fixture receipt failure" }, 503);
        const all = state.events.filter(
          (receipt) =>
            !claimantKey ||
            claimantKey ===
              (receipt.selection?.userId
                ? `user:${receipt.selection.userId}`
                : `identity:${receipt.source}:${receipt.platformUserId}`),
        );
        const offset = Number(parsed.searchParams.get("offset") ?? 0);
        const limit = Number(parsed.searchParams.get("limit") ?? 200);
        return json({
          epochId: path.split("/")[2],
          total: all.length,
          events: all.slice(offset, offset + limit),
        });
      }
      if (path.endsWith("/overrides")) {
        if (method === state.failOverrideMethod)
          return json({ error: "fixture override failure" }, 503);
        if (method === "PATCH") {
          const body = JSON.parse(String(init?.body));
          state.overrides = body.overrides.map(
            (item: {
              subjectRef: string;
              overrideUnits: string;
              overrideReason: string | null;
            }) => ({
              ...item,
              overrideUnits: BigInt(item.overrideUnits).toString(),
              id: "override",
            }),
          );
        }
        if (method === "DELETE") state.overrides = [];
        return json({ overrides: state.overrides });
      }
      if (path.endsWith("/review")) {
        state.kind = "finalize";
        return json({ epoch: { id: "15", status: "review" } });
      }
      if (path.endsWith("/sign-data")) return json(typedData);
      if (path.endsWith("/finalize")) return json(finalizeResponse);
      if (path.endsWith("/distribution"))
        return json({
          epochId: "15",
          settlementRevisionId: "revision",
          settlementSequence: 1,
          merkleRoot: ROOT,
          mintDelta: "1000000000000000000",
          distributorAddress: WALLET,
          tokenAddress: WALLET,
          daoAddress: WALLET,
          pluginAddress: WALLET,
          chainId: 8453,
          alreadyExecutedRoot: ZERO,
        });
      throw new Error(`Unexpected fixture request ${method} ${url}`);
    },
  };
  Object.defineProperty(client, "dataScope", { get: () => state.scope });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => {
    const [navigation, setNavigation] = useState(savedNavigation);
    return (
      <QueryClientProvider client={queryClient}>
        <EpochsProvider
          client={client}
          state={navigation}
          onStateChange={(next) => {
            savedNavigation = next;
            setNavigation(next);
          }}
        >
          {children}
        </EpochsProvider>
      </QueryClientProvider>
    );
  };
  return {
    state,
    requests,
    client,
    wrapper,
    queryClient,
    writeContract,
    switchChain,
    getNavigation: () => savedNavigation,
  };
}

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined)
    throw new Error("Expected a rendered fixture control");
  return value;
}
function containingRow(element: Element): HTMLTableRowElement {
  const row = element.closest("tr");
  if (!row) throw new Error("Expected a rendered fixture row");
  return row;
}

function denseHistory(): EpochDto[] {
  return Array.from({ length: 201 }, (_, i) => ({
    ...past,
    id: i === 0 ? "14" : String(1000 + i),
  }));
}

function denseContributors(): ApiIngestionReceipt[] {
  return Array.from({ length: 201 }, (_, i) => ({
    ...event(`dense-${i}`, `u${String(i).padStart(3, "0")}`),
    platformLogin:
      i === 200
        ? "Late contributor"
        : i === 0
          ? "Alpha"
          : `Contributor ${i + 1}`,
  }));
}

// Dense pages make role/name scans expensive in jsdom. Locate the unique visible
// identity first, then assert and interact with its actual table row.
async function contributorRow(name: string) {
  const label = await screen.findByText(
    name,
    { selector: "td span" },
    { timeout: 12_000 },
  );
  const row = label.closest("tr");
  expect(row).not.toBeNull();
  expect(row).toHaveAccessibleName(new RegExp(name));
  return row as HTMLTableRowElement;
}

describe("public epochs capability", () => {
  it.each([
    false,
    true,
  ])("retains exact drafts when a cached override read fails (prior: %s)", async (prior) => {
    const f = fixture();
    if (prior)
      f.state.overrides = [
        {
          id: "old",
          subjectRef: "r1",
          overrideUnits: "500",
          overrideReason: "Prior",
        },
      ];
    render(
      <ReviewView
        walletAddress={WALLET}
        isNodeAdmin
        operatorSetupUrl="https://example.com/setup"
      />,
      { wrapper: f.wrapper },
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Sign & Finalize" }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      within(screen.getByRole("row", { name: /Alpha/ })).getByRole("button", {
        name: "Expand details",
      }),
    );
    fireEvent.click(
      first(await screen.findAllByRole("button", { name: "Adjust weight" })),
    );
    fireEvent.change(screen.getByLabelText("Override weight (units)"), {
      target: { value: "000" },
    });
    fireEvent.change(screen.getByLabelText("Reason (optional)"), {
      target: { value: "  Keep exact text  " },
    });
    f.state.failOverrideMethod = "GET";
    await act(async () => {
      await f.queryClient.refetchQueries({
        predicate: (q) => q.queryKey.includes("review-subject-overrides"),
      });
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Sign & Finalize" }),
      ).toBeDisabled(),
    );
    expect(screen.getByLabelText("Override weight (units)")).toHaveValue("000");
    expect(screen.getByLabelText("Reason (optional)")).toHaveValue(
      "  Keep exact text  ",
    );
    f.state.failOverrideMethod = null;
    fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Sign & Finalize" }),
      ).toBeEnabled(),
    );
    expect(screen.getByLabelText("Override weight (units)")).toHaveValue("000");
  });

  it("round-trips controlled navigation and toggles disclosure from the keyboard", async () => {
    const f = fixture();
    const user = userEvent.setup();
    const view = render(<CurrentEpochView />, { wrapper: f.wrapper });
    const row = await screen.findByRole(
      "row",
      { name: /Alpha/ },
      { timeout: 5000 },
    );
    const expand = within(row).getByRole("button", { name: "Expand details" });
    expand.focus();
    await user.keyboard(" ");
    expect(expand).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Enter}");
    expect(expand).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(
      within(containingRow(screen.getByText("14"))).getByRole("button", {
        name: "Expand details",
      }),
    );
    const saved = JSON.parse(
      JSON.stringify(f.getNavigation()),
    ) as EpochNavigationState;
    expect(saved.expandedEpochIds).toEqual(["14"]);
    view.unmount();
    const restored = fixture(saved);
    render(<CurrentEpochView />, { wrapper: restored.wrapper });
    await screen.findByRole("button", { name: "Collapse details" });
    await waitFor(() =>
      expect(
        restored.requests.filter((request) => request.url.includes("/14/")),
      ).toHaveLength(2),
    );
  });

  it("loads review contributor 201 and saves and resets its off-page receipt", async () => {
    const f = fixture();
    f.state.events = denseContributors();
    const user = userEvent.setup();
    render(
      <ReviewView
        walletAddress={WALLET}
        isNodeAdmin
        operatorSetupUrl="https://example.com/setup"
      />,
      { wrapper: f.wrapper },
    );
    await contributorRow("Alpha");
    expect(
      screen.queryByRole("row", { name: /Late contributor/ }),
    ).not.toBeInTheDocument();
    const more = screen.getByRole("button", { name: "More contributors" });
    more.focus();
    await user.keyboard("{Enter}");
    const late = await contributorRow("Late contributor");
    expect(within(late).getByText("201")).toBeVisible();
    expect(
      f.requests.some((r) =>
        r.url.includes("/projections?view=summary&limit=200&offset=200"),
      ),
    ).toBe(true);
    fireEvent.click(
      within(late).getByRole("button", { name: "Expand details" }),
    );
    await screen.findByRole("link", { name: "Contribution dense-200" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Adjust weight" }),
    );
    fireEvent.change(screen.getByLabelText("Override weight (units)"), {
      target: { value: "0" },
    });
    fireEvent.change(screen.getByLabelText("Reason (optional)"), {
      target: { value: "Off-page correction" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("1 active weight override");
    await waitFor(() =>
      expect(
        within(screen.getByRole("row", { name: /Late contributor/ })).getByText(
          "0",
        ),
      ).toBeVisible(),
    );
    expect(f.state.overrides[0]).toMatchObject({
      subjectRef: "dense-200",
      overrideUnits: "0",
      overrideReason: "Off-page correction",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Reset to original weight" }),
    );
    await waitFor(() => expect(f.state.overrides).toHaveLength(0));
    await waitFor(() =>
      expect(
        within(screen.getByRole("row", { name: /Late contributor/ })).getByText(
          "1000",
        ),
      ).toBeVisible(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Previous contributors" }),
    );
    await contributorRow("Alpha");
    expect(f.getNavigation().contributorPages?.["15"]).toBe(0);
  }, 20_000);

  it.each([
    null,
    "a",
  ])("keeps a zero override reset reachable for fallback identity %s", async (userId) => {
    const f = fixture();
    f.state.events = [
      {
        ...event("zero"),
        selection: { userId, included: true, weightOverrideMilli: null },
      },
    ];
    render(
      <ReviewView
        walletAddress={WALLET}
        isNodeAdmin
        operatorSetupUrl="https://example.com/setup"
      />,
      { wrapper: f.wrapper },
    );
    fireEvent.click(
      within(
        await screen.findByRole("row", { name: /Alpha/ }, { timeout: 5000 }),
      ).getByRole("button", { name: "Expand details" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Adjust weight" }),
    );
    fireEvent.change(screen.getByLabelText("Override weight (units)"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("1 active weight override");
    await waitFor(() =>
      expect(
        within(screen.getByRole("row", { name: /Alpha/ })).getByText("0"),
      ).toBeVisible(),
    );
    const original = applyOverridesToEpochView(
      composeEpochView(epoch, [], f.state.events),
      new Map([["zero", { subjectRef: "zero", overrideUnits: "0" }]]),
    );
    const summary = await (
      await f.client.request("/fixture/15/projections?offset=0")
    ).json();
    const repaired = composeEpochViewFromSummary(
      epoch,
      summary,
      f.state.events,
    );
    expect(
      repaired.contributors.map(({ claimantKey, units, receiptCount }) => ({
        claimantKey,
        units,
        receiptCount,
      })),
    ).toEqual(
      original.contributors.map(({ claimantKey, units, receiptCount }) => ({
        claimantKey,
        units,
        receiptCount,
      })),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Reset to original weight" }),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole("row", { name: /Alpha/ })).getByText("1000"),
      ).toBeVisible(),
    );
  });

  it("waits for activity identity resolution before reading the summary", async () => {
    const f = fixture();
    f.state.events = [{ ...event("resolved"), selection: { userId: null, included: true, weightOverrideMilli: null } }];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const request = f.client.request;
    const client: EpochsClient = { ...f.client, request: async (url, init) => {
      if (url.includes("/activity")) {
        await pending;
        f.state.events = [{ ...event("resolved"), selection: { userId: "a", included: true, weightOverrideMilli: null } }];
      }
      return request(url, init);
    } };
    const result = fetchEpochView(client, epoch);
    await Promise.resolve();
    expect(f.requests.some((r) => r.url.includes("/projections"))).toBe(false);
    release();
    const view = await result;
    expect(view.contributors[0]?.claimantKey).toBe("user:a");
    expect(view.contributors[0]?.receipts.map((receipt) => receipt.receiptId)).toEqual(["resolved"]);
  });

  it("keeps complete unresolved facts independent of contributor and activity windows", async () => {
    const f = fixture();
    f.state.events = denseContributors();
    f.state.events.push(
      ...["external-1", "external-2"].map((id) => ({
        ...event(id),
        platformUserId: id,
        platformLogin: "Same label",
        selection: { userId: null, included: true, weightOverrideMilli: null },
      })),
    );
    const response = await f.client.request("/fixture/15/projections?offset=0");
    const summary = await response.json();
    const linkedPage = f.state.events.slice(0, 200);
    const first = composeEpochViewFromSummary(epoch, summary, linkedPage);
    const changedActivity = composeEpochViewFromSummary(
      epoch,
      summary,
      f.state.events.slice(200),
    );
    const lastSummary = await (
      await f.client.request("/fixture/15/projections?offset=200")
    ).json();
    const changedContributor = composeEpochViewFromSummary(
      epoch,
      lastSummary,
      [],
    );
    for (const view of [first, changedActivity, changedContributor]) {
      expect(view.unresolvedCount).toBe(2);
      expect(view.unresolvedActivities).toHaveLength(2);
      expect(view.unresolvedActivities.map((item) => item.claimantKey)).toEqual(
        ["identity:github:external-1", "identity:github:external-2"],
      );
      expect(view.totalUnits).toBe("203000");
    }
  });

  // Dense DOM accessibility fixture; native 360/1280px geometry remains candidate qualification.
  it("keeps dense contributor identity visible and its disclosure keyboard reachable", async () => {
    const f = fixture();
    f.state.events = denseContributors();
    const user = userEvent.setup();
    render(<CurrentEpochView />, { wrapper: f.wrapper });
    const row = await contributorRow("Alpha");
    expect(within(row).getByText("Alpha")).toBeVisible();
    const expand = within(row).getByRole("button", { name: "Expand details" });
    expand.focus();
    await user.keyboard("{Enter}");
    expect(expand).toHaveAttribute("aria-expanded", "true");
    expect(
      await screen.findByRole("link", { name: "Contribution dense-0" }),
    ).toBeVisible();
  }, 20_000);

  it("loads four reads regardless of history and fetches a past epoch only on expansion", async () => {
    const f = fixture();
    f.state.history = denseHistory();
    render(<CurrentEpochView />, { wrapper: f.wrapper });
    await contributorRow("Alpha");
    expect(
      f.requests.filter((request) => request.method === "GET"),
    ).toHaveLength(4);
    expect(f.requests.some((request) => request.url.includes("/14/"))).toBe(
      false,
    );
    fireEvent.click(
      within(containingRow(screen.getByText("14"))).getByRole("button", {
        name: "Expand details",
      }),
    );
    await waitFor(() =>
      expect(
        f.requests.filter((request) => request.url.includes("/14/")),
      ).toHaveLength(2),
    );
    expect(
      screen.getByRole("button", { name: "Collapse details" }),
    ).toHaveAttribute("aria-expanded", "true");
  }, 20_000);

  it("keeps the current epoch while changing the history page and exposes contributor pages", async () => {
    const f = fixture();
    f.state.events = denseContributors();
    f.state.history = denseHistory();
    render(<CurrentEpochView />, { wrapper: f.wrapper });
    await contributorRow("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "More epochs" }));
    await waitFor(() =>
      expect(
        f.requests.some(
          (request) =>
            request.url.includes("view=overview") &&
            request.url.includes("offset=200"),
        ),
      ).toBe(true),
    );
    expect(
      screen.getByRole("button", { name: "Sync contributions" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "More contributors" }));
    await contributorRow("Late contributor");
    expect(screen.getByText("201 contributors")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Previous epochs" }));
    await screen.findByText("14");
    expect(f.getNavigation().historyOffset).toBe(0);
  }, 20_000);

  it("expands a contributor to bounded receipt pages and real receipt links", async () => {
    const f = fixture();
    f.state.events = Array.from({ length: 201 }, (_, i) => event(`r${i + 1}`));
    render(<CurrentEpochView />, { wrapper: f.wrapper });
    await screen.findByRole("row", { name: /Alpha/ }, { timeout: 5000 });
    fireEvent.click(
      within(screen.getByRole("row", { name: /Alpha/ })).getByRole("button", {
        name: "Expand details",
      }),
    );
    const link = await screen.findByRole("link", { name: "Contribution r1" });
    expect(link).toHaveAttribute("href", "https://example.com/r1");
    fireEvent.click(screen.getByRole("button", { name: "More contributions" }));
    await waitFor(() =>
      expect(
        f.requests.some(
          (request) =>
            request.url.includes("claimantKey=user%3Aa") &&
            request.url.includes("offset=50"),
        ),
      ).toBe(true),
    );
    await screen.findByRole("link", { name: "Contribution r51" });
    fireEvent.click(
      screen.getByRole("button", { name: "Previous contributions" }),
    );
    await screen.findByRole("link", { name: "Contribution r1" });
    expect(
      screen.queryByRole("link", { name: "Contribution r51" }),
    ).not.toBeInTheDocument();
  });

  it("resets receipt paging when a workspace generation replaces membership", async () => {
    const f = fixture();
    f.state.events = Array.from({ length: 70 }, (_, i) => event(`page-${i}`));
    render(<CurrentEpochView />, { wrapper: f.wrapper });
    fireEvent.click(
      within(await screen.findByRole("row", { name: /Alpha/ })).getByRole(
        "button",
        { name: "Expand details" }
      )
    );
    await screen.findByRole("link", { name: "Contribution page-0" });
    fireEvent.click(screen.getByRole("button", { name: "More contributions" }));
    await screen.findByRole("link", { name: "Contribution page-50" });
    f.state.events = f.state.events.slice(0, 20);
    await act(async () => {
      await f.queryClient.refetchQueries({
        predicate: (query) => query.queryKey.includes("view"),
      });
    });
    await screen.findByRole("link", { name: "Contribution page-0" });
    expect(
      screen.queryByRole("link", { name: "Contribution page-50" })
    ).not.toBeInTheDocument();
    const last = f.requests
      .filter((item) => item.url.includes("claimantKey="))
      .at(-1);
    expect(last?.url).toContain("offset=0");
  });

  it.each(["overview", "review"] as const)(
    "uses persisted membership for %s disclosures after partial identity persistence",
    async (surface) => {
      const f = fixture();
      f.state.events = [
        { ...event("linked"), platformLogin: "Linked" },
        {
          ...event("pending", "external"),
          platformLogin: "Pending",
          selection: {
            userId: null,
            included: true,
            weightOverrideMilli: null,
          },
        },
        {
          ...event("pending2", "external"),
          platformLogin: "Pending",
          selection: {
            userId: null,
            included: true,
            weightOverrideMilli: null,
          },
        },
      ];
      const request = f.client.request;
      vi.spyOn(f.client, "request").mockImplementation(async (url, init) => {
        const response = await request(url, init);
        if (url.includes("/activity") && !url.includes("claimantKey=")) {
          const body = await response.json();
          return new Response(
            JSON.stringify({
              ...body,
              events: body.events.map((item: ApiIngestionReceipt) => ({
                ...item,
                selection: { ...item.selection, userId: "a" },
              })),
            }),
            { status: 200 },
          );
        }
        return response;
      });
      if (surface === "review") await readyReview(f);
      else render(<CurrentEpochView />, { wrapper: f.wrapper });
      for (const name of ["Linked", "Pending"]) {
        const row = await screen.findByRole("row", { name: new RegExp(name) });
        fireEvent.click(
          within(row).getByRole("button", { name: "Expand details" }),
        );
      }
      for (const id of ["linked", "pending", "pending2"]) {
        expect(
          await screen.findAllByRole("link", { name: `Contribution ${id}` }),
        ).toHaveLength(1);
      }
      if (surface === "review")
        expect(
          screen.getAllByRole("button", { name: "Adjust weight" }),
        ).toHaveLength(3);
      expect(
        f.requests.filter((r) => r.url.includes("claimantKey=")),
      ).toHaveLength(2);
    },
  );

  it.each([
    ["overview", false, false, false],
    ["review", false, false, false],
    ["overview", true, false, false],
    ["review", true, false, false],
    ["review", true, true, false],
    ["overview", false, false, true],
  ] as const)("replaces expanded membership in %s (deferred: %s, draft: %s, Sync: %s)", async (surface, deferred, editing, sync) => {
    const f = fixture();
    f.state.events = [
      { ...event("linked"), platformLogin: "Linked" },
      ...["moving", "remaining"].map((id) => ({
        ...event(id, "external"),
        platformLogin: "Pending",
        selection: { userId: null, included: true, weightOverrideMilli: null },
      })),
    ];
    let recover = false;
    let holdIdentity = false;
    let recoveredSummary = false;
    let earlyDetail = false;
    const pending: {
      signal: AbortSignal | null | undefined;
      release: () => void;
    }[] = [];
    const request = f.client.request;
    vi.spyOn(f.client, "request").mockImplementation(async (url, init) => {
      const params = new URL(url, "https://fixture.invalid").searchParams;
      const workspaceActivity =
        url.includes("/activity") && !params.has("claimantKey");
      if (recover && params.has("claimantKey") && !recoveredSummary)
        earlyDetail = true;
      if (recover && workspaceActivity) {
        // Only A persists; B fails again. Both contributor keys survive.
        f.state.events = f.state.events.map((item) =>
          item.receiptId === "moving"
            ? {
                ...item,
                selection: {
                  ...item.selection,
                  userId: "a",
                  included: true,
                  weightOverrideMilli: null,
                },
              }
            : item
        );
      }
      const response = await request(url, init);
      if (recover && url.includes("/projections")) recoveredSummary = true;
      if (workspaceActivity) {
        const body = await response.json();
        // Resolution succeeds in the response even when persistence failed.
        return new Response(
          JSON.stringify({
            ...body,
            events: body.events.map((item: ApiIngestionReceipt) => ({
              ...item,
              selection: { ...item.selection, userId: "a" },
            })),
          }),
          { status: 200 }
        );
      }
      if (
        holdIdentity &&
        params.get("claimantKey") === "identity:github:external"
      ) {
        holdIdentity = false;
        return new Promise<Response>((resolve) =>
          pending.push({
            signal: init?.signal,
            release: () => resolve(response),
          })
        );
      }
      return response;
    });
    if (surface === "review") await readyReview(f);
    else render(<CurrentEpochView />, { wrapper: f.wrapper });
    const identityRow = await screen.findByRole("row", { name: /Pending/ });
    if (surface === "overview") expect(f.requests).toHaveLength(4);
    fireEvent.click(
      within(identityRow).getByRole("button", { name: "Expand details" })
    );
    await screen.findByRole("link", { name: "Contribution moving" });
    await screen.findByRole("link", { name: "Contribution remaining" });
    if (editing) {
      fireEvent.click(
        within(
          containingRow(
            screen.getByRole("link", { name: "Contribution moving" })
          )
        ).getByRole("button", { name: "Adjust weight" })
      );
      fireEvent.change(screen.getByLabelText("Override weight (units)"), {
        target: { value: "000" },
      });
    }
    let oldRead: Promise<void> | undefined;
    if (deferred) {
      holdIdentity = true;
      act(() => {
        oldRead = f.queryClient.refetchQueries({
          predicate: (query) => query.queryKey.includes("contributor"),
        });
      });
      await waitFor(() => expect(pending).toHaveLength(1));
    }
    recover = true;
    if (sync) {
      fireEvent.click(
        screen.getByRole("button", { name: "Sync contributions" })
      );
      await screen.findByText(/Sync started. Epoch data refreshed/);
    } else
      await act(async () => {
        await f.queryClient.refetchQueries({
          predicate: (query) =>
            surface === "review"
              ? query.queryKey.includes("finish-epoch")
              : query.queryKey.includes("view"),
        });
      });
    expect(
      within(await screen.findByRole("row", { name: /Pending/ })).getByRole(
        "button",
        { name: "Collapse details" }
      )
    ).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(
      within(await screen.findByRole("row", { name: /Linked/ })).getByRole(
        "button",
        { name: "Expand details" }
      )
    );
    await screen.findByRole("link", { name: "Contribution linked" });
    if (deferred) {
      // Complete the obsolete HTTP response after the new workspace and user detail.
      await act(async () => {
        for (const item of pending) item.release();
        await oldRead;
      });
    }
    await waitFor(() => {
      for (const id of editing
        ? ["remaining", "linked"]
        : ["moving", "remaining", "linked"])
        expect(
          screen.getAllByRole("link", { name: `Contribution ${id}` })
        ).toHaveLength(1);
    });
    if (editing) {
      expect(screen.getAllByLabelText("Override weight (units)")).toHaveLength(
        1
      );
      expect(screen.getByLabelText("Override weight (units)")).toHaveValue(
        "000"
      );
    }
    expect(earlyDetail).toBe(false);
    if (surface === "review")
      expect(
        screen.getAllByRole("button", { name: "Adjust weight" })
      ).toHaveLength(editing ? 2 : 3);
    if (deferred) expect(pending[0]?.signal?.aborted).toBe(true);
    const details = f.requests.filter((item) =>
      item.url.includes("claimantKey=")
    );
    for (const detail of details)
      expect(
        new URL(detail.url, "https://fixture.invalid").searchParams.get("limit")
      ).toBe("50");
  });

  it.each([
    ["overview", "error"],
    ["review", "error"],
    ["overview", "cancel"],
    ["review", "cancel"],
  ] as const)("retires membership when activity persists but workspace summary ends with %s/%s", async (surface, failure) => {
    const f = fixture();
    f.state.events = [
      { ...event("linked"), platformLogin: "Linked" },
      ...["moving", "remaining"].map((id) => ({
        ...event(id, "external"),
        platformLogin: "Pending",
        selection: { userId: null, included: true, weightOverrideMilli: null },
      })),
    ];
    let recover = false;
    let fail = true;
    let release: (() => void) | undefined;
    const request = f.client.request;
    vi.spyOn(f.client, "request").mockImplementation(async (url, init) => {
      if (recover && url.includes("/activity") && !url.includes("claimantKey="))
        f.state.events = f.state.events.map((item) =>
          item.receiptId === "moving"
            ? {
                ...item,
                selection: {
                  userId: "a",
                  included: true,
                  weightOverrideMilli: null,
                },
              }
            : item
        );
      const response = await request(url, init);
      if (recover && fail && url.includes("/projections")) {
        if (failure === "error") return new Response("{}", { status: 503 });
        return new Promise<Response>((resolve) => {
          release = () => resolve(response);
        });
      }
      return response;
    });
    if (surface === "review") await readyReview(f);
    else render(<CurrentEpochView />, { wrapper: f.wrapper });
    fireEvent.click(
      within(await screen.findByRole("row", { name: /Pending/ })).getByRole(
        "button",
        { name: "Expand details" }
      )
    );
    await screen.findByRole("link", { name: "Contribution moving" });
    const owner = (query: { queryKey: readonly unknown[] }) =>
      query.queryKey.includes(surface === "review" ? "finish-epoch" : "view");
    recover = true;
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = f.queryClient.refetchQueries({ predicate: owner });
    });
    if (failure === "cancel") {
      await waitFor(() => expect(release).toBeDefined());
      await act(async () => {
        await f.queryClient.cancelQueries({ predicate: owner });
        release?.();
        await refreshing;
      });
    } else
      await act(async () => {
        await refreshing;
      });
    await waitFor(() =>
      expect(
        screen.queryByRole("link", { name: "Contribution moving" })
      ).not.toBeInTheDocument()
    );
    {
      const before = f.requests.filter((item) =>
        item.url.includes("claimantKey=")
      ).length;
      fireEvent.click(
        within(await screen.findByRole("row", { name: /Linked/ })).getByRole(
          "button",
          { name: "Expand details" }
        )
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        f.requests.filter((item) => item.url.includes("claimantKey="))
      ).toHaveLength(before);
    }
    fail = false;
    await act(async () => {
      await f.queryClient.refetchQueries({ predicate: owner });
    });
    const userRow = await screen.findByRole("row", { name: /Linked/ });
    expect(
      within(userRow).getByRole("button", { name: "Collapse details" })
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      within(await screen.findByRole("row", { name: /Pending/ })).getByRole(
        "button",
        { name: "Collapse details" }
      )
    ).toHaveAttribute("aria-expanded", "true");
    await screen.findByRole("link", { name: "Contribution moving" });
    expect(
      screen.getAllByRole("link", { name: "Contribution moving" })
    ).toHaveLength(1);
  });

  it.each([
    "overview",
    "review",
  ] as const)("r5 keeps retired membership hidden after offline pause and reverting cancel in %s", async (surface) => {
    const f = fixture();
    if (surface === "review") await readyReview(f);
    else render(<CurrentEpochView />, { wrapper: f.wrapper });
    fireEvent.click(
      within(await screen.findByRole("row", { name: /Alpha/ })).getByRole(
        "button",
        { name: "Expand details" }
      )
    );
    await screen.findByRole("link", { name: "Contribution r1" });
    const owner = (query: { queryKey: readonly unknown[] }) =>
      query.queryKey.includes(surface === "review" ? "finish-epoch" : "view");
    // Keep an older detail response pending across the paused/cancelled parent.
    const request = f.client.request;
    let release: (() => void) | undefined;
    vi.spyOn(f.client, "request").mockImplementation(async (url, init) => {
      const response = await request(url, init);
      if (url.includes("claimantKey="))
        return new Promise<Response>((resolve) => {
          release = () => resolve(response);
        });
      return response;
    });
    let obsolete!: Promise<void>;
    act(() => {
      obsolete = f.queryClient.refetchQueries({
        predicate: (q) => q.queryKey.includes("contributor"),
      });
    });
    await waitFor(() => expect(release).toBeDefined());
    const before = f.requests.length;
    await act(async () => {
      onlineManager.setOnline(false);
      await f.queryClient.refetchQueries({ predicate: owner });
    });
    expect(
      f.queryClient.getQueryCache().findAll({ predicate: owner })[0]?.state
        .fetchStatus
    ).toBe("paused");
    expect(f.requests).toHaveLength(before);
    await waitFor(() =>
      expect(
        screen.queryByRole("link", { name: "Contribution r1" })
      ).not.toBeInTheDocument()
    );
    await act(async () => {
      await f.queryClient.cancelQueries({ predicate: owner });
    });
    expect(
      f.queryClient.getQueryCache().findAll({ predicate: owner })[0]?.state
        .fetchStatus
    ).toBe("idle");
    expect(onlineManager.isOnline()).toBe(false);
    expect(
      screen.queryByRole("link", { name: "Contribution r1" })
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("row", { name: /Alpha/ })).getByRole("button", {
        name: "Collapse details",
      })
    ).toHaveAttribute("aria-expanded", "true");
    if (surface === "review")
      expect(
        screen.queryByRole("button", { name: "Adjust weight" })
      ).not.toBeInTheDocument();
    await act(async () => {
      release?.();
      await obsolete;
    });
    expect(
      screen.queryByRole("link", { name: "Contribution r1" })
    ).not.toBeInTheDocument();
    vi.mocked(f.client.request).mockRestore();
    // A descendant's retained paused data cannot reopen membership either.
    await act(async () => {
      await f.queryClient.refetchQueries({
        predicate: (q) => q.queryKey.includes("contributor"),
      });
    });
    expect(
      screen.queryByRole("link", { name: "Contribution r1" })
    ).not.toBeInTheDocument();
    await act(async () => {
      onlineManager.setOnline(true);
      await f.queryClient.refetchQueries({ predicate: owner });
    });
    await screen.findByRole("link", { name: "Contribution r1" });
    expect(
      screen.getAllByRole("link", { name: "Contribution r1" })
    ).toHaveLength(1);
  });

  it.each([
    false,
    true,
  ])("r5 keeps a moved last-page draft reachable after the old claimant shrinks (accepted=%s)", async (accepted) => {
    const f = fixture();
    f.state.events = [
      ...Array.from({ length: 50 }, (_, i) => ({
        ...event(`remaining-${i}`, "external"),
        platformLogin: "Pending",
        selection: { userId: null, included: true, weightOverrideMilli: null },
      })),
      {
        ...event("moving", "external"),
        platformLogin: "Pending",
        selection: { userId: null, included: true, weightOverrideMilli: null },
      },
      { ...event("linked"), platformLogin: "Linked" },
    ];
    await readyReview(f);
    fireEvent.click(
      within(await screen.findByRole("row", { name: /Pending/ })).getByRole(
        "button",
        { name: "Expand details" }
      )
    );
    await screen.findByRole("link", { name: "Contribution remaining-0" });
    fireEvent.click(
      await screen.findByRole("button", { name: "More contributions" })
    );
    const moving = await screen.findByRole("link", {
      name: "Contribution moving",
    });
    fireEvent.click(
      within(containingRow(moving)).getByRole("button", {
        name: "Adjust weight",
      })
    );
    fireEvent.change(screen.getByLabelText("Override weight (units)"), {
      target: { value: "000" },
    });
    fireEvent.change(screen.getByLabelText("Reason (optional)"), {
      target: { value: "exact moved draft" },
    });
    if (accepted) {
      f.state.failList = true;
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByText("Saved. Could not verify current values.");
      expect(screen.getByLabelText("Override weight (units)")).toHaveValue(
        "000"
      );
      expect(screen.getByLabelText("Reason (optional)")).toHaveValue(
        "exact moved draft"
      );
      expect(f.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
      f.state.failList = false;
      f.state.failOverrideMethod = "GET";
    }
    f.state.events = f.state.events.map((item) =>
      item.receiptId === "moving"
        ? {
            ...item,
            platformLogin: "Linked",
            selection: {
              userId: "a",
              included: true,
              weightOverrideMilli: null,
            },
          }
        : item
    );
    await act(async () => {
      await f.queryClient.refetchQueries({
        predicate: (q) => q.queryKey.includes("finish-epoch"),
      });
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Override weight (units)")).toHaveValue(
        "000"
      )
    );
    expect(screen.getByLabelText("Reason (optional)")).toHaveValue(
      "exact moved draft"
    );
    expect(
      screen.queryByRole("link", { name: "Contribution moving" })
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole("row", { name: /Linked/ })).getByRole("button", {
        name: "Expand details",
      })
    );
    await screen.findByRole("link", { name: "Contribution linked" });
    await waitFor(() =>
      expect(screen.getAllByLabelText("Override weight (units)")).toHaveLength(
        1
      )
    );
    expect(screen.getByLabelText("Override weight (units)")).toHaveValue("000");
    // Once U's membership is verified, collapsing I cannot hide U's editor.
    fireEvent.click(
      within(screen.getByRole("row", { name: /Pending/ })).getByRole("button", {
        name: "Collapse details",
      })
    );
    expect(screen.getByLabelText("Override weight (units)")).toHaveValue("000");
    if (accepted) {
      expect(
        screen.getByText("Saved. Could not verify current values.")
      ).toBeInTheDocument();
      expect(f.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
      f.state.failOverrideMethod = null;
      fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));
    } else fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        f.state.overrides.find((o) => o.subjectRef === "moving")?.overrideUnits
      ).toBe("0")
    );
    await waitFor(() =>
      expect(
        screen.queryByLabelText("Override weight (units)")
      ).not.toBeInTheDocument()
    );
    fireEvent.click(
      within(
        containingRow(
          await screen.findByRole("link", { name: "Contribution moving" })
        )
      ).getByRole("button", { name: "Adjust weight" })
    );
    expect(screen.getByLabelText("Override weight (units)")).toHaveValue("0");
    expect(screen.getByLabelText("Reason (optional)")).toHaveValue(
      "exact moved draft"
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel weight adjustment" })
    );
    expect(
      screen.queryByLabelText("Override weight (units)")
    ).not.toBeInTheDocument();
  });

  it.each([
    false,
    true,
  ])("r7 keeps the 70-to-69 moved draft and known acceptance visible (accepted=%s)", async (accepted) => {
    const f = fixture();
    f.state.events = [
      ...Array.from({ length: 69 }, (_, i) => ({
        ...event(`remaining-${i}`, "external"),
        platformLogin: "Pending",
        selection: { userId: null, included: true, weightOverrideMilli: null },
      })),
      {
        ...event("moving", "external"),
        platformLogin: "Pending",
        selection: { userId: null, included: true, weightOverrideMilli: null },
      },
      { ...event("linked"), platformLogin: "Linked" },
    ];
    await readyReview(f);
    fireEvent.click(
      within(await screen.findByRole("row", { name: /Pending/ })).getByRole(
        "button",
        { name: "Expand details" }
      )
    );
    await screen.findByRole("link", { name: "Contribution remaining-0" });
    fireEvent.click(
      await screen.findByRole("button", { name: "More contributions" })
    );
    const moving = await screen.findByRole("link", {
      name: "Contribution moving",
    });
    fireEvent.click(
      within(containingRow(moving)).getByRole("button", {
        name: "Adjust weight",
      })
    );
    fireEvent.change(screen.getByLabelText("Override weight (units)"), {
      target: { value: "000" },
    });
    fireEvent.change(screen.getByLabelText("Reason (optional)"), {
      target: { value: "exact moved draft" },
    });
    if (accepted) {
      f.state.failList = true;
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByText("Saved. Could not verify current values.");
      expect(screen.getByLabelText("Override weight (units)")).toHaveValue(
        "000"
      );
      expect(screen.getByLabelText("Reason (optional)")).toHaveValue(
        "exact moved draft"
      );
      expect(f.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
      f.state.failList = false;
      f.state.failOverrideMethod = "GET";
    }
    f.state.events = f.state.events.map((item) =>
      item.receiptId === "moving"
        ? {
            ...item,
            platformLogin: "Linked",
            selection: {
              userId: "a",
              included: true,
              weightOverrideMilli: null,
            },
          }
        : item
    );
    await act(async () => {
      await f.queryClient.refetchQueries({
        predicate: (q) => q.queryKey.includes("finish-epoch"),
      });
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Override weight (units)")).toHaveValue(
        "000"
      )
    );
    expect(screen.getByLabelText("Reason (optional)")).toHaveValue(
      "exact moved draft"
    );
    expect(
      screen.queryByRole("link", { name: "Contribution moving" })
    ).not.toBeInTheDocument();
    const request = f.client.request;
    let refuseDestination = true;
    vi.spyOn(f.client, "request").mockImplementation((url, init) => refuseDestination && url.includes("claimantKey=user%3Aa")
      ? Promise.resolve(new Response('{}', { status: accepted ? 403 : 503 })) : request(url, init));
    fireEvent.click(
      within(screen.getByRole("row", { name: /Linked/ })).getByRole("button", {
        name: "Expand details",
      })
    );
    await screen.findByRole("button", { name: "Retry contributions" });
    expect(screen.getAllByLabelText("Override weight (units)")).toHaveLength(1);
    expect(screen.getByLabelText("Override weight (units)")).toHaveValue("000");
    expect(screen.getByLabelText("Reason (optional)")).toHaveValue("exact moved draft");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    if (accepted) expect(screen.getByText("Saved. Could not verify current values.")).toBeInTheDocument();
    refuseDestination = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry contributions" }));
    await screen.findByRole("link", { name: "Contribution linked" });
    await waitFor(() =>
      expect(screen.getAllByLabelText("Override weight (units)")).toHaveLength(
        1
      )
    );
    expect(screen.getByLabelText("Override weight (units)")).toHaveValue("000");
    // Once U's membership is verified, collapsing I cannot hide U's editor.
    fireEvent.click(
      within(screen.getByRole("row", { name: /Pending/ })).getByRole("button", {
        name: "Collapse details",
      })
    );
    expect(screen.getByLabelText("Override weight (units)")).toHaveValue("000");
    if (accepted) {
      expect(
        screen.getByText("Saved. Could not verify current values.")
      ).toBeInTheDocument();
      expect(f.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
      f.state.failOverrideMethod = null;
      fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));
    } else fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        f.state.overrides.find((o) => o.subjectRef === "moving")?.overrideUnits
      ).toBe("0")
    );
    await waitFor(() =>
      expect(
        screen.queryByLabelText("Override weight (units)")
      ).not.toBeInTheDocument()
    );
    fireEvent.click(
      within(
        containingRow(
          await screen.findByRole("link", { name: "Contribution moving" })
        )
      ).getByRole("button", { name: "Adjust weight" })
    );
    expect(screen.getByLabelText("Override weight (units)")).toHaveValue("0");
    expect(screen.getByLabelText("Reason (optional)")).toHaveValue(
      "exact moved draft"
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel weight adjustment" })
    );
    expect(
      screen.queryByLabelText("Override weight (units)")
    ).not.toBeInTheDocument();
  });


  it.each([false, true])("r7 retains expanded shells when replacement query fails (history key=%s)", async (historyKey) => {
    const f = fixture({ historyOffset: 0, selectedEpochId: null, expandedEpochIds: historyKey ? [] : ["14"] });
    const request = f.client.request;
    let fail = false;
    vi.spyOn(f.client, "request").mockImplementation(async (url, init) => {
      if (fail && (historyKey ? url.includes("view=overview") && url.includes("offset=200") : url.includes("view=summary")))
        return new Response('{}', { status: 503 });
      const response = await request(url, init);
      // A sparse history window with a >200 total exercises key replacement without dense DOM cost.
      if (historyKey && url.includes("view=overview")) return new Response(JSON.stringify({ ...await response.json(), total: 201 }));
      return response;
    });
    const view = render(<CurrentEpochView />, { wrapper: f.wrapper });
    const count = historyKey ? 1 : 2;
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Expand details" })).toHaveLength(2));
    const expand = screen.getAllByRole("button", { name: "Expand details" });
    for (const button of historyKey ? expand.slice(0, 1) : expand) fireEvent.click(button);
    await waitFor(() => expect(screen.getAllByRole("link", { name: "Contribution r1" })).toHaveLength(count));
    fail = true;
    if (historyKey) fireEvent.click(screen.getByRole("button", { name: "More epochs" }));
    else fireEvent.click(screen.getByRole("button", { name: "Sync contributions" }));
    await screen.findAllByText("The service could not confirm current values. Retry refresh.");
    expect(screen.getAllByRole("button", { name: "Collapse details" })).toHaveLength(historyKey ? 1 : 3);
    expect(screen.queryByRole("link", { name: "Contribution r1" })).not.toBeInTheDocument();
    fail = false;
    for (const button of screen.getAllByRole("button", { name: historyKey ? "Retry epochs" : "Retry epoch contributions" })) fireEvent.click(button);
    await waitFor(() => expect(screen.getAllByRole("link", { name: "Contribution r1" })).toHaveLength(count));
    expect(screen.getAllByRole("button", { name: "Collapse details" })).toHaveLength(historyKey ? 1 : 3);
    view.unmount();
  });

  it.each([[403, false], [503, false], [403, true], [503, true]] as const)("r7 keeps an orphaned exact draft visible through destination HTTP %s (accepted=%s)", async (status, accepted) => {
    const f = fixture();
    f.state.events = [{ ...event("moving", "external"), platformLogin: "Pending", selection: { userId: null, included: true, weightOverrideMilli: null } }, { ...event("linked"), platformLogin: "Linked" }];
    const view = await readyReview(f);
    fireEvent.click(within(screen.getByRole("row", { name: /Pending/ })).getByRole("button", { name: "Expand details" }));
    fireEvent.click(within(containingRow(await screen.findByRole("link", { name: "Contribution moving" }))).getByRole("button", { name: "Adjust weight" }));
    fireEvent.change(screen.getByLabelText("Override weight (units)"), { target: { value: "000" } });
    fireEvent.change(screen.getByLabelText("Reason (optional)"), { target: { value: "  orphan exact reason  " } });
    if (accepted) {
      f.state.failList = true;
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByText("Saved. Could not verify current values.");
      f.state.failList = false;
      f.state.failOverrideMethod = "GET";
    }
    const request = f.client.request;
    let refused = true;
    vi.spyOn(f.client, "request").mockImplementation((url, init) => refused && url.includes("claimantKey=") ? Promise.resolve(new Response('{}', { status })) : request(url, init));
    f.state.events = f.state.events.map(item => item.receiptId === "moving" ? { ...item, platformLogin: "Linked", selection: { userId: "a", included: true, weightOverrideMilli: null } } : item);
    await act(async () => { await f.queryClient.refetchQueries({ predicate: q => q.queryKey.includes("finish-epoch") }); });
    expect(screen.queryByRole("row", { name: /Pending/ })).not.toBeInTheDocument();
    expect(screen.getAllByLabelText("Override weight (units)")).toHaveLength(1);
    expect(screen.getByLabelText("Override weight (units)")).toHaveValue("000");
    expect(screen.getByLabelText("Reason (optional)")).toHaveValue("  orphan exact reason  ");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Contribution moving" })).not.toBeInTheDocument();
    // The destination remains collapsed until explicitly opened; no eager detail read.
    expect(screen.getByRole("button", { name: "Expand details" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand details" }));
    await screen.findByRole("button", { name: "Retry contributions" });
    expect(screen.getAllByLabelText("Override weight (units)")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(f.requests.filter(r => r.method === "PATCH" || r.method === "DELETE")).toHaveLength(accepted ? 1 : 0);
    refused = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry contributions" }));
    await screen.findByRole("link", { name: "Contribution linked" });
    await waitFor(() => accepted
      ? expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
      : expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    expect(screen.getAllByLabelText("Override weight (units)")).toHaveLength(1);
    expect(screen.getByLabelText("Override weight (units)")).toHaveValue("000");
    expect(screen.getByLabelText("Reason (optional)")).toHaveValue("  orphan exact reason  ");
    expect(f.requests.filter(r => r.method === "PATCH" || r.method === "DELETE")).toHaveLength(accepted ? 1 : 0);
    if (accepted) {
      expect(screen.getByText("Saved. Could not verify current values.")).toBeInTheDocument();
      f.state.failOverrideMethod = null;
      fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));
      await waitFor(() => expect(screen.queryByLabelText("Override weight (units)")).not.toBeInTheDocument());
      expect(f.requests.filter(r => r.method === "PATCH")).toHaveLength(1);
    }
    view.unmount();
  });

  it("r6 keeps current and historical contributor shells through actual list failure via Sync", async () => {
    const f = fixture({
      historyOffset: 0,
      selectedEpochId: null,
      expandedEpochIds: ["14"],
    });
    render(<CurrentEpochView />, { wrapper: f.wrapper });
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("button", { name: "Expand details" })
          .map(containingRow)
      ).toHaveLength(2)
    );
    for (const row of screen
      .getAllByRole("button", { name: "Expand details" })
      .map(containingRow))
      fireEvent.click(
        within(row).getByRole("button", { name: "Expand details" })
      );
    await waitFor(() =>
      expect(
        screen.getAllByRole("link", { name: "Contribution r1" })
      ).toHaveLength(2)
    );
    f.state.failList = true;
    fireEvent.click(screen.getByRole("button", { name: "Sync contributions" }));
    await screen.findByText("Error loading epoch data");
    expect(
      screen.getAllByRole("button", { name: "Collapse details" })
    ).toHaveLength(3);
    expect(
      screen.queryByRole("link", { name: "Contribution r1" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "fixture unavailable"
    );
    f.state.failList = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry epochs" }));
    await waitFor(() =>
      expect(
        screen.getAllByRole("link", { name: "Contribution r1" })
      ).toHaveLength(2)
    );
    expect(
      screen.getAllByRole("button", { name: "Collapse details" })
    ).toHaveLength(3);
  });

  it.each([
    403, 503,
  ])("r6 gates moved draft writes on current bounded membership after HTTP %s", async (status) => {
    const f = fixture();
    f.state.events = ["moving", "remaining"].map((id) => ({
      ...event(id, "external"),
      platformLogin: "Pending",
      selection: { userId: null, included: true, weightOverrideMilli: null },
    }));
    f.state.events.push({ ...event("linked"), platformLogin: "Linked" });
    const view = await readyReview(f);
    fireEvent.click(
      within(screen.getByRole("row", { name: /Pending/ })).getByRole("button", {
        name: "Expand details",
      })
    );
    fireEvent.click(
      within(
        containingRow(
          await screen.findByRole("link", { name: "Contribution moving" })
        )
      ).getByRole("button", { name: "Adjust weight" })
    );
    fireEvent.change(screen.getByLabelText("Override weight (units)"), {
      target: { value: " 00090071992547409931234567890 " },
    });
    fireEvent.change(screen.getByLabelText("Reason (optional)"), {
      target: { value: "  keep exact moved reason  " },
    });
    let refused = true;
    const request = f.client.request;
    vi.spyOn(f.client, "request").mockImplementation((url, init) =>
      refused && url.includes("claimantKey=")
        ? Promise.resolve(
            new Response(JSON.stringify({ error: "SECRET refused detail" }), {
              status,
            })
          )
        : request(url, init)
    );
    f.state.events = f.state.events.map((item) =>
      item.receiptId === "moving"
        ? {
            ...item,
            platformLogin: "Linked",
            selection: {
              userId: "a",
              included: true,
              weightOverrideMilli: null,
            },
          }
        : item
    );
    await act(async () => {
      await f.queryClient.refetchQueries({
        predicate: (q) => q.queryKey.includes("finish-epoch"),
      });
    });
    await screen.findByRole("button", { name: "Retry contributions" });
    expect(screen.getByLabelText("Override weight (units)")).toHaveValue(
      " 00090071992547409931234567890 "
    );
    expect(screen.getByLabelText("Reason (optional)")).toHaveValue(
      "  keep exact moved reason  "
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(f.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
    expect(
      screen.queryByRole("link", { name: "Contribution moving" })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/SECRET/)).not.toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole("row", { name: /Linked/ })).getByRole("button", {
        name: "Expand details",
      })
    );
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "Retry contributions" })
      ).toHaveLength(2)
    );
    expect(screen.getAllByLabelText("Override weight (units)")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    refused = false;
    // Recovering the old claimant cannot authorize the retained moved receipt.
    fireEvent.click(
      first(
        screen.getAllByRole("button", { name: "Retry contributions" }).reverse()
      )
    );
    await screen.findByRole("link", { name: "Contribution remaining" });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry contributions" })
    );
    await screen.findByRole("link", { name: "Contribution linked" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
    );
    expect(screen.getAllByLabelText("Override weight (units)")).toHaveLength(1);
    expect(f.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(f.state.overrides[0]?.overrideUnits).toBe(
        "90071992547409931234567890"
      )
    );
    expect(f.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
    view.unmount();
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])("r8 reconciles deferred root navigation in its live scope (reject=%s, disposed=%s)", async (rejectRoot, disposed) => {
    const f = fixture();
    const sibling = fixture();
    f.state.kind = sibling.state.kind = "publish";
    f.state.nullExplorer = true;
    let releaseRoot!: () => void;
    let rootStarted = false;
    f.state.rootRefetch = () => {
      rootStarted = true;
      return new Promise<void>((resolve, reject) => {
        releaseRoot = () => rejectRoot ? reject(new Error("root refused")) : resolve();
      });
    };
    let released = false;
    const request = f.client.request;
    vi.spyOn(f.client, "request").mockImplementation(async (url, init) => {
      const response = await request(url, init);
      return url === "/fixture/lifecycle" && released
        ? new Response(JSON.stringify({ ...await response.json(), publicationEvidence: "unknown" }))
        : response;
    });
    const tree = (pages: Readonly<Record<string, number>>, live = true) => (
      <QueryClientProvider client={f.queryClient}>
        {live && <EpochsProvider client={f.client} state={{ historyOffset: 0, selectedEpochId: null, contributorPages: pages }}>{reviewElement()}</EpochsProvider>}
        <EpochsProvider client={sibling.client}>{reviewElement()}</EpochsProvider>
      </QueryClientProvider>
    );
    const view = render(tree({}));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Publish latest settlement" })).toHaveLength(2));
    f.state.confirmedPublish = true;
    const before = f.requests.length;
    view.rerender(tree({}));
    await waitFor(() => expect(rootStarted).toBe(true));
    const pagesB = { "15": 200 };
    view.rerender(tree(pagesB));
    const activeB = () => f.queryClient.getQueryCache().findAll({ predicate: q => q.isActive() && q.queryKey.includes("finish-epoch") && JSON.stringify(q.queryKey.at(-1)) === JSON.stringify(pagesB) })[0];
    await waitFor(() => expect(activeB()?.state.status).toBe("success"));
    const queryB = activeB();
    if (!queryB) throw new Error("Missing active workspace B");
    const firstB = f.queryClient.getQueryData<FinishEpochWorkspaceData>(queryB.queryKey);
    expect(firstB?.lifecycleUnavailable).toBe(false);
    const siblingBefore = sibling.requests.length;
    const afterNavigation = f.requests.length;
    if (disposed) {
      view.rerender(tree(pagesB, false));
      const beforeDisposalRelease = f.requests.length;
      await act(async () => { releaseRoot(); });
      expect(f.requests).toHaveLength(beforeDisposalRelease);
      expect(sibling.requests).toHaveLength(siblingBefore);
      expect(activeB()).toBeUndefined();
      expect(f.writeContract).not.toHaveBeenCalled();
      expect(f.client.signTypedData).not.toHaveBeenCalled();
      view.unmount();
      return;
    }
    released = true;
    await act(async () => { releaseRoot(); });
    await waitFor(() => expect(f.queryClient.getQueryData<FinishEpochWorkspaceData>(queryB.queryKey)?.readId).not.toBe(firstB?.readId));
    expect(f.queryClient.getQueryData<FinishEpochWorkspaceData>(queryB.queryKey)?.lifecycleUnavailable).toBe(true);
    expect(f.requests.slice(afterNavigation).filter(r => r.url === "/fixture/lifecycle")).toHaveLength(1);
    expect(f.requests.slice(before).some(r => r.url.endsWith("/distribution"))).toBe(true);
    expect(sibling.requests).toHaveLength(siblingBefore);
    expect(f.writeContract).not.toHaveBeenCalled();
    expect(f.client.signTypedData).not.toHaveBeenCalled();
    view.unmount();
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("r6 confirmed fake receipt refreshes only owning keys (root refuses=%s, null explorer=%s)", async (rootRefuses, nullExplorer) => {
    const f = fixture();
    f.state.kind = "publish";
    const other = fixture();
    other.state.kind = "publish";
    // Two live scope owners share one real cache.
    const view = render(
      <QueryClientProvider client={f.queryClient}>
        <EpochsProvider client={f.client}>{reviewElement()}</EpochsProvider>
        <EpochsProvider client={other.client}>{reviewElement()}</EpochsProvider>
      </QueryClientProvider>
    );
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "Publish latest settlement" })
      ).toHaveLength(2)
    );
    const before = f.requests.length;
    const otherBefore = other.requests.length;
    f.state.failRootRefetch = rootRefuses;
    f.state.nullExplorer = nullExplorer;
    f.state.confirmedPublish = true;
    view.rerender(
      <QueryClientProvider client={f.queryClient}>
        <EpochsProvider client={f.client}>{reviewElement()}</EpochsProvider>
        <EpochsProvider client={other.client}>{reviewElement()}</EpochsProvider>
      </QueryClientProvider>
    );
    await waitFor(() => {
      expect(
        f.requests.slice(before).some((r) => r.url.endsWith("/distribution"))
      ).toBe(true);
      expect(
        f.requests.slice(before).some((r) => r.url === "/fixture/lifecycle")
      ).toBe(true);
      expect(
        f.requests
          .slice(before)
          .some((r) => r.url.startsWith("/fixture/epochs"))
      ).toBe(true);
    });
    expect(screen.getByText("Latest settlement published")).toBeInTheDocument();
    if (nullExplorer) expect(screen.queryByRole("link", { name: "View transaction" })).not.toBeInTheDocument();
    expect(other.requests).toHaveLength(otherBefore);
    expect(f.writeContract).not.toHaveBeenCalled();
  });

  it("r5 retains historical contributor expansion through a failed parent refresh", async () => {
    const f = fixture({
      historyOffset: 0,
      selectedEpochId: null,
      expandedEpochIds: ["14"],
    });
    f.state.current = null;
    let fail = false;
    const request = f.client.request;
    vi.spyOn(f.client, "request").mockImplementation((url, init) =>
      fail && url.includes("/claimants")
        ? Promise.resolve(new Response("{}", { status: 503 }))
        : request(url, init)
    );
    render(<CurrentEpochView />, { wrapper: f.wrapper });
    fireEvent.click(
      within(
        first((await screen.findAllByRole("row", { name: /Alpha/ })).reverse())
      ).getByRole("button", { name: "Expand details" })
    );
    await screen.findByRole("link", { name: "Contribution r1" });
    fail = true;
    await act(async () => {
      await f.queryClient.refetchQueries({
        predicate: (q) => q.queryKey.includes("view"),
      });
    });
    await screen.findByText(/Couldn’t load this epoch/);
    expect(
      within(
        first(screen.getAllByRole("row", { name: /Alpha/ }).reverse())
      ).getByRole("button", { name: "Collapse details" })
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.queryByRole("link", { name: "Contribution r1" })
    ).not.toBeInTheDocument();
    fail = false;
    fireEvent.click(
      screen.getByRole("button", { name: "Retry epoch contributions" })
    );
    await screen.findByRole("link", { name: "Contribution r1" });
    expect(
      within(
        first(screen.getAllByRole("row", { name: /Alpha/ }).reverse())
      ).getByRole("button", { name: "Collapse details" })
    ).toHaveAttribute("aria-expanded", "true");
  });

  it.each(["overview", "review"] as const)(
    "refreshes an obsolete identity summary once in %s",
    async (surface) => {
      const f = fixture();
      f.state.events = [
        {
          ...event("moved", "external"),
          platformLogin: "Pending",
          selection: {
            userId: null,
            included: true,
            weightOverrideMilli: null,
          },
        },
      ];
      if (surface === "review") await readyReview(f);
      else render(<CurrentEpochView />, { wrapper: f.wrapper });
      const row = await screen.findByRole("row", { name: /Pending/ });
      f.state.events = [{ ...event("moved"), platformLogin: "Linked" }];
      fireEvent.click(
        within(row).getByRole("button", { name: "Expand details" }),
      );
      await screen.findByRole("row", { name: /Linked/ });
      expect(
        screen.queryByRole("row", { name: /Pending/ }),
      ).not.toBeInTheDocument();
      expect(
        f.requests.filter((r) => r.url.includes("claimantKey=identity")),
      ).toHaveLength(1);
    },
  );

  it("loads unchanged finalized membership from its frozen detail page", async () => {
    const f = fixture();
    f.state.current = { ...epoch, status: "finalized" };
    f.state.events = [event("frozen")];
    const request = f.client.request;
    vi.spyOn(f.client, "request").mockImplementation(async (url, init) => {
      const response = await request(url, init);
      if (url.includes("/activity") && !url.includes("claimantKey=")) {
        const body = await response.json();
        return new Response(
          JSON.stringify({
            ...body,
            events: [...body.events, event("unfrozen")],
          }),
          { status: 200 },
        );
      }
      return response;
    });
    render(<CurrentEpochView />, { wrapper: f.wrapper });
    const row = await screen.findByRole("row", { name: /Alpha/ });
    fireEvent.click(
      within(row).getByRole("button", { name: "Expand details" }),
    );
    await screen.findByRole("link", { name: "Contribution frozen" });
    expect(
      screen.queryByRole("link", { name: "Contribution unfrozen" }),
    ).not.toBeInTheDocument();
  });

  it("shows loading, empty, list error and unknown lifecycle states", async () => {
    const f = fixture();
    f.state.empty = true;
    const view = render(<CurrentEpochView />, { wrapper: f.wrapper });
    expect(screen.queryByText("No active epoch")).not.toBeInTheDocument();
    await screen.findByText("No active epoch");
    view.unmount();
    const failed = fixture();
    failed.state.failList = true;
    render(<CurrentEpochView />, { wrapper: failed.wrapper });
    await screen.findByText("Error loading epoch data");
    cleanup();
    const unknown = fixture();
    unknown.state.failLifecycle = true;
    render(<CurrentEpochView />, { wrapper: unknown.wrapper });
    await screen.findByRole("row", { name: /Alpha/ }, { timeout: 5000 });
    expect(screen.getByText("Publish:").parentElement).toHaveTextContent(
      "Settlement preparation begins after finalization",
    );
  });

  it("drives the sync button through pending and cooldown feedback", async () => {
    const f = fixture();
    const request = f.client.request;
    let resolveSync!: (response: Response) => void;
    vi.spyOn(f.client, "request").mockImplementation((url, init) =>
      url.endsWith("/collect")
        ? new Promise<Response>((resolve) => {
            resolveSync = resolve;
          })
        : request(url, init),
    );
    render(<CurrentEpochView />, { wrapper: f.wrapper });
    const sync = await screen.findByRole("button", {
      name: "Sync contributions",
    });
    fireEvent.click(sync);
    expect(
      await screen.findByRole("button", { name: "Syncing…" }),
    ).toBeDisabled();
    await act(async () =>
      resolveSync(
        new Response(JSON.stringify({ workflowId: "fixture" }), {
          status: 200,
        }),
      ),
    );
    await screen.findByText(/Sync started/);
    expect(
      screen.getByRole("button", { name: "Sync contributions" }),
    ).toBeDisabled();
  });

  it("retries a failed bounded receipt read from the rendered control", async () => {
    const f = fixture();
    f.state.events = Array.from({ length: 201 }, (_, i) => event(`r${i + 1}`));
    f.state.failReceipts = true;
    render(<CurrentEpochView />, { wrapper: f.wrapper });
    fireEvent.click(
      within(await screen.findByRole("row", { name: /Alpha/ })).getByRole(
        "button",
        { name: "Expand details" },
      ),
    );
    const retry = await screen.findByRole("button", {
      name: "Retry contributions",
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn’t load contributions",
    );
    f.state.failReceipts = false;
    fireEvent.click(retry);
    await screen.findByRole("link", { name: "Contribution r1" });
    expect(
      screen.queryByRole("button", { name: "Retry contributions" }),
    ).not.toBeInTheDocument();
  });

  it("preserves sync success, failure, pending protection and server cooldown", async () => {
    const f = fixture();
    const hook = renderHook(() => useCollectEpoch(), { wrapper: f.wrapper });
    await act(async () => {
      await hook.result.current.trigger();
    });
    expect(hook.result.current.successMessage).toContain("Sync started");
    expect(hook.result.current.cooldownSeconds).toBe(300);
    await act(async () => {
      await hook.result.current.trigger();
    });
    expect(f.requests).toHaveLength(1);
    hook.unmount();
    const rejected = fixture();
    rejected.state.collectStatus = 500;
    const bad = renderHook(() => useCollectEpoch(), {
      wrapper: rejected.wrapper,
    });
    await act(async () => {
      await bad.result.current.trigger();
    });
    expect(bad.result.current.error).toBe("fixture sync error");
    bad.unmount();
    vi.useFakeTimers();
    const throttled = fixture();
    throttled.state.collectStatus = 429;
    const cool = renderHook(() => useCollectEpoch(), {
      wrapper: throttled.wrapper,
    });
    await act(async () => {
      await cool.result.current.trigger();
    });
    expect(cool.result.current.cooldownSeconds).toBe(1);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(cool.result.current.cooldownSeconds).toBeNull();
  });

  it("keeps projection totals and finalized receipt counts independent of the loaded activity page", () => {
    const projection = [
      { userId: "a", projectedUnits: "2000", receiptCount: 2 },
      { userId: "b", projectedUnits: "1000", receiptCount: 1 },
    ];
    const composed = composeEpochView(epoch, projection, [
      event("r1"),
      event("r2"),
    ]);
    expect(
      composed.contributors.map((item) => [
        item.units,
        item.receiptCount,
        item.creditShare,
      ]),
    ).toEqual([
      ["2000", 2, 66.7],
      ["1000", 1, 33.3],
    ]);
    const frozen = composeEpochViewFromClaimants(
      { ...epoch, status: "finalized" },
      {
        poolTotalCredits: "100",
        items: [
          {
            canonicalOwnerKey: "user:a",
            claimantKey: "user:a",
            claimant: { kind: "user", userId: "a" },
            displayName: "Alpha",
            isLinked: true,
            totalUnits: "3000",
            share: "1.000000",
            amountCredits: "100",
            receiptIds: ["r1", "r2", "r3"],
          },
        ],
      },
      [event("r1")],
    );
    expect(frozen.contributors[0]).toMatchObject({
      units: "3000",
      receiptCount: 3,
      creditShare: 100,
    });
  });

  it("preserves review eligibility, override edit/cancel/save/reset and signing state through injected fakes", async () => {
    const f = fixture();
    render(
      <ReviewView
        walletAddress={WALLET}
        isNodeAdmin
        operatorSetupUrl="https://example.com/setup"
      />,
      { wrapper: f.wrapper },
    );
    await screen.findByRole("button", { name: "Sign & Finalize" });
    fireEvent.click(
      within(screen.getByRole("row", { name: /Alpha/ })).getByRole("button", {
        name: "Expand details",
      }),
    );
    fireEvent.click(
      first(await screen.findAllByRole("button", { name: "Adjust weight" })),
    );
    fireEvent.change(screen.getByLabelText("Override weight (units)"), {
      target: { value: "500" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel weight adjustment" }),
    );
    fireEvent.click(
      first(screen.getAllByRole("button", { name: "Adjust weight" })),
    );
    fireEvent.change(screen.getByLabelText("Override weight (units)"), {
      target: { value: "500" },
    });
    fireEvent.change(screen.getByLabelText("Reason (optional)"), {
      target: { value: "Fixture correction" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("1 active weight override");
    fireEvent.click(
      screen.getByRole("button", { name: "Reset to original weight" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByText("1 active weight override"),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign & Finalize" }));
    await screen.findByText(
      "Epoch finalized. Statement fixture-statement. Settlement ready to publish.",
    );
    expect(f.client.signTypedData).toHaveBeenCalledWith(typedData);
    expect(
      f.requests.some(
        (request) =>
          request.method === "POST" && request.url.endsWith("/finalize"),
      ),
    ).toBe(true);
  });

  it.each([
    false,
    true,
  ])("blocks initial unknown override weights and retries (prior: %s)", async (prior) => {
    const f = fixture();
    f.state.failOverrideMethod = "GET";
    if (prior)
      f.state.overrides = [
        {
          id: "saved",
          subjectRef: "r1",
          overrideUnits: "0",
          overrideReason: "Saved zero",
        },
      ];
    render(
      <ReviewView
        walletAddress={WALLET}
        isNodeAdmin
        operatorSetupUrl="https://example.com/setup"
      />,
      { wrapper: f.wrapper },
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load weight overrides",
    );
    expect(
      screen.getByRole("button", { name: "Sign & Finalize" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Adjust weight" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/active weight override/),
    ).not.toBeInTheDocument();
    f.state.failOverrideMethod = null;
    fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));
    if (prior) await screen.findByText("1 active weight override");
    else await waitFor(() => expect(signButton()).toBeEnabled());
    expect(
      screen.getByRole("button", { name: "Sign & Finalize" }),
    ).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    false,
    true,
  ])("verifies uncertain writes before permitting explicit retries (existing: %s)", async (existing) => {
    const f = fixture();
    f.state.failOverrideMethod = "PATCH";
    if (existing)
      f.state.overrides = [
        {
          id: "saved",
          subjectRef: "r1",
          overrideUnits: "500",
          overrideReason: "Prior correction",
        },
      ];
    const savedOverrides = [...f.state.overrides];
    render(
      <ReviewView
        walletAddress={WALLET}
        isNodeAdmin
        operatorSetupUrl="https://example.com/setup"
      />,
      { wrapper: f.wrapper },
    );
    await screen.findByRole("button", { name: "Sign & Finalize" });
    fireEvent.click(
      within(screen.getByRole("row", { name: /Alpha/ })).getByRole("button", {
        name: "Expand details",
      }),
    );
    fireEvent.click(
      first(await screen.findAllByRole("button", { name: "Adjust weight" })),
    );
    fireEvent.change(screen.getByLabelText("Override weight (units)"), {
      target: { value: "0" },
    });
    fireEvent.change(screen.getByLabelText("Reason (optional)"), {
      target: { value: "Keep my correction" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The write result is unknown.",
    );
    expect(screen.getByLabelText("Override weight (units)")).toHaveValue("0");
    expect(screen.getByLabelText("Reason (optional)")).toHaveValue(
      "Keep my correction",
    );
    expect(f.state.overrides).toEqual(savedOverrides);
    f.state.failOverrideMethod = null;
    fireEvent.click(
      screen.getByRole("button", { name: "Review current values" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        screen.queryByLabelText("Override weight (units)"),
      ).not.toBeInTheDocument(),
    );
    await screen.findByText("1 active weight override");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(f.state.overrides[0]).toMatchObject({
      overrideUnits: "0",
      overrideReason: "Keep my correction",
    });
    f.state.failOverrideMethod = "DELETE";
    fireEvent.click(
      screen.getByRole("button", { name: "Reset to original weight" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The write result is unknown.",
    );
    expect(screen.getByText("1 active weight override")).toBeInTheDocument();
    expect(f.state.overrides[0]).toMatchObject({
      overrideUnits: "0",
      overrideReason: "Keep my correction",
    });
    f.state.failOverrideMethod = null;
    fireEvent.click(
      screen.getByRole("button", { name: "Review current values" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Reset to original weight" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByText("1 active weight override"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(f.state.overrides).toEqual([]);
  });

  it("offers open review only to an eligible admin and retains pinned signer denial", async () => {
    const f = fixture();
    f.state.kind = "open_review";
    render(
      <ReviewView
        walletAddress={WALLET}
        isNodeAdmin
        operatorSetupUrl="https://example.com/setup"
      />,
      { wrapper: f.wrapper },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Open for review" }),
    );
    await screen.findByRole("button", { name: "Sign & Finalize" });
    cleanup();
    const denied = fixture();
    render(
      <ReviewView
        walletAddress={`0x${"22".repeat(20)}`}
        isNodeAdmin
        operatorSetupUrl="https://example.com/setup"
      />,
      { wrapper: denied.wrapper },
    );
    await screen.findByText("View only");
    expect(
      screen.queryByRole("button", { name: "Sign & Finalize" }),
    ).not.toBeInTheDocument();
  });

  it("preserves wallet, chain, strict-permission and already-published gates without a real transaction", async () => {
    const f = fixture();
    f.state.connected = false;
    const view = render(
      <ExecuteDistributionPanel
        epochId="15"
        operatorSetupUrl="https://example.com/setup"
      />,
      { wrapper: f.wrapper },
    );
    await screen.findByRole("button", { name: "Connect fixture wallet" });
    f.state.connected = true;
    f.state.chainId = 1;
    view.rerender(
      <ExecuteDistributionPanel
        epochId="15"
        operatorSetupUrl="https://example.com/setup"
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Switch to Base" }),
    );
    expect(f.switchChain).toHaveBeenCalledWith({ chainId: 8453 });
    f.state.chainId = 8453;
    f.state.permission = "none";
    view.rerender(
      <ExecuteDistributionPanel
        epochId="15"
        operatorSetupUrl="https://example.com/setup"
      />,
    );
    await screen.findByRole("link", { name: "Open Cogni Operator →" });
    expect(f.writeContract).not.toHaveBeenCalled();
    f.state.permission = "authorized";
    view.rerender(
      <ExecuteDistributionPanel
        epochId="15"
        operatorSetupUrl="https://example.com/setup"
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Publish latest settlement" }),
    );
    expect(f.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "execute",
        args: [ZERO, expect.any(Array), 0n],
        account: WALLET,
      }),
    );
    f.state.published = true;
    view.rerender(
      <ExecuteDistributionPanel
        epochId="15"
        operatorSetupUrl="https://example.com/setup"
      />,
    );
    await screen.findByText("Published");
    expect(
      screen.queryByRole("button", { name: "Publish latest settlement" }),
    ).not.toBeInTheDocument();
  });
});

const reviewElement = () => (
  <ReviewView
    walletAddress={WALLET}
    isNodeAdmin
    operatorSetupUrl="https://example.com/setup"
  />
);
const signButton = () =>
  screen.getByRole("button", { name: "Sign & Finalize" });
async function readyReview(f: ReturnType<typeof fixture>) {
  const view = render(reviewElement(), { wrapper: f.wrapper });
  await waitFor(() => expect(signButton()).toBeEnabled());
  return view;
}
async function editWeight(units = "000", reason = "  Exact reason  ") {
  if (!screen.queryByLabelText("Override weight (units)")) {
    const expand = within(screen.getByRole("row", { name: /Alpha/ })).getByRole(
      "button",
      { name: /details/ },
    );
    if (expand.getAttribute("aria-expanded") !== "true")
      fireEvent.click(expand);
    fireEvent.click(
      first(await screen.findAllByRole("button", { name: "Adjust weight" })),
    );
  }
  fireEvent.change(screen.getByLabelText("Override weight (units)"), {
    target: { value: units },
  });
  fireEvent.change(screen.getByLabelText("Reason (optional)"), {
    target: { value: reason },
  });
}
function holdReviewReads(f: ReturnType<typeof fixture>) {
  const request = f.client.request;
  const pending: {
    kind: "workspace" | "overrides";
    signal: AbortSignal | null | undefined;
    release: () => void;
  }[] = [];
  let enabled = true;
  vi.spyOn(f.client, "request").mockImplementation(async (url, init) => {
    const response = await request(url, init);
    const kind = url.endsWith("/overrides")
      ? "overrides"
      : url.startsWith("/fixture/epochs?")
        ? "workspace"
        : null;
    if (enabled && (init?.method ?? "GET") === "GET" && kind)
      return new Promise<Response>((resolve) => {
        pending.push({
          kind,
          signal: init?.signal,
          release: () => resolve(response),
        });
      });
    return response;
  });
  return {
    pending,
    stop: () => {
      enabled = false;
    },
    release: async (kind?: "workspace" | "overrides") => {
      await act(async () => {
        for (const item of pending.splice(0).filter((item) => {
          if (!kind || item.kind === kind) return true;
          pending.push(item);
          return false;
        }))
          item.release();
      });
    },
  };
}

describe("review recovery through the public entry", () => {
  it.each([
    "workspace",
    "overrides",
  ] as const)("awaits both fresh reads after accepted PATCH (%s first) and preserves a newer edit", async (first) => {
    const f = fixture();
    await readyReview(f);
    await editWeight();
    const held = holdReviewReads(f);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(held.pending).toHaveLength(2));
    expect(f.state.overrides[0]).toMatchObject({
      overrideUnits: "0",
      overrideReason: "Exact reason",
    });
    expect(signButton()).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Override weight (units)"), {
      target: { value: "90071992547409931234567890" },
    });
    await held.release(first);
    expect(signButton()).toBeDisabled();
    held.stop();
    await held.release();
    await waitFor(() => expect(signButton()).toBeEnabled());
    expect(screen.getByLabelText("Override weight (units)")).toHaveValue(
      "90071992547409931234567890",
    );
    expect(f.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
    expect(f.client.signTypedData).not.toHaveBeenCalled();
  });

  it.each([
    "workspace",
    "overrides",
  ] as const)("awaits both fresh reads after accepted DELETE (%s first)", async (first) => {
    const f = fixture();
    f.state.overrides = [
      {
        id: "old",
        subjectRef: "r1",
        overrideUnits: "500",
        overrideReason: "Prior",
      },
    ];
    await readyReview(f);
    fireEvent.click(
      within(screen.getByRole("row", { name: /Alpha/ })).getByRole("button", {
        name: "Expand details",
      }),
    );
    const reset = await screen.findByRole("button", {
      name: "Reset to original weight",
    });
    const held = holdReviewReads(f);
    fireEvent.click(reset);
    await waitFor(() => expect(held.pending).toHaveLength(2));
    expect(signButton()).toBeDisabled();
    await held.release(first);
    expect(signButton()).toBeDisabled();
    held.stop();
    await held.release();
    await waitFor(() => expect(signButton()).toBeEnabled());
    expect(
      screen.queryByText("1 active weight override"),
    ).not.toBeInTheDocument();
    expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
  });

  it.each([
    "GET",
    "workspace",
  ])("keeps accepted PATCH after Cancel and retries only reads following %s failure", async (failure) => {
    const f = fixture();
    await readyReview(f);
    await editWeight();
    if (failure === "GET") f.state.failOverrideMethod = "GET";
    else f.state.failList = true;
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved. Could not verify current values.");
    expect(screen.getByLabelText("Override weight (units)")).toHaveValue("000");
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel weight adjustment" }),
    );
    expect(signButton()).toBeDisabled();
    f.state.failList = false;
    f.state.failOverrideMethod = null;
    fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));
    await waitFor(() => expect(signButton()).toBeEnabled());
    expect(f.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
  });

  it.each([
    "list",
    "lifecycle",
  ])("preserves the draft and cached workspace through a parent %s error", async (failure) => {
    const f = fixture();
    await readyReview(f);
    await editWeight();
    f.state.failList = failure === "list";
    f.state.failLifecycle = failure === "lifecycle";
    await act(async () => {
      await f.queryClient.refetchQueries({
        predicate: (q) => q.queryKey.includes("finish-epoch"),
      });
    });
    await screen.findByText("Could not verify current review data");
    expect(screen.getByLabelText("Override weight (units)")).toHaveValue("000");
    expect(screen.getByLabelText("Reason (optional)")).toHaveValue(
      "  Exact reason  ",
    );
    expect(signButton()).toBeDisabled();
    f.state.failList = false;
    f.state.failLifecycle = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));
    await waitFor(() => expect(signButton()).toBeEnabled());
    expect(screen.getByLabelText("Override weight (units)")).toHaveValue("000");
  });

  it("does not treat cancelled retained success as verification, and waits for its sibling", async () => {
    const f = fixture();
    await readyReview(f);
    await editWeight();
    const held = holdReviewReads(f);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(held.pending).toHaveLength(2));
    await act(async () => {
      await f.queryClient.cancelQueries({
        predicate: (q) => q.queryKey.includes("review-subject-overrides"),
      });
    });
    expect(signButton()).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Retry refresh" }),
    ).not.toBeInTheDocument();
    // The stale query may still expose success with its old data.
    expect(
      f.queryClient.getQueryCache().findAll({
        predicate: (q) => q.queryKey.includes("review-subject-overrides"),
      })[0]?.state.status,
    ).toBe("success");
    held.stop();
    await held.release();
    await screen.findByText("Saved. Could not verify current values.");
    expect(signButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));
    await waitFor(() => expect(signButton()).toBeEnabled());
    expect(f.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
  });

  it("does not count paused reads as verification", async () => {
    const f = fixture();
    await readyReview(f);
    await editWeight();
    const request = f.client.request;
    vi.spyOn(f.client, "request").mockImplementation(async (url, init) => {
      const response = await request(url, init);
      if (init?.method === "PATCH") onlineManager.setOnline(false);
      return response;
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved. Could not verify current values.");
    expect(signButton()).toBeDisabled();
    expect(
      f.queryClient.getQueryCache().findAll({
        predicate: (q) => q.queryKey.includes("review-subject-overrides"),
      })[0]?.state.fetchStatus,
    ).toBe("paused");
    await act(async () => {
      onlineManager.setOnline(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));
    await waitFor(() => expect(signButton()).toBeEnabled());
    expect(f.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
  });

  it("blocks signing immediately during background reads and coalesces Retry refresh", async () => {
    const f = fixture();
    await readyReview(f);
    const held = holdReviewReads(f);
    let refresh!: Promise<void>;
    act(() => {
      refresh = f.queryClient.refetchQueries({
        predicate: (q) => q.queryKey.includes("review-subject-overrides"),
      });
    });
    expect(signButton()).toBeDisabled();
    fireEvent.click(signButton());
    expect(f.requests.filter((r) => r.url.endsWith("/review"))).toHaveLength(0);
    await waitFor(() =>
      expect(held.pending.filter((p) => !p.signal?.aborted)).toHaveLength(2),
    );
    held.stop();
    await held.release();
    await refresh;
    await waitFor(() => expect(signButton()).toBeEnabled());
    f.state.failOverrideMethod = "GET";
    await act(async () => {
      await f.queryClient.refetchQueries({
        predicate: (q) => q.queryKey.includes("review-subject-overrides"),
      });
    });
    await screen.findByRole("button", { name: "Retry refresh" });
    f.state.failOverrideMethod = null;
    vi.mocked(f.client.request).mockRestore();
    const retryHeld = holdReviewReads(f);
    const retry = screen.getByRole("button", { name: "Retry refresh" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(retryHeld.pending).toHaveLength(2));
    retryHeld.stop();
    await retryHeld.release();
    await waitFor(() => expect(signButton()).toBeEnabled());
  });

  it("resolves an uncertain transport result with reads without resending PATCH", async () => {
    const f = fixture();
    await readyReview(f);
    await editWeight();
    const request = f.client.request;
    vi.spyOn(f.client, "request").mockImplementation(async (url, init) => {
      const response = await request(url, init);
      if (init?.method === "PATCH")
        throw new Error("Disconnected SECRET server details");
      return response;
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        screen.queryByLabelText("Override weight (units)"),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(signButton()).toBeEnabled());
    expect(f.state.overrides[0]?.overrideUnits).toBe("0");
    expect(f.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
    expect(document.body).not.toHaveTextContent("SECRET");
  });

  it.each([
    [
      409,
      "Epoch must be in review status for overrides",
      "This epoch has left review",
    ],
    [
      409,
      "No locked claimants found — epoch must have locked claimants before overrides",
      "required locked review snapshot is missing",
    ],
    [400, "Unknown subject_ref: SECRET-id", "absent from the locked review"],
    [401, "SECRET", "Sign in through this node"],
    [403, "SECRET", "You do not have access"],
    [422, "SECRET", "Correct the input"],
    [409, "<html>SECRET</html>", "Safe details are unavailable"],
  ])("keeps useful safe refusal meaning for %s / %s", async (status, error, message) => {
    const f = fixture();
    await readyReview(f);
    await editWeight();
    const request = f.client.request;
    vi.spyOn(f.client, "request").mockImplementation((url, init) =>
      init?.method === "PATCH"
        ? Promise.resolve(
            new Response(JSON.stringify({ error }), { status: Number(status) }),
          )
        : request(url, init),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(document.body).toHaveTextContent(String(message)),
    );
    expect(document.body).not.toHaveTextContent("SECRET");
    expect(screen.getByLabelText("Override weight (units)")).toHaveValue("000");
    expect(signButton()).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: /Retry save|Retry reset/ }),
    ).not.toBeInTheDocument();
  });

  it("disposes scope data and drafts with the same epoch while obsolete reads finish last", async () => {
    const f = fixture();
    const view = await readyReview(f);
    await editWeight();
    const held = holdReviewReads(f);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(held.pending).toHaveLength(2));
    held.stop();
    f.state.scope = "new-principal-generation-SECRET";
    f.state.overrides = [];
    f.state.events = [{ ...event("other"), platformLogin: "Other principal" }];
    view.rerender(reviewElement());
    await screen.findByText("Other principal", { selector: "td span" });
    await waitFor(() => expect(signButton()).toBeEnabled());
    expect(
      screen.queryByLabelText("Override weight (units)"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Alpha", { selector: "td span" }),
    ).not.toBeInTheDocument();
    await held.release();
    expect(
      screen.queryByText("1 active weight override"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Saved\./)).not.toBeInTheDocument();
    expect(
      JSON.stringify(
        f.queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.queryKey),
      ),
    ).not.toContain("SECRET");
    expect(f.client.signTypedData).not.toHaveBeenCalled();
  });

  it("keeps drafts with their epoch and ignores an old mutation completion", async () => {
    const f = fixture();
    await readyReview(f);
    await editWeight("111");
    const request = f.client.request;
    let release!: () => void;
    vi.spyOn(f.client, "request").mockImplementation(async (url, init) => {
      if (init?.method === "PATCH")
        return new Promise<Response>((resolve) => {
          release = () => resolve(new Response("{}", { status: 200 }));
        });
      return request(url, init);
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(release).toBeTypeOf("function"));
    f.state.reviewEpochId = "16";
    await act(async () => {
      await f.queryClient.refetchQueries({
        predicate: (q) => q.queryKey.includes("finish-epoch"),
      });
    });
    await screen.findByText("Epoch #16");
    await waitFor(() => expect(signButton()).toBeEnabled());
    await editWeight("222", "New epoch draft");
    await act(async () => release());
    expect(screen.getByLabelText("Override weight (units)")).toHaveValue("222");
    expect(screen.getByLabelText("Reason (optional)")).toHaveValue(
      "New epoch draft",
    );
    expect(signButton()).toBeEnabled();
    f.state.reviewEpochId = "15";
    await act(async () => {
      await f.queryClient.refetchQueries({
        predicate: (q) => q.queryKey.includes("finish-epoch"),
      });
    });
    await screen.findByRole("heading", { name: "Epoch #15", level: 2 });
    // Re-open the replaced contributor row; the epoch-15 draft was not lost.
    fireEvent.click(
      within(await screen.findByRole("row", { name: /Alpha/ })).getByRole(
        "button",
        { name: "Expand details" },
      ),
    );
    expect(await screen.findByLabelText("Override weight (units)")).toHaveValue(
      "111",
    );
    expect(screen.getByLabelText("Reason (optional)")).not.toHaveValue(
      "New epoch draft",
    );
  });
});

describe("review lifetime and remaining recovery controls", () => {
  it.each([
    "GET",
    "workspace",
  ])("retries only reads after an accepted DELETE and %s failure", async (failure) => {
    const f = fixture();
    f.state.overrides = [
      {
        id: "old",
        subjectRef: "r1",
        overrideUnits: "500",
        overrideReason: "Prior",
      },
    ];
    await readyReview(f);
    fireEvent.click(
      within(screen.getByRole("row", { name: /Alpha/ })).getByRole("button", {
        name: /details/,
      }),
    );
    if (failure === "GET") f.state.failOverrideMethod = "GET";
    else f.state.failList = true;
    fireEvent.click(
      await screen.findByRole("button", { name: "Reset to original weight" }),
    );
    await screen.findByText("Saved. Could not verify current values.");
    expect(signButton()).toBeDisabled();
    f.state.failList = false;
    f.state.failOverrideMethod = null;
    fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));
    await waitFor(() => expect(signButton()).toBeEnabled());
    expect(f.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
    expect(
      screen.queryByText("1 active weight override"),
    ).not.toBeInTheDocument();
  });

  it("preserves exact draft text through receipt row disposal, contributor collapse and reopen", async () => {
    const f = fixture();
    f.state.events = Array.from({ length: 201 }, (_, i) => event(`r${i + 1}`));
    await readyReview(f);
    await editWeight();
    fireEvent.click(screen.getByRole("button", { name: "More contributions" }));
    await screen.findByRole("link", { name: "Contribution r51" });
    expect(
      screen.queryByLabelText("Override weight (units)"),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Previous contributions" }),
    );
    expect(await screen.findByLabelText("Override weight (units)")).toHaveValue(
      "000",
    );
    expect(screen.getByLabelText("Reason (optional)")).toHaveValue(
      "  Exact reason  ",
    );
    fireEvent.click(
      within(screen.getByRole("row", { name: /Alpha/ })).getByRole("button", {
        name: /details/,
      }),
    );
    expect(
      screen.queryByLabelText("Override weight (units)"),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole("row", { name: /Alpha/ })).getByRole("button", {
        name: /details/,
      }),
    );
    expect(await screen.findByLabelText("Override weight (units)")).toHaveValue(
      "000",
    );
  });

  it("retains drafts across contributor pages and rejects old page reads finishing last", async () => {
    const f = fixture();
    f.state.events = denseContributors();
    await readyReview(f);
    await editWeight();
    const held = holdReviewReads(f);
    let background!: Promise<void>;
    act(() => {
      background = f.queryClient.refetchQueries({
        predicate: (q) => q.queryKey.includes("finish-epoch"),
      });
    });
    await waitFor(() =>
      expect(held.pending.filter((p) => !p.signal?.aborted)).toHaveLength(2),
    );
    held.stop();
    fireEvent.click(screen.getByRole("button", { name: "More contributors" }));
    await contributorRow("Late contributor");
    await waitFor(() => expect(signButton()).toBeEnabled());
    await held.release();
    await background;
    expect(
      screen.queryByLabelText("Override weight (units)"),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Previous contributors" }),
    );
    const alpha = await contributorRow("Alpha");
    fireEvent.click(within(alpha).getByRole("button", { name: /details/ }));
    expect(await screen.findByLabelText("Override weight (units)")).toHaveValue(
      "000",
    );
    expect(screen.getByLabelText("Reason (optional)")).toHaveValue(
      "  Exact reason  ",
    );
  }, 20_000);

  it("keeps precision, rejects decimals, and verifies canonical units and an empty normalized reason", async () => {
    const f = fixture();
    await readyReview(f);
    await editWeight("1.2", "");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(f.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
    const units = "  00090071992547409931234567890123456789  ";
    await editWeight(units, "   ");
    expect(screen.getByLabelText("Override weight (units)")).toHaveValue(units);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        screen.queryByLabelText("Override weight (units)"),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(signButton()).toBeEnabled());
    expect(f.state.overrides[0]).toMatchObject({
      overrideUnits: "90071992547409931234567890123456789",
      overrideReason: null,
    });
  });

  it("keeps a definite forbidden write view-only even when later GETs succeed", async () => {
    const f = fixture();
    await readyReview(f);
    await editWeight();
    const request = f.client.request;
    vi.spyOn(f.client, "request").mockImplementation((url, init) =>
      init?.method === "PATCH"
        ? Promise.resolve(new Response("untrusted", { status: 403 }))
        : request(url, init),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(document.body).toHaveTextContent("You do not have access"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Retry refresh" }),
      ).toBeEnabled(),
    );
    expect(signButton()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(document.body).not.toHaveTextContent("untrusted");
  });

  it("does not replay a draft or pending operation after leaving and returning", async () => {
    const f = fixture();
    const view = await readyReview(f);
    await editWeight();
    const held = holdReviewReads(f);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(held.pending).toHaveLength(2));
    view.unmount();
    held.stop();
    const returned = render(reviewElement(), { wrapper: f.wrapper });
    expect(
      screen.queryByLabelText("Override weight (units)"),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(signButton()).toBeEnabled());
    await held.release();
    expect(f.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
    expect(
      screen.queryByText(/Could not verify current values/),
    ).not.toBeInTheDocument();
    returned.unmount();
  });
});

it("requires fresh usable reads after StrictMode replays boundary effects", async () => {
  const f = fixture();
  render(
    <StrictMode>
      <QueryClientProvider client={f.queryClient}>
        <EpochsProvider client={f.client}>{reviewElement()}</EpochsProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
  await waitFor(() => expect(signButton()).toBeEnabled());
  await editWeight();
  f.state.failOverrideMethod = "GET";
  await act(async () => {
    await f.queryClient.refetchQueries({
      predicate: (q) => q.queryKey.includes("review-subject-overrides"),
    });
  });
  await waitFor(() => expect(signButton()).toBeDisabled());
  expect(screen.getByLabelText("Override weight (units)")).toHaveValue("000");
});

it("keeps override writes disabled throughout the existing signing flow", async () => {
  const f = fixture();
  await readyReview(f);
  await editWeight();
  let resolveSignature!: (signature: string) => void;
  vi.mocked(
    f.client.signTypedData ?? (() => Promise.resolve("")),
  ).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveSignature = resolve;
      }),
  );
  fireEvent.click(signButton());
  await screen.findByRole("button", { name: "Awaiting wallet..." });
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(f.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
  await act(async () => resolveSignature("0xfake"));
  await screen.findByText(
    "Epoch finalized. Statement fixture-statement. Settlement ready to publish.",
  );
});

it("respects bounded Retry-After before offering read recovery", async () => {
  const f = fixture();
  await readyReview(f);
  await editWeight();
  const request = f.client.request;
  const spy = vi.spyOn(f.client, "request").mockImplementation((url, init) =>
    init?.method === "PATCH"
      ? Promise.resolve(
          new Response("SECRET", {
            status: 429,
            headers: { "Retry-After": "1" },
          }),
        )
      : request(url, init),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(document.body).toHaveTextContent("Too many requests"),
  );
  const retry = screen.getByRole("button", { name: "Retry refresh" });
  expect(retry).toBeDisabled();
  await waitFor(() => expect(retry).toBeEnabled(), { timeout: 2000 });
  fireEvent.click(retry);
  await waitFor(() => expect(signButton()).toBeEnabled());
  expect(
    spy.mock.calls.filter(([, init]) => init?.method === "PATCH"),
  ).toHaveLength(1);
  expect(document.body).not.toHaveTextContent("SECRET");
});

it("never closes a replacement draft after Cancel and accepted-write verification", async () => {
  const f = fixture();
  await readyReview(f);
  await editWeight();
  const held = holdReviewReads(f);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(held.pending).toHaveLength(2));
  fireEvent.click(
    screen.getByRole("button", { name: "Cancel weight adjustment" }),
  );
  await editWeight(); // Same text/revision, different draft identity.
  held.stop();
  await held.release();
  await waitFor(() => expect(signButton()).toBeEnabled());
  expect(screen.getByLabelText("Override weight (units)")).toHaveValue("000");
  expect(screen.getByLabelText("Reason (optional)")).toHaveValue(
    "  Exact reason  ",
  );
});

it("does not resurrect a cancelled write refusal in a newer draft", async () => {
  const f = fixture();
  await readyReview(f);
  await editWeight();
  const request = f.client.request;
  let release!: () => void;
  vi.spyOn(f.client, "request").mockImplementation((url, init) =>
    init?.method === "PATCH"
      ? new Promise((resolve) => {
          release = () => resolve(new Response("{}", { status: 422 }));
        })
      : request(url, init),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(release).toBeTypeOf("function"));
  fireEvent.click(
    screen.getByRole("button", { name: "Cancel weight adjustment" }),
  );
  await editWeight("888", "New draft");
  await act(async () => release());
  expect(screen.getByLabelText("Override weight (units)")).toHaveValue("888");
  expect(document.body).not.toHaveTextContent("Correct the input");
  fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));
  await waitFor(() => expect(signButton()).toBeEnabled());
  expect(screen.getByLabelText("Reason (optional)")).toHaveValue("New draft");
});

it("ignores an obsolete principal's mutation completing after same-epoch scope replacement", async () => {
  const f = fixture();
  const view = await readyReview(f);
  await editWeight();
  const request = f.client.request;
  let release!: () => void;
  vi.spyOn(f.client, "request").mockImplementation(async (url, init) => {
    const response = await request(url, init);
    return init?.method === "PATCH"
      ? new Promise((resolve) => {
          release = () => resolve(response);
        })
      : response;
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(release).toBeTypeOf("function"));
  f.state.scope = "replacement-auth-generation";
  f.state.overrides = [];
  view.rerender(reviewElement());
  await waitFor(() => expect(signButton()).toBeEnabled());
  await editWeight("333", "New principal draft");
  await act(async () => release());
  expect(screen.getByLabelText("Override weight (units)")).toHaveValue("333");
  expect(screen.getByLabelText("Reason (optional)")).toHaveValue(
    "New principal draft",
  );
  expect(signButton()).toBeEnabled();
  expect(screen.queryByText(/Saved\./)).not.toBeInTheDocument();
  expect(f.client.signTypedData).not.toHaveBeenCalled();
});
