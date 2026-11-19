// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import "@testing-library/jest-dom/vitest";
import type { ConnectedOrgView, OutboundTargetView } from "@cogni/agent-grants";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedOrgsSection, ConnectionsSection, describeConnectionFailure, type Money } from "../src/index.js";

const fake = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
const json = (status: number, body: unknown) => Promise.resolve(fake(status, body));
const flush = () =>
  act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });

const fetchMock = vi.fn();

beforeAll(() => {
  // Radix menus and popovers need these in jsdom.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

const org = (n: number, over: Partial<ConnectedOrgView> = {}): ConnectedOrgView => ({
  orgUserId: `org-${n}`,
  issuer: `https://node${n}.example.org`,
  status: "connected",
  allowance: 50_000_000 * n,
  debits: 15_000_000,
  cap: 100_000_000,
  lastCallAt: null,
  ...over,
});
const ORGS = { list: "/api/v1/admin/connected-orgs" };
const urlOf = (call: unknown[]) => String(call[0]);
const method = (call: unknown[]) => (call[1] as RequestInit | undefined)?.method ?? "GET";
const posts = () => fetchMock.mock.calls.filter((c) => method(c) === "POST") as Array<[string, RequestInit]>;
const gets = () => fetchMock.mock.calls.filter((c) => method(c) !== "POST");

/** The node injects its own rate; this one is 10,000,000 credits per dollar, like the node's. */
const MONEY: Money = {
  format: (credits) => `$${(credits / 10_000_000).toFixed(2)}`,
  toCredits: (dollars) => (Number.isFinite(dollars) && Math.round(dollars * 100) >= 1 ? Math.round(dollars * 100) * 100_000 : null),
};

describe("ConnectedOrgsSection (provider)", () => {
  const ready = (orgs: ConnectedOrgView[], post: () => Promise<Response> = () => json(200, {})) =>
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => (init?.method === "POST" ? post() : json(200, { orgs, nextAfter: null })));

  it("HIDDEN: a 401, 403 or 404 renders nothing at all", async () => {
    for (const status of [401, 403, 404]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(() => json(status, {}));
      const { container, unmount } = render(<ConnectedOrgsSection endpoints={ORGS} money={MONEY} />);
      await flush();
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("ERROR and EMPTY: \"Couldn't load.\" with Retry, and one short line when there are no nodes", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(() => json(503, {}));
    render(<ConnectedOrgsSection endpoints={ORGS} money={MONEY} />);
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load.");
    fetchMock.mockImplementation(() => json(200, { orgs: [], nextAfter: null }));
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(screen.getByText("No nodes yet.")).toBeInTheDocument();
  });

  it("a row is the node's NAME (host as a small second line), dollars used of the limit, dollars left, and the On switch; never raw credits", async () => {
    ready([org(1, { name: "toks5" }), org(2, { status: "suspended" }), org(3, { status: "disconnected" })]);
    const { container } = render(<ConnectedOrgsSection endpoints={ORGS} money={MONEY} />);
    await flush();
    expect(screen.getByRole("columnheader", { name: "Node" })).toBeInTheDocument();
    expect(screen.getByText("toks5")).toBeInTheDocument();
    expect(screen.getByText("node1.example.org")).toBeInTheDocument();
    // No name configured: the host is the name.
    expect(screen.getByText("node2.example.org")).toBeInTheDocument();
    expect(screen.getAllByText("$1.50")).toHaveLength(3);
    expect(screen.getAllByText("of $10.00")).toHaveLength(3);
    expect(screen.getByText("$5.00")).toBeInTheDocument();
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "toks5: On" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "node2.example.org: On" })).toHaveAttribute("aria-checked", "false");
    expect(container.textContent).not.toMatch(/\bcr\b|Reset|seq/);
  });

  it("the switch Suspends (and Resumes) through the suspension route and re-reads", async () => {
    const user = userEvent.setup();
    ready([org(1, { name: "toks5" }), org(2, { status: "suspended" })]);
    render(<ConnectedOrgsSection endpoints={ORGS} money={MONEY} />);
    await flush();
    await user.click(screen.getByRole("switch", { name: "toks5: On" }));
    await flush();
    await user.click(screen.getByRole("switch", { name: "node2.example.org: On" }));
    await flush();
    expect(posts().map(([url, init]) => [url, JSON.parse(init.body as string)])).toEqual([
      ["/api/v1/admin/connected-orgs/org-1/suspension", { suspended: true }],
      ["/api/v1/admin/connected-orgs/org-2/suspension", { suspended: false }],
    ]);
    expect(gets().length).toBeGreaterThanOrEqual(3);
  });

  it("free credits are typed in dollars behind the + beside Left: $5 posts 50,000,000 credits with a fresh Idempotency-Key; a bad amount posts nothing", async () => {
    const user = userEvent.setup();
    ready([org(1, { name: "toks5" })]);
    render(<ConnectedOrgsSection endpoints={ORGS} money={MONEY} />);
    await flush();
    await user.click(screen.getByRole("button", { name: "Free credits for toks5" }));
    const input = screen.getByLabelText("Free credits");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter up to $100.");
    expect(posts()).toHaveLength(0);
    await user.type(input, "5");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await flush();
    expect(posts()[0]?.[0]).toBe("/api/v1/admin/connected-orgs/org-1/allowance");
    expect(JSON.parse(posts()[0]?.[1].body as string)).toEqual({ credits: 50_000_000 });
    expect((posts()[0]?.[1].headers as Record<string, string>)["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("a failed click is ONE short line under that row's name, never a raw status: 403 is \"Not allowed.\", 500 is \"Couldn't save.\"", async () => {
    const user = userEvent.setup();
    let status = 403;
    ready([org(1, { name: "toks5" }), org(2)], () => json(status, {}));
    render(<ConnectedOrgsSection endpoints={ORGS} money={MONEY} />);
    await flush();
    for (const [code, text] of [[403, "Not allowed."], [500, "Couldn't save."]] as const) {
      status = code;
      await user.click(screen.getByRole("switch", { name: "toks5: On" }));
      await flush();
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(text);
      expect(alert).toHaveAttribute("title", String(code));
      expect(alert.closest("tr")).toHaveTextContent("toks5");
      expect(alert.closest("tr")).not.toHaveTextContent("node2.example.org");
    }
  });

  it("DENSE: More appends the next page by the cursor", async () => {
    const user = userEvent.setup();
    const pages: Record<string, unknown> = {
      "/api/v1/admin/connected-orgs?limit=50": { orgs: [org(1)], nextAfter: "https://node1.example.org" },
      "/api/v1/admin/connected-orgs?limit=50&after=https%3A%2F%2Fnode1.example.org": { orgs: [org(2)], nextAfter: null },
    };
    fetchMock.mockImplementation((url: string) => json(200, pages[url]));
    render(<ConnectedOrgsSection endpoints={ORGS} money={MONEY} />);
    await flush();
    await user.click(screen.getByRole("button", { name: "More" }));
    await flush();
    expect(urlOf(fetchMock.mock.calls[1] as unknown[])).toBe("/api/v1/admin/connected-orgs?limit=50&after=https%3A%2F%2Fnode1.example.org");
    expect(screen.getByText("node2.example.org")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  });
});

const CONNECTIONS = { connections: "/api/v1/admin/connections" };
const target = (over: Partial<OutboundTargetView> = {}): OutboundTargetView => ({ alias: "prov", origin: "https://prov.example.org", offer: "Shared AI.", status: "not_connected", cap: null, ...over });
const view = (targets: OutboundTargetView[], signer = true) => ({ signer, targets });

describe("ConnectionsSection (customer)", () => {
  const ready = (targets: OutboundTargetView[], signer = true, post: () => Promise<Response> = () => json(200, { status: "connected", httpStatus: 200, error: null })) =>
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => (init?.method === "POST" ? post() : json(200, view(targets, signer))));

  it("HIDDEN on 401, 403 or 404; ERROR shows \"Couldn't load.\"; EMPTY is one short line", async () => {
    for (const status of [401, 403, 404]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(() => json(status, {}));
      const { container, unmount } = render(<ConnectionsSection endpoints={CONNECTIONS} money={MONEY} />);
      await flush();
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
    fetchMock.mockImplementation(() => json(500, {}));
    const { unmount } = render(<ConnectionsSection endpoints={CONNECTIONS} money={MONEY} />);
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load.");
    unmount();
    fetchMock.mockImplementation(() => json(200, view([])));
    render(<ConnectionsSection endpoints={CONNECTIONS} money={MONEY} />);
    await flush();
    expect(screen.getByText("No nodes yet.")).toBeInTheDocument();
  });

  it("turning a row On needs a dollar limit: none shows \"Set a limit.\" and posts nothing; $5 posts a connect with 50,000,000 credits", async () => {
    const user = userEvent.setup();
    ready([target()]);
    render(<ConnectionsSection endpoints={CONNECTIONS} money={MONEY} />);
    await flush();
    expect(screen.getByText("prov.example.org")).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "prov: On" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Set a limit.");
    expect(posts()).toHaveLength(0);
    await user.type(screen.getByRole("spinbutton", { name: "Limit in dollars for prov" }), "5");
    await user.click(screen.getByRole("switch", { name: "prov: On" }));
    await flush();
    expect(JSON.parse(posts()[0]?.[1].body as string)).toEqual({ act: "connect", alias: "prov", cap: 50_000_000 });
  });

  it("a row that is On shows its limit in dollars and turning it Off posts a disconnect; an out-of-sync refusal is one short line", async () => {
    const user = userEvent.setup();
    ready([target({ status: "connected", cap: 50_000_000 })], true, () => json(200, { status: null, httpStatus: 409, error: "stale_seq" }));
    render(<ConnectionsSection endpoints={CONNECTIONS} money={MONEY} />);
    await flush();
    expect(screen.getByText("$5.00")).toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).toBeNull();
    await user.click(screen.getByRole("switch", { name: "prov: On" }));
    await flush();
    expect(JSON.parse(posts()[0]?.[1].body as string)).toEqual({ act: "disconnect", alias: "prov" });
    expect(screen.getByRole("alert")).toHaveTextContent("Out of sync. Try again.");
  });

  it("with no signing key: one short line, and the switch is locked (a click sends nothing)", async () => {
    const user = userEvent.setup();
    ready([target()], false);
    render(<ConnectionsSection endpoints={CONNECTIONS} money={MONEY} />);
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("No signing key.");
    const sw = screen.getByRole("switch", { name: "prov: On" });
    expect(sw).toHaveAttribute("aria-disabled", "true");
    await user.click(sw);
    expect(posts()).toHaveLength(0);
  });

  it("the offer is a small info icon with the text in a popover, never in the row", async () => {
    const user = userEvent.setup();
    ready([target()]);
    render(<ConnectionsSection endpoints={CONNECTIONS} money={MONEY} />);
    await flush();
    expect(screen.queryByText("Shared AI.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Offer from prov" }));
    expect(screen.getByText("Shared AI.")).toBeInTheDocument();
  });
});

describe("the customer's failure words (never a raw status)", () => {
  it("maps 401 and 403 to Not allowed., a 409 stale_seq or seq_jump to Out of sync. Try again., and anything else to Couldn't connect.; the status is returned only for a title", () => {
    expect(describeConnectionFailure({ status: "connected" }, 200)).toBeNull();
    expect(describeConnectionFailure({ status: "disconnected" }, 200)).toBeNull();
    expect(describeConnectionFailure({ status: null, error: "invalid_token", httpStatus: 401 }, 200)).toEqual({ text: "Not allowed.", code: 401 });
    expect(describeConnectionFailure({ status: null, error: "x", httpStatus: 403 }, 200)).toEqual({ text: "Not allowed.", code: 403 });
    expect(describeConnectionFailure({ error: "forbidden" }, 403)).toEqual({ text: "Not allowed.", code: 403 });
    expect(describeConnectionFailure({ status: null, error: "stale_seq", httpStatus: 409 }, 200)).toEqual({ text: "Out of sync. Try again.", code: 409 });
    expect(describeConnectionFailure({ status: null, error: "seq_jump", httpStatus: 409 }, 200)).toEqual({ text: "Out of sync. Try again.", code: 409 });
    expect(describeConnectionFailure({ status: null, error: "other", httpStatus: 409 }, 200)).toEqual({ text: "Couldn't connect.", code: 409 });
    expect(describeConnectionFailure({ status: null, error: "invalid_claims", httpStatus: 400 }, 200)).toEqual({ text: "Couldn't connect.", code: 400 });
    expect(describeConnectionFailure({ error: "unknown_alias" }, 404)).toEqual({ text: "Couldn't connect.", code: 404 });
    expect(describeConnectionFailure({ error: "target_unreachable" }, 502)).toEqual({ text: "Couldn't connect.", code: 502 });
    expect(describeConnectionFailure(null, 500)).toEqual({ text: "Couldn't connect.", code: 500 });
    expect(describeConnectionFailure({ error: "signer_unavailable" }, 503)).toEqual({ text: "No signing key.", code: 503 });
  });
});
