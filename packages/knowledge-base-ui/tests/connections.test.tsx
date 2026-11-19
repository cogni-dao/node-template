// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import "@testing-library/jest-dom/vitest";
import type { ConnectedOrgView, OutboundTargetView } from "@cogni/agent-grants";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedOrgsSection, ConnectionsSection } from "../src/index.js";

const fake = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
const json = (status: number, body: unknown) => Promise.resolve(fake(status, body));
const flush = () =>
  act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const org = (n: number, over: Partial<ConnectedOrgView> = {}): ConnectedOrgView => ({
  orgUserId: `org-${n}`,
  issuer: `https://node${n}.example.org`,
  status: "connected",
  allowance: 500 * n,
  debits: 15,
  cap: 1000,
  lastCallAt: null,
  ...over,
});
const ORGS = { list: "/api/v1/admin/connected-orgs" };
const urlOf = (call: unknown[]) => String(call[0]);

describe("ConnectedOrgsSection (provider)", () => {
  it("renders nothing while loading and for every non-admin outcome (401, 403, 404, 500, a network error, a bad body)", async () => {
    for (const answer of [() => json(401, {}), () => json(403, {}), () => json(404, {}), () => json(500, {}), () => Promise.reject(new Error("net")), () => json(200, { nope: true })]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(answer);
      const { container, unmount } = render(<ConnectedOrgsSection endpoints={ORGS} />);
      expect(container).toBeEmptyDOMElement();
      await flush();
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("a confirmed 503 shows one error line with Try again; the session is sent and never an Authorization header", async () => {
    fetchMock.mockReturnValue(json(503, {}));
    render(<ConnectedOrgsSection endpoints={ORGS} />);
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("Can't load connected orgs right now. Try again.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.cache).toBe("no-store");
    expect(JSON.stringify(init.headers ?? {})).not.toMatch(/authorization/i);
  });

  it("shows one row per org with host, status (Suspended wins), allowance, used / cap and the three actions, bounded to one page of 50", async () => {
    fetchMock.mockReturnValue(json(200, { orgs: [org(1, { nodeId: "n-1" }), org(2, { status: "suspended" })], nextAfter: null }));
    render(<ConnectedOrgsSection endpoints={ORGS} />);
    await flush();
    expect(screen.getByRole("heading", { name: "Connected orgs" })).toBeInTheDocument();
    expect(screen.getByText("node1.example.org")).toBeInTheDocument();
    expect(screen.getByText("Node n-1")).toBeInTheDocument();
    expect(screen.getByText("Suspended")).toBeInTheDocument();
    expect(screen.getAllByText("15 / 1,000", { selector: "td" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Grant allowance" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Reset seq" })).toHaveLength(2);
    expect(urlOf(fetchMock.mock.calls[0] as unknown[])).toBe("/api/v1/admin/connected-orgs?limit=50");
    // No filter, search or sort control.
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  });

  it("More appears only with a nextAfter, asks the next page by that cursor and appends; an action then re-reads EVERY loaded page in order", async () => {
    const user = userEvent.setup();
    const pages: Record<string, unknown> = {
      "/api/v1/admin/connected-orgs?limit=50": { orgs: [org(1)], nextAfter: "https://node1.example.org" },
      "/api/v1/admin/connected-orgs?limit=50&after=https%3A%2F%2Fnode1.example.org": { orgs: [org(2)], nextAfter: null },
    };
    fetchMock.mockImplementation((url: string, init?: RequestInit) => (init?.method === "POST" ? json(200, {}) : json(200, pages[url])));
    render(<ConnectedOrgsSection endpoints={ORGS} />);
    await flush();
    await user.click(screen.getByRole("button", { name: "More" }));
    await flush();
    expect(screen.getByText("node1.example.org")).toBeInTheDocument();
    expect(screen.getByText("node2.example.org")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();

    fetchMock.mockClear();
    await user.click(screen.getAllByRole("button", { name: "Suspend" })[0] as HTMLElement);
    await flush();
    const calls = fetchMock.mock.calls.map((c) => `${(c[1] as RequestInit | undefined)?.method ?? "GET"} ${urlOf(c)}`);
    expect(calls).toEqual([
      "POST /api/v1/admin/connected-orgs/org-1/suspension",
      "GET /api/v1/admin/connected-orgs?limit=50",
      "GET /api/v1/admin/connected-orgs?limit=50&after=https%3A%2F%2Fnode1.example.org",
    ]);
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({ suspended: true });
    // Both pages are still on screen.
    expect(screen.getByText("node2.example.org")).toBeInTheDocument();
  });

  it("Grant allowance sends the credits with a fresh Idempotency-Key, clears the input on success, and refuses a non-whole number without any request", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => (init?.method === "POST" ? json(200, {}) : json(200, { orgs: [org(1)], nextAfter: null })));
    render(<ConnectedOrgsSection endpoints={ORGS} />);
    await flush();
    const input = screen.getByRole("spinbutton", { name: "Allowance to grant node1.example.org" });
    await user.type(input, "1.5");
    await user.click(screen.getByRole("button", { name: "Grant allowance" }));
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a whole number of credits.");
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(false);

    await user.clear(input);
    await user.type(input, "250");
    await user.click(screen.getByRole("button", { name: "Grant allowance" }));
    await flush();
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST") as [string, RequestInit];
    expect(post[0]).toBe("/api/v1/admin/connected-orgs/org-1/allowance");
    expect(JSON.parse(post[1].body as string)).toEqual({ credits: 250 });
    expect((post[1].headers as Record<string, string>)["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect((screen.getByRole("spinbutton", { name: "Allowance to grant node1.example.org" }) as HTMLInputElement).value).toBe("");
  });

  it("Reset seq posts to the seq-reset route with no body, and a failed click shows one line and still re-reads", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => (init?.method === "POST" ? json(500, {}) : json(200, { orgs: [org(1)], nextAfter: null })));
    render(<ConnectedOrgsSection endpoints={ORGS} />);
    await flush();
    await user.click(screen.getByRole("button", { name: "Reset seq" }));
    await flush();
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST") as [string, RequestInit];
    expect(post[0]).toBe("/api/v1/admin/connected-orgs/org-1/seq-reset");
    expect(post[1].body).toBeUndefined();
    expect(screen.getByRole("alert")).toHaveTextContent("That did not go through. Try again.");
    expect(fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method !== "POST")).toHaveLength(2);
  });
});

const CONNECTIONS = { connections: "/api/v1/admin/connections" };
const target = (over: Partial<OutboundTargetView> = {}): OutboundTargetView => ({ alias: "prov", origin: "https://prov.example.org", offer: "Shared AI, paid from your cap.", status: "not_connected", cap: null, ...over });

describe("ConnectionsSection (customer)", () => {
  it("renders nothing for every non-admin outcome", async () => {
    for (const answer of [() => json(401, {}), () => json(403, {}), () => json(404, {}), () => Promise.reject(new Error("net")), () => json(200, { signer: "yes" })]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(answer);
      const { container, unmount } = render(<ConnectionsSection endpoints={CONNECTIONS} />);
      await flush();
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("lists each target with its offer, status and cap, with Connect, and Disconnect only when connected", async () => {
    fetchMock.mockReturnValue(json(200, { signer: true, targets: [target(), target({ alias: "other", origin: "https://other.example.org", offer: undefined, status: "connected", cap: 2500 })] }));
    render(<ConnectionsSection endpoints={CONNECTIONS} />);
    await flush();
    expect(screen.getByRole("heading", { name: "Connections" })).toBeInTheDocument();
    expect(screen.getByText("Shared AI, paid from your cap.")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("2,500")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Connect" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Disconnect" })).toHaveLength(1);
  });

  it("a node with no signing key shows one clear line, still shows the offers, and offers no Connect", async () => {
    fetchMock.mockReturnValue(json(200, { signer: false, targets: [target()] }));
    render(<ConnectionsSection endpoints={CONNECTIONS} />);
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("This node has no signing key, so it cannot connect to another node.");
    expect(screen.getByText("Shared AI, paid from your cap.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("Connect posts act, alias and the cap, shows the provider's answer and re-reads; a bad cap sends nothing", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === "POST" ? json(200, { alias: "prov", act: "connect", httpStatus: 200, status: "connected", error: null }) : json(200, { signer: true, targets: [target()] })
    );
    render(<ConnectionsSection endpoints={CONNECTIONS} />);
    await flush();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByRole("status")).toHaveTextContent("Enter a cap in whole credits.");
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toBe(false);

    await user.type(screen.getByRole("spinbutton", { name: "Cap in credits for prov" }), "1000");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await flush();
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST") as [string, RequestInit];
    expect(post[0]).toBe("/api/v1/admin/connections");
    expect(JSON.parse(post[1].body as string)).toEqual({ act: "connect", alias: "prov", cap: 1000 });
    expect(screen.getByRole("status")).toHaveTextContent("prov accepted the connection.");
    expect(fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method !== "POST")).toHaveLength(2);
  });

  it("a provider refusal shows its plain code, and an unreachable provider shows one line and STILL re-reads the table", async () => {
    const user = userEvent.setup();
    let mode: "refuse" | "unreachable" = "refuse";
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return json(200, { signer: true, targets: [target({ status: "connected", cap: 5 })] });
      return mode === "refuse" ? json(200, { alias: "prov", act: "disconnect", httpStatus: 409, status: null, error: "stale_seq" }) : json(502, { error: "target_unreachable" });
    });
    render(<ConnectionsSection endpoints={CONNECTIONS} />);
    await flush();
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("prov did not accept it: stale seq.");
    mode = "unreachable";
    fetchMock.mockClear();
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("Couldn't reach prov. Try again.");
    expect(fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method !== "POST")).toHaveLength(1);
  });

  it("the table style matches the AI access table: heading, rule, small table with a muted head", async () => {
    fetchMock.mockReturnValue(json(200, { signer: true, targets: [target()] }));
    const { container } = render(<ConnectionsSection endpoints={CONNECTIONS} />);
    await flush();
    expect(container.querySelector("h2.font-semibold.text-lg")).not.toBeNull();
    expect(container.querySelector("div.mt-2.border-b")).not.toBeNull();
    expect(container.querySelector("table.w-full.text-left.text-sm")).not.toBeNull();
    expect(container.querySelector("thead.text-muted-foreground.text-xs")).not.toBeNull();
  });
});
