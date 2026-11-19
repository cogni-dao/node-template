// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import "@testing-library/jest-dom/vitest";
import type { ConnectedOrgView, OutboundTargetView } from "@cogni/agent-grants";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedOrgsSection, ConnectionsSection } from "../src/index.js";

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
  allowance: 500 * n,
  debits: 15,
  cap: 1000,
  lastCallAt: null,
  ...over,
});
const ORGS = { list: "/api/v1/admin/connected-orgs" };
const urlOf = (call: unknown[]) => String(call[0]);
const method = (call: unknown[]) => (call[1] as RequestInit | undefined)?.method ?? "GET";
const posts = () => fetchMock.mock.calls.filter((c) => method(c) === "POST") as Array<[string, RequestInit]>;
const gets = () => fetchMock.mock.calls.filter((c) => method(c) !== "POST");

/** Every control the section renders is a real button or input with a name: this lists them by role. */
const controlNames = () => screen.getAllByRole("button").map((b) => b.textContent || b.getAttribute("aria-label"));

describe("ConnectedOrgsSection (provider) states", () => {
  it("LOADING: a skeleton that mirrors the items, under the one header, with no text", async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ConnectedOrgsSection endpoints={ORGS} />);
    expect(screen.getByRole("heading", { name: "Connected nodes" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Loading" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("HIDDEN: a 401, 403 or 404 renders nothing at all", async () => {
    for (const status of [401, 403, 404]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(() => json(status, {}));
      const { container, unmount } = render(<ConnectedOrgsSection endpoints={ORGS} />);
      await flush();
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("ERROR: a 503, a 500, a network error and a bad body each show \"Couldn't load.\" and Retry; Retry reads again", async () => {
    const user = userEvent.setup();
    for (const answer of [() => json(503, {}), () => json(500, {}), () => Promise.reject(new Error("net")), () => json(200, { nope: true })]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(answer);
      const { unmount } = render(<ConnectedOrgsSection endpoints={ORGS} />);
      await flush();
      expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load.");
      fetchMock.mockImplementation(() => json(200, { orgs: [org(1)], nextAfter: null }));
      await user.click(screen.getByRole("button", { name: "Retry" }));
      await flush();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByText("node1.example.org")).toBeInTheDocument();
      unmount();
    }
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.cache).toBe("no-store");
    expect(JSON.stringify(init.headers ?? {})).not.toMatch(/authorization/i);
  });

  it("EMPTY: one short line", async () => {
    fetchMock.mockReturnValue(json(200, { orgs: [], nextAfter: null }));
    render(<ConnectedOrgsSection endpoints={ORGS} />);
    await flush();
    expect(screen.getByText("No nodes yet.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("SPARSE: name, a short badge, ONE number and the controls; no subtitle, no origin, no debits or cap in the row", async () => {
    fetchMock.mockReturnValue(
      json(200, { orgs: [org(1, { nodeId: "toks5", lastCallAt: "2026-11-18T00:00:00.000Z" }), org(2, { status: "suspended" }), org(3, { status: "disconnected" })], nextAfter: null })
    );
    const { container } = render(<ConnectedOrgsSection endpoints={ORGS} />);
    await flush();
    expect(screen.getByRole("heading", { name: "Connected nodes" })).toBeInTheDocument();
    expect(screen.getByText("toks5")).toBeInTheDocument();
    expect(screen.getByText("node2.example.org")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Suspended")).toBeInTheDocument();
    expect(screen.getByText("Off")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Allowance 500 cr/ })).toHaveTextContent("500 cr");
    expect(screen.getAllByRole("button", { name: "Add credits" })).toHaveLength(3);
    // Cut hard: nothing but the structure.
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).not.toMatch(/Used|Cap|Reset|credits to add|spending|Last call/i);
    // Layout is stacked on a phone: the item is a column that becomes a row at md; the primary actions are 44px high there.
    expect(screen.getAllByRole("listitem")[0]?.className).toContain("flex-col");
    expect(screen.getAllByRole("listitem")[0]?.className).toContain("md:flex-row");
    expect(screen.getAllByRole("button", { name: "Add credits" })[0]?.className).toMatch(/h-11/);
  });

  it("DENSE: 50 per page bounded read, More appends by the cursor, and an action re-reads every loaded page", async () => {
    const user = userEvent.setup();
    const pages: Record<string, unknown> = {
      "/api/v1/admin/connected-orgs?limit=50": { orgs: [org(1)], nextAfter: "https://node1.example.org" },
      "/api/v1/admin/connected-orgs?limit=50&after=https%3A%2F%2Fnode1.example.org": { orgs: [org(2)], nextAfter: null },
    };
    fetchMock.mockImplementation((url: string, init?: RequestInit) => (init?.method === "POST" ? json(200, {}) : json(200, pages[url])));
    render(<ConnectedOrgsSection endpoints={ORGS} />);
    await flush();
    expect(urlOf(fetchMock.mock.calls[0] as unknown[])).toBe("/api/v1/admin/connected-orgs?limit=50");
    await user.click(screen.getByRole("button", { name: "More" }));
    await flush();
    expect(screen.getByText("node2.example.org")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();

    fetchMock.mockClear();
    await user.click(screen.getByRole("button", { name: "More for node1.example.org" }));
    await user.click(screen.getByRole("menuitem", { name: "Suspend" }));
    await flush();
    expect(fetchMock.mock.calls.map((c) => `${method(c)} ${urlOf(c)}`)).toEqual([
      "POST /api/v1/admin/connected-orgs/org-1/suspension",
      "GET /api/v1/admin/connected-orgs?limit=50",
      "GET /api/v1/admin/connected-orgs?limit=50&after=https%3A%2F%2Fnode1.example.org",
    ]);
    expect(JSON.parse(posts()[0]?.[1].body as string)).toEqual({ suspended: true });
    expect(screen.getByText("node2.example.org")).toBeInTheDocument();
  });
});

describe("ConnectedOrgsSection (provider) controls", () => {
  const ready = (orgs: ConnectedOrgView[]) =>
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => (init?.method === "POST" ? json(200, {}) : json(200, { orgs, nextAfter: null })));

  it("the number opens used and cap, one disclosure away", async () => {
    const user = userEvent.setup();
    ready([org(1)]);
    render(<ConnectedOrgsSection endpoints={ORGS} />);
    await flush();
    await user.click(screen.getByRole("button", { name: /Allowance 500 cr/ }));
    expect(screen.getByText("Used")).toBeInTheDocument();
    expect(screen.getByText("15 cr")).toBeInTheDocument();
    expect(screen.getByText("Cap")).toBeInTheDocument();
    expect(screen.getByText("1,000 cr")).toBeInTheDocument();
  });

  it("Add credits sends the number with a fresh Idempotency-Key and clears the input; a non-whole number sends nothing", async () => {
    const user = userEvent.setup();
    ready([org(1)]);
    render(<ConnectedOrgsSection endpoints={ORGS} />);
    await flush();
    const input = screen.getByRole("spinbutton", { name: "Credits to add for node1.example.org" });
    expect(input).toHaveAttribute("placeholder", "500");
    await user.type(input, "1.5");
    await user.click(screen.getByRole("button", { name: "Add credits" }));
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a number.");
    expect(posts()).toHaveLength(0);

    await user.clear(input);
    await user.type(input, "250");
    await user.click(screen.getByRole("button", { name: "Add credits" }));
    await flush();
    expect(posts()[0]?.[0]).toBe("/api/v1/admin/connected-orgs/org-1/allowance");
    expect(JSON.parse(posts()[0]?.[1].body as string)).toEqual({ credits: 250 });
    expect((posts()[0]?.[1].headers as Record<string, string>)["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect((screen.getByRole("spinbutton", { name: "Credits to add for node1.example.org" }) as HTMLInputElement).value).toBe("");
  });

  it("the ⋯ menu holds Suspend (Resume when suspended) and Reset seq, with no explanation text; Reset seq asks one short question first", async () => {
    const user = userEvent.setup();
    ready([org(1), org(2, { status: "suspended" })]);
    const confirm = vi.spyOn(window, "confirm");
    render(<ConnectedOrgsSection endpoints={ORGS} />);
    await flush();

    await user.click(screen.getByRole("button", { name: "More for node2.example.org" }));
    expect(screen.getByRole("menuitem", { name: "Resume" })).toBeInTheDocument();
    expect(screen.getByRole("menu").textContent).toBe("ResumeReset seq");
    await user.click(screen.getByRole("menuitem", { name: "Resume" }));
    await flush();
    expect(JSON.parse(posts()[0]?.[1].body as string)).toEqual({ suspended: false });

    // Declined: nothing is sent. Accepted: one POST to the seq-reset route with no body, then every loaded page is re-read.
    confirm.mockReturnValueOnce(false);
    await user.click(screen.getByRole("button", { name: "More for node1.example.org" }));
    await user.click(screen.getByRole("menuitem", { name: "Reset seq" }));
    await flush();
    expect(confirm).toHaveBeenCalledWith("Reset seq to 1?");
    expect(posts()).toHaveLength(1);
    confirm.mockReturnValueOnce(true);
    await user.click(screen.getByRole("button", { name: "More for node1.example.org" }));
    await user.click(screen.getByRole("menuitem", { name: "Reset seq" }));
    await flush();
    expect(posts()[1]?.[0]).toBe("/api/v1/admin/connected-orgs/org-1/seq-reset");
    expect(posts()[1]?.[1].body).toBeUndefined();
    confirm.mockRestore();
  });

  it("a failed click shows one short line and still re-reads", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => (init?.method === "POST" ? json(500, {}) : json(200, { orgs: [org(1)], nextAfter: null })));
    render(<ConnectedOrgsSection endpoints={ORGS} />);
    await flush();
    await user.click(screen.getByRole("spinbutton", { name: "Credits to add for node1.example.org" }));
    await user.keyboard("5");
    await user.click(screen.getByRole("button", { name: "Add credits" }));
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("Didn't go through.");
    expect(gets()).toHaveLength(2);
    expect(controlNames()).toContain("Add credits");
  });
});

const CONNECTIONS = { connections: "/api/v1/admin/connections" };
const target = (over: Partial<OutboundTargetView> = {}): OutboundTargetView => ({ alias: "prov", origin: "https://prov.example.org", offer: "Shared AI, paid from your cap.", status: "not_connected", cap: null, ...over });
const view = (targets: OutboundTargetView[], signer = true) => ({ signer, targets });

describe("ConnectionsSection (customer) states", () => {
  it("LOADING: a skeleton that mirrors the items, under the one header, with no text", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ConnectionsSection endpoints={CONNECTIONS} />);
    expect(screen.getByRole("heading", { name: "Connections" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Loading" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("HIDDEN: a 401, 403 or 404 renders nothing at all", async () => {
    for (const status of [401, 403, 404]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(() => json(status, {}));
      const { container, unmount } = render(<ConnectionsSection endpoints={CONNECTIONS} />);
      await flush();
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("ERROR: a 503, a 500, a network error and a bad body each show \"Couldn't load.\" and Retry", async () => {
    const user = userEvent.setup();
    for (const answer of [() => json(503, {}), () => json(500, {}), () => Promise.reject(new Error("net")), () => json(200, { signer: "yes" })]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(answer);
      const { unmount } = render(<ConnectionsSection endpoints={CONNECTIONS} />);
      await flush();
      expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load.");
      fetchMock.mockImplementation(() => json(200, view([target()])));
      await user.click(screen.getByRole("button", { name: "Retry" }));
      await flush();
      expect(screen.getByText("prov")).toBeInTheDocument();
      unmount();
    }
  });

  it("EMPTY: one short line", async () => {
    fetchMock.mockReturnValue(json(200, view([])));
    render(<ConnectionsSection endpoints={CONNECTIONS} />);
    await flush();
    expect(screen.getByText("No nodes yet.")).toBeInTheDocument();
  });

  it("SPARSE and DENSE: name, a short badge, the cap as ONE number only when connected; no offer text, no origin, no label sentences in the row", async () => {
    const many = Array.from({ length: 12 }, (_, i) => target({ alias: `n${i}`, origin: `https://n${i}.example.org`, offer: undefined }));
    fetchMock.mockReturnValue(json(200, view([target(), target({ alias: "other", origin: "https://other.example.org", status: "connected", cap: 2500 }), ...many])));
    const { container } = render(<ConnectionsSection endpoints={CONNECTIONS} />);
    await flush();
    expect(screen.getAllByRole("listitem")).toHaveLength(14);
    expect(screen.getAllByText("Off", { selector: "span" })).toHaveLength(13);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("2,500 cr")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Shared AI|example\.org|Spending/);
    expect(screen.getAllByRole("button", { name: "Connect" })).toHaveLength(14);
    expect(screen.getAllByRole("button", { name: "Connect" })[0]?.className).toMatch(/h-11/);
    expect(screen.getAllByRole("listitem")[0]?.className).toContain("flex-col");
  });
});

describe("ConnectionsSection (customer) controls", () => {
  const ready = (targets: OutboundTargetView[], signer = true, post: () => Promise<Response> = () => json(200, { status: "connected", httpStatus: 200, error: null })) =>
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => (init?.method === "POST" ? post() : json(200, view(targets, signer))));

  it("the offer is a small info icon with the text in a popover, never in the row", async () => {
    const user = userEvent.setup();
    ready([target()]);
    render(<ConnectionsSection endpoints={CONNECTIONS} />);
    await flush();
    expect(screen.queryByText("Shared AI, paid from your cap.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Offer from prov" }));
    expect(screen.getByText("Shared AI, paid from your cap.")).toBeInTheDocument();
  });

  it("Connect sends act, alias and the cap number, shows the provider's answer in a few words and re-reads; a non-number sends nothing", async () => {
    const user = userEvent.setup();
    ready([target()]);
    render(<ConnectionsSection endpoints={CONNECTIONS} />);
    await flush();
    const input = screen.getByRole("spinbutton", { name: "Cap for prov" });
    expect(input).toHaveAttribute("placeholder", "500");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByRole("status")).toHaveTextContent("Enter a number.");
    expect(posts()).toHaveLength(0);

    await user.type(input, "1000");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await flush();
    expect(posts()[0]?.[0]).toBe("/api/v1/admin/connections");
    expect(JSON.parse(posts()[0]?.[1].body as string)).toEqual({ act: "connect", alias: "prov", cap: 1000 });
    expect(screen.getByRole("status")).toHaveTextContent("prov: connected");
    expect(gets()).toHaveLength(2);
  });

  it("Disconnect is in the ⋯ menu, only when connected; a refusal shows its plain code, and an unreachable provider shows one word and STILL re-reads", async () => {
    const user = userEvent.setup();
    let mode: "refuse" | "unreachable" = "refuse";
    ready([target({ status: "connected", cap: 5 })], true, () =>
      mode === "refuse" ? json(200, { alias: "prov", act: "disconnect", httpStatus: 409, status: null, error: "stale_seq" }) : json(502, { error: "target_unreachable" })
    );
    render(<ConnectionsSection endpoints={CONNECTIONS} />);
    await flush();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "More for prov" }));
    await user.click(screen.getByRole("menuitem", { name: "Disconnect" }));
    await flush();
    expect(JSON.parse(posts()[0]?.[1].body as string)).toEqual({ act: "disconnect", alias: "prov" });
    expect(screen.getByRole("status")).toHaveTextContent("prov: stale seq");
    mode = "unreachable";
    fetchMock.mockClear();
    await user.click(screen.getByRole("button", { name: "More for prov" }));
    await user.click(screen.getByRole("menuitem", { name: "Disconnect" }));
    await flush();
    expect(screen.getByRole("status")).toHaveTextContent("prov: unreachable");
    expect(gets()).toHaveLength(1);
  });

  it("a not-connected row has no ⋯ menu; a node with no signing key shows \"No signing key.\" and no controls, but names and badges stay", async () => {
    ready([target()], false);
    render(<ConnectionsSection endpoints={CONNECTIONS} />);
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("No signing key.");
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.getByText("prov")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Offer from prov" })).toBeInTheDocument();
    cleanup();
    ready([target()]);
    render(<ConnectionsSection endpoints={CONNECTIONS} />);
    await flush();
    expect(screen.queryByRole("button", { name: "More for prov" })).toBeNull();
  });

  it("a click in flight replaces that row's controls with a skeleton and ignores every other click", async () => {
    const user = userEvent.setup();
    let release: (r: Response) => void = () => undefined;
    ready([target(), target({ alias: "b", origin: "https://b.example.org" })], true, () => new Promise<Response>((resolve) => (release = resolve)));
    render(<ConnectionsSection endpoints={CONNECTIONS} />);
    await flush();
    await user.type(screen.getByRole("spinbutton", { name: "Cap for prov" }), "10");
    await user.type(screen.getByRole("spinbutton", { name: "Cap for b" }), "10");
    await user.click(screen.getAllByRole("button", { name: "Connect" })[0] as HTMLElement);
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("Saving");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(posts()).toHaveLength(1);
    release(fake(200, { status: "connected", httpStatus: 200, error: null }));
    await flush();
  });
});
