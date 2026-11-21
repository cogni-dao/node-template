// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

// @vitest-environment jsdom
/** Public-entry fixtures exercise the whole epoch capability without node app imports or real wallet actions. */
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import { useState, type ReactElement, type ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData } from "viem";
import { DAO_ABI } from "@cogni/attribution-ledger/distribution/publish-permission";
import {
  CurrentEpochView,
  EpochsProvider,
  ReviewView,
  ExecuteDistributionPanel,
  useCollectEpoch,
  composeEpochView,
  applyOverridesToEpochView,
  composeEpochViewFromClaimants,
  composeEpochViewFromSummary,
  type ApiIngestionReceipt,
  type EpochsClient,
  type EpochWallet,
  type EpochDto,
  type SignDataResponse,
  type EpochNavigationState,
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
        })
      ),
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

function fixture(initialNavigation?: EpochNavigationState) {
  let savedNavigation: EpochNavigationState = initialNavigation ?? {
    historyOffset: 0,
    selectedEpochId: null,
  };
  const state = {
    current: epoch as EpochDto | null,
    empty: false,
    failList: false,
    failLifecycle: false,
    events: [event("r1"), event("r2")] as ApiIngestionReceipt[],
    history: [past],
    failReceipts: false,
    collectStatus: 200,
    kind: "finalize" as "open_review" | "finalize" | "publish",
    isNodeAdmin: true,
    connected: true,
    chainId: 8453,
    permission: "authorized",
    published: false,
    pendingPublish: false,
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
      data: undefined,
    }),
    useWaitForTransactionReceipt: () => ({
      isLoading: false,
      isSuccess: false,
    }),
    useReadContract: (args: {
      functionName: string;
      args?: readonly unknown[];
    }) => {
      if (args.functionName === "merkleRoot")
        return {
          data: state.published ? ROOT : ZERO,
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        };
      const decoded = args.args?.[3]
        ? decodeFunctionData({
            abi: DAO_ABI,
            data: args.args[3] as `0x${string}`,
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
        refetch: vi.fn(),
      };
    },
    distributorAbi: [
      {
        type: "function",
        name: "setMerkleRoot",
        stateMutability: "nonpayable",
        inputs: [{ type: "bytes32" }],
        outputs: [],
      },
    ],
    ConnectWalletComponent: () => <button>Connect fixture wallet</button>,
    getChainName: () => "Base",
    getTransactionExplorerUrl: () => "https://example.com/tx",
  } as unknown as EpochWallet; // Fake SDK boundary; the node binding is separately checked against real SDK types.
  const client: EpochsClient = {
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
                    Number(parsed.searchParams.get("offset") ?? 0) + 200
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
              state.collectStatus
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
              0
          );
          if (base <= 0n) continue;
          const units = BigInt(
            state.overrides.find(
              (item) => item.subjectRef === receipt.receiptId
            )?.overrideUnits ?? base
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
              : 1
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
            all.reduce((sum, item) => sum + (item.units + 500n) / 1000n, 0n)
          ),
          totalReceiptCount: all.reduce(
            (sum, item) => sum + item.receiptCount,
            0
          ),
          unresolvedCount: [...unresolved.values()].reduce(
            (sum, item) => sum + item.eventCount,
            0
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
                : `identity:${receipt.source}:${receipt.platformUserId}`)
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
        if (method === "PATCH") {
          const body = JSON.parse(String(init?.body));
          state.overrides = body.overrides.map(
            (item: {
              subjectRef: string;
              overrideUnits: string;
              overrideReason: string | null;
            }) => ({ ...item, id: "override" })
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
      if (path.endsWith("/finalize"))
        return json({ workflowId: "fixture-finalize" });
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

describe("public epochs capability", () => {
  it("round-trips controlled navigation and toggles disclosure from the keyboard", async () => {
    const f = fixture();
    const user = userEvent.setup();
    const view = render(<CurrentEpochView />, { wrapper: f.wrapper });
    const row = await screen.findByRole(
      "row",
      { name: /Alpha/ },
      { timeout: 5000 }
    );
    const expand = within(row).getByRole("button", { name: "Expand details" });
    expand.focus();
    await user.keyboard(" ");
    expect(expand).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Enter}");
    expect(expand).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(
      within(screen.getByText("14").closest("tr")!).getByRole("button", {
        name: "Expand details",
      })
    );
    const saved = JSON.parse(
      JSON.stringify(f.getNavigation())
    ) as EpochNavigationState;
    expect(saved.expandedEpochIds).toEqual(["14"]);
    view.unmount();
    const restored = fixture(saved);
    render(<CurrentEpochView />, { wrapper: restored.wrapper });
    await screen.findByRole("button", { name: "Collapse details" });
    await waitFor(() =>
      expect(
        restored.requests.filter((request) => request.url.includes("/14/"))
      ).toHaveLength(2)
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
      { wrapper: f.wrapper }
    );
    await screen.findByRole("row", { name: /Alpha/ }, { timeout: 5000 });
    expect(
      screen.queryByRole("row", { name: /Late contributor/ })
    ).not.toBeInTheDocument();
    const more = screen.getByRole("button", { name: "More contributors" });
    more.focus();
    await user.keyboard("{Enter}");
    const late = await screen.findByRole("row", { name: /Late contributor/ });
    expect(within(late).getByText("201")).toBeVisible();
    expect(
      f.requests.some((r) =>
        r.url.includes("/projections?view=summary&limit=200&offset=200")
      )
    ).toBe(true);
    fireEvent.click(
      within(late).getByRole("button", { name: "Expand details" })
    );
    await screen.findByRole("link", { name: "Contribution dense-200" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Adjust weight" })
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
          "0"
        )
      ).toBeVisible()
    );
    expect(f.state.overrides[0]).toMatchObject({
      subjectRef: "dense-200",
      overrideUnits: "0",
      overrideReason: "Off-page correction",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Reset to original weight" })
    );
    await waitFor(() => expect(f.state.overrides).toHaveLength(0));
    await waitFor(() =>
      expect(
        within(screen.getByRole("row", { name: /Late contributor/ })).getByText(
          "1000"
        )
      ).toBeVisible()
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Previous contributors" })
    );
    await screen.findByRole("row", { name: /Alpha/ }, { timeout: 5000 });
    expect(f.getNavigation().contributorPages?.["15"]).toBe(0);
  });

  it.each([null, "a"])(
    "keeps a zero override reset reachable for fallback identity %s",
    async (userId) => {
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
        { wrapper: f.wrapper }
      );
      fireEvent.click(
        within(
          await screen.findByRole("row", { name: /Alpha/ }, { timeout: 5000 })
        ).getByRole("button", { name: "Expand details" })
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "Adjust weight" })
      );
      fireEvent.change(screen.getByLabelText("Override weight (units)"), {
        target: { value: "0" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByText("1 active weight override");
      await waitFor(() =>
        expect(
          within(screen.getByRole("row", { name: /Alpha/ })).getByText("0")
        ).toBeVisible()
      );
      const original = applyOverridesToEpochView(
        composeEpochView(epoch, [], f.state.events),
        new Map([["zero", { subjectRef: "zero", overrideUnits: "0" }]])
      );
      const summary = await (
        await f.client.request("/fixture/15/projections?offset=0")
      ).json();
      const repaired = composeEpochViewFromSummary(
        epoch,
        summary,
        f.state.events
      );
      expect(
        repaired.contributors.map(({ claimantKey, units, receiptCount }) => ({
          claimantKey,
          units,
          receiptCount,
        }))
      ).toEqual(
        original.contributors.map(({ claimantKey, units, receiptCount }) => ({
          claimantKey,
          units,
          receiptCount,
        }))
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Reset to original weight" })
      );
      await waitFor(() =>
        expect(
          within(screen.getByRole("row", { name: /Alpha/ })).getByText("1000")
        ).toBeVisible()
      );
    }
  );

  it("keeps complete unresolved facts independent of contributor and activity windows", async () => {
    const f = fixture();
    f.state.events = denseContributors();
    f.state.events.push(
      ...["external-1", "external-2"].map((id) => ({
        ...event(id),
        platformUserId: id,
        platformLogin: "Same label",
        selection: { userId: null, included: true, weightOverrideMilli: null },
      }))
    );
    const response = await f.client.request("/fixture/15/projections?offset=0");
    const summary = await response.json();
    const linkedPage = f.state.events.slice(0, 200);
    const first = composeEpochViewFromSummary(epoch, summary, linkedPage);
    const changedActivity = composeEpochViewFromSummary(
      epoch,
      summary,
      f.state.events.slice(200)
    );
    const lastSummary = await (
      await f.client.request("/fixture/15/projections?offset=200")
    ).json();
    const changedContributor = composeEpochViewFromSummary(
      epoch,
      lastSummary,
      []
    );
    for (const view of [first, changedActivity, changedContributor]) {
      expect(view.unresolvedCount).toBe(2);
      expect(view.unresolvedActivities).toHaveLength(2);
      expect(view.unresolvedActivities.map((item) => item.claimantKey)).toEqual(
        ["identity:github:external-1", "identity:github:external-2"]
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
    const row = await screen.findByRole(
      "row",
      { name: /Alpha/ },
      { timeout: 5000 }
    );
    expect(within(row).getByText("Alpha")).toBeVisible();
    const expand = within(row).getByRole("button", { name: "Expand details" });
    expand.focus();
    await user.keyboard("{Enter}");
    expect(expand).toHaveAttribute("aria-expanded", "true");
    expect(
      await screen.findByRole("link", { name: "Contribution dense-0" })
    ).toBeVisible();
  });

  it("loads four reads regardless of history and fetches a past epoch only on expansion", async () => {
    const f = fixture();
    f.state.history = denseHistory();
    render(<CurrentEpochView />, { wrapper: f.wrapper });
    await screen.findByRole("row", { name: /Alpha/ }, { timeout: 5000 });
    expect(
      f.requests.filter((request) => request.method === "GET")
    ).toHaveLength(4);
    expect(f.requests.some((request) => request.url.includes("/14/"))).toBe(
      false
    );
    fireEvent.click(
      within(screen.getByText("14").closest("tr")!).getByRole("button", {
        name: "Expand details",
      })
    );
    await waitFor(() =>
      expect(
        f.requests.filter((request) => request.url.includes("/14/"))
      ).toHaveLength(2)
    );
    expect(
      screen.getByRole("button", { name: "Collapse details" })
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the current epoch while changing the history page and exposes contributor pages", async () => {
    const f = fixture();
    f.state.events = denseContributors();
    f.state.history = denseHistory();
    render(<CurrentEpochView />, { wrapper: f.wrapper });
    await screen.findByRole("row", { name: /Alpha/ }, { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "More epochs" }));
    await waitFor(() =>
      expect(
        f.requests.some(
          (request) =>
            request.url.includes("view=overview") &&
            request.url.includes("offset=200")
        )
      ).toBe(true)
    );
    expect(
      screen.getByRole("button", { name: "Sync contributions" })
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "More contributors" }));
    await screen.findByRole("row", { name: /Late contributor/ });
    expect(screen.getByText("201 contributors")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Previous epochs" }));
    await screen.findByText("14");
    expect(f.getNavigation().historyOffset).toBe(0);
  }, 15_000);

  it("expands a contributor to bounded receipt pages and real receipt links", async () => {
    const f = fixture();
    f.state.events = Array.from({ length: 201 }, (_, i) => event(`r${i + 1}`));
    render(<CurrentEpochView />, { wrapper: f.wrapper });
    await screen.findByRole("row", { name: /Alpha/ }, { timeout: 5000 });
    fireEvent.click(
      within(screen.getByRole("row", { name: /Alpha/ })).getByRole("button", {
        name: "Expand details",
      })
    );
    const link = await screen.findByRole("link", { name: "Contribution r1" });
    expect(link).toHaveAttribute("href", "https://example.com/r1");
    fireEvent.click(screen.getByRole("button", { name: "More contributions" }));
    await waitFor(() =>
      expect(
        f.requests.some(
          (request) =>
            request.url.includes("claimantKey=user%3Aa") &&
            request.url.includes("offset=50")
        )
      ).toBe(true)
    );
    await screen.findByRole("link", { name: "Contribution r51" });
    fireEvent.click(
      screen.getByRole("button", { name: "Previous contributions" })
    );
    await screen.findByRole("link", { name: "Contribution r1" });
    expect(
      screen.queryByRole("link", { name: "Contribution r51" })
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
      "Settlement preparation begins after finalization"
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
        : request(url, init)
    );
    render(<CurrentEpochView />, { wrapper: f.wrapper });
    const sync = await screen.findByRole("button", {
      name: "Sync contributions",
    });
    fireEvent.click(sync);
    expect(
      await screen.findByRole("button", { name: "Syncing…" })
    ).toBeDisabled();
    await act(async () =>
      resolveSync(
        new Response(JSON.stringify({ workflowId: "fixture" }), { status: 200 })
      )
    );
    await screen.findByText(/Sync started/);
    expect(
      screen.getByRole("button", { name: "Sync contributions" })
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
        { name: "Expand details" }
      )
    );
    const retry = await screen.findByRole("button", {
      name: "Retry contributions",
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn’t load contributions"
    );
    f.state.failReceipts = false;
    fireEvent.click(retry);
    await screen.findByRole("link", { name: "Contribution r1" });
    expect(
      screen.queryByRole("button", { name: "Retry contributions" })
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
      ])
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
      [event("r1")]
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
      { wrapper: f.wrapper }
    );
    await screen.findByRole("button", { name: "Sign & Finalize" });
    fireEvent.click(
      within(screen.getByRole("row", { name: /Alpha/ })).getByRole("button", {
        name: "Expand details",
      })
    );
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Adjust weight" }))[0]!
    );
    fireEvent.change(screen.getByLabelText("Override weight (units)"), {
      target: { value: "500" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel weight adjustment" })
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Adjust weight" })[0]!
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
      screen.getByRole("button", { name: "Reset to original weight" })
    );
    await waitFor(() =>
      expect(
        screen.queryByText("1 active weight override")
      ).not.toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign & Finalize" }));
    await screen.findByText(
      "Finalization started (workflow: fixture-finalize)"
    );
    expect(f.client.signTypedData).toHaveBeenCalledWith(typedData);
    expect(
      f.requests.some(
        (request) =>
          request.method === "POST" && request.url.endsWith("/finalize")
      )
    ).toBe(true);
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
      { wrapper: f.wrapper }
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Open for review" })
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
      { wrapper: denied.wrapper }
    );
    await screen.findByText("View only");
    expect(
      screen.queryByRole("button", { name: "Sign & Finalize" })
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
      { wrapper: f.wrapper }
    );
    await screen.findByRole("button", { name: "Connect fixture wallet" });
    f.state.connected = true;
    f.state.chainId = 1;
    view.rerender(
      <ExecuteDistributionPanel
        epochId="15"
        operatorSetupUrl="https://example.com/setup"
      />
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Switch to Base" })
    );
    expect(f.switchChain).toHaveBeenCalledWith({ chainId: 8453 });
    f.state.chainId = 8453;
    f.state.permission = "none";
    view.rerender(
      <ExecuteDistributionPanel
        epochId="15"
        operatorSetupUrl="https://example.com/setup"
      />
    );
    await screen.findByRole("link", { name: "Open Cogni Operator →" });
    expect(f.writeContract).not.toHaveBeenCalled();
    f.state.permission = "authorized";
    view.rerender(
      <ExecuteDistributionPanel
        epochId="15"
        operatorSetupUrl="https://example.com/setup"
      />
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Publish latest settlement" })
    );
    expect(f.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "execute",
        args: [ZERO, expect.any(Array), 0n],
        account: WALLET,
      })
    );
    f.state.published = true;
    view.rerender(
      <ExecuteDistributionPanel
        epochId="15"
        operatorSetupUrl="https://example.com/setup"
      />
    );
    await screen.findByText("Published");
    expect(
      screen.queryByRole("button", { name: "Publish latest settlement" })
    ).not.toBeInTheDocument();
  });
});
