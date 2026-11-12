// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import "@testing-library/jest-dom/vitest";
import type { NodeAiAccessView, NodeAiPermissionView } from "@cogni/agent-grants";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentAccessSection } from "../src/index.js";

const ENDPOINTS = { roles: "/api/v1/agent-access/roles" };

let allowed = false;
let asked = true;
const row = (o: Partial<NodeAiPermissionView> & Pick<NodeAiPermissionView, "section" | "principalUserId" | "who" | "scope" | "label" | "description">): NodeAiPermissionView => ({
  outside: false, hint: null, on: false, until: null, ...o,
});
let extra: NodeAiPermissionView[] = [];
let more = 0;
const view = (): NodeAiAccessView => ({
  canManage: true,
  more,
  permissions: [
    ...(asked ? [row({ section: "pending", principalUserId: "ext-1", who: "Helper bot", outside: true, hint: "GitHub linked", scope: "work_item:transition", label: "Update work items", description: "Move work items along and change their scores." })] : []),
    row({ section: "node", principalUserId: "u-node-ai", who: "node-ai", scope: "knowledge:write", label: "Save notes", description: "Save notes straight into the knowledge base.", on: allowed }),
    row({ section: "node", principalUserId: "u-node-ai", who: "node-ai", scope: "schedule:manage", label: "Change schedules", description: "Make, change and stop schedules." }),
    ...extra,
    row({ section: "outside", principalUserId: "ext-2", who: "Review agent", outside: true, scope: "edo:write", label: "Log decisions", description: "Write down choices and how they turned out.", on: true }),
  ],
});

// Plain response objects whose body resolves on the microtask queue, so a test can flush everything deterministically.
const fake = (status: number, body: unknown) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
const json = (status: number, body: unknown) => Promise.resolve(fake(status, body));
/** Drain every pending microtask (fetch resolution, json(), state updates) inside act: no timers, no sleeping. */
const flush = () =>
  act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });

const fetchMock = vi.fn();
beforeEach(() => {
  extra = [];
  more = 0;
  allowed = false;
  asked = true;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AgentAccessSection: a non-admin sees nothing", () => {
  it("renders nothing while the first answer is pending (no heading, no skeleton, no flash)", async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { container } = render(<AgentAccessSection endpoints={ENDPOINTS} />);
    expect(container).toBeEmptyDOMElement(); // synchronously, on first render
    await flush();
    expect(container).toBeEmptyDOMElement(); // and still, while the request is in flight
    expect(screen.queryByText("This node's AI")).toBeNull();
  });

  it.each([
    ["canManage false", () => json(200, { canManage: false, ai: [] })],
    ["401", () => json(401, { error: "unauthorized" })],
    ["403", () => json(403, { error: "authz_denied" })],
    ["404", () => json(404, { error: "not found" })],
    ["500", () => json(500, { error: "boom" })],
    ["429", () => json(429, { error: "slow down" })],
    ["a network failure", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["a body that is not JSON", () => Promise.resolve({ status: 200, ok: true, json: async () => { throw new SyntaxError("Unexpected token <"); } } as unknown as Response)],
    ["canManage true with no list", () => json(200, { canManage: true })],
  ])("renders nothing for %s, at every moment", async (_name, reply) => {
    fetchMock.mockImplementation(reply);
    const { container } = render(<AgentAccessSection endpoints={ENDPOINTS} />);
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await flush(); // the settled fetch and its json(), deterministically
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("This node's AI")).toBeNull();
  });

  it("does not re-check on focus after a 404 either (a missing route is permanent), but does after a 500", async () => {
    fetchMock.mockImplementation(() => json(404, {}));
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await flush();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    cleanup();
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => json(500, {}));
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await flush();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not re-check on focus while hidden", async () => {
    fetchMock.mockImplementation(() => json(200, { canManage: false, ai: [] }));
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await flush();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1); // a confirmed non-admin is not re-checked
  });
});

const SAVE = /^node-ai: Save notes$/;
const ASK = /^Helper bot: Update work items$/;

describe("AgentAccessSection: an admin", () => {
  it("forwards cursors, deduplicates recurring rows, and retains later-page Off/On controls after refresh", async () => {
    let laterOn = true;
    const cursor = { principalUserId: "external-a", scope: "knowledge:read" };
    const later = () => row({ section: "outside", principalUserId: "external-z", who: "Later agent", outside: true,
      scope: "knowledge:read", label: "Read notes", description: "Read shared notes.", on: laterOn });
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method) {
        expect(JSON.parse(init.body as string)).toEqual({ principalUserId: "external-z", scope: "knowledge:read" });
        laterOn = init.method === "POST";
        return json(200, { ok: true });
      }
      const query = new URL(url, "https://home.example").searchParams;
      if (query.has("afterPrincipal")) {
        expect(query.get("afterPrincipal")).toBe(cursor.principalUserId);
        expect(query.get("afterScope")).toBe(cursor.scope);
        return json(200, { canManage: true, permissions: [view().permissions[1], later()], more: 0, nextCursor: null });
      }
      return json(200, { ...view(), more: 1, nextCursor: cursor });
    });
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
    const control = /^Later agent: Read notes$/;
    expect(await screen.findByRole("switch", { name: control })).toHaveAttribute("aria-checked", "true");
    expect(screen.getAllByRole("switch", { name: SAVE })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    await userEvent.click(screen.getByRole("switch", { name: control }));
    await waitFor(() => expect(screen.getByRole("switch", { name: control })).toHaveAttribute("aria-checked", "false"));
    await waitFor(() => expect(screen.getByRole("switch", { name: control })).toBeEnabled());
    await userEvent.click(screen.getByRole("switch", { name: control }));
    await waitFor(() => expect(screen.getByRole("switch", { name: control })).toHaveAttribute("aria-checked", "true"));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method).map(([, init]) => init.method)).toEqual(["DELETE", "POST"]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.cache).toBe("no-store");
      expect(init.credentials).toBe("same-origin");
      expect(init.headers).not.toHaveProperty("Authorization");
    }
  });

  it("shows the unavailable state only on a confirmed 503, and retries from the link", async () => {
    fetchMock.mockImplementationOnce(() => json(503, { error: "authz_unavailable" }));
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Can't check access right now. Try again.");
    expect(screen.getByText("AI access")).toBeInTheDocument();
    fetchMock.mockImplementationOnce(() => json(200, view()));
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
  });

  it("shows one line when there is nothing to manage", async () => {
    fetchMock.mockImplementation(() => json(200, { canManage: true, permissions: [] }));
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    expect(await screen.findByText(/Nothing to manage/i)).toBeInTheDocument();
  });

  it("is one table, columns Who · Can do · Until · On, one row per grant row in three blocks", async () => {
    fetchMock.mockImplementation(() => json(200, view()));
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await screen.findByRole("table");
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Who", "Can do", "Until", "On"]);
    expect(screen.getAllByRole("rowgroup").length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByRole("table")).toHaveLength(1);
    expect(screen.getByText("Asks waiting")).toBeInTheDocument();
    expect(screen.getByText("This node's AI")).toBeInTheDocument();
    expect(screen.getByText("Outside agents")).toBeInTheDocument();
    expect(screen.getAllByRole("switch")).toHaveLength(4); // 1 ask + 2 node AI + 1 outside
    // Name and description come from the server, shown as sent. "Until" says there is no end.
    expect(screen.getByText("Save notes straight into the knowledge base.")).toBeInTheDocument();
    expect(screen.getAllByText("No end").length).toBe(3);
    // Outside agents carry the marker and the hint.
    expect(screen.getAllByText("outside")).toHaveLength(2);
    expect(screen.getByText("GitHub linked")).toBeInTheDocument();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\bjobs?\b|risk|Confirm|Allow\?/i);
    for (const b of screen.queryAllByRole("button")) expect(b.className).not.toMatch(/w-full/);
  });

  it("the switch is the whole decision: ON sends at once, OFF sends at once, no question either way", async () => {
    const calls: Array<{ method: string; body?: unknown; headers?: Record<string, string> }> = [];
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers as Record<string, string> });
      if (method === "POST") allowed = true;
      if (method === "DELETE") allowed = false;
      return json(200, method === "GET" ? view() : { changed: true });
    });
    render(<AgentAccessSection endpoints={ENDPOINTS} />);

    const toggle = await screen.findByRole("switch", { name: SAVE });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await userEvent.click(toggle);
    expect(screen.queryByText(/Allow\?|Yes|Confirm/)).toBeNull();
    await waitFor(() => expect(screen.getByRole("switch", { name: SAVE })).toHaveAttribute("aria-checked", "true"));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ principalUserId: "u-node-ai", scope: "knowledge:write" });

    await userEvent.click(screen.getByRole("switch", { name: SAVE }));
    await waitFor(() => expect(screen.getByRole("switch", { name: SAVE })).toHaveAttribute("aria-checked", "false"));
    expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({ principalUserId: "u-node-ai", scope: "knowledge:write" });
    expect(calls.every((c) => !c.headers || !("authorization" in Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [k.toLowerCase(), v]))))).toBe(true);
  });

  it("an outside agent named like this node's AI (an identifier) is never mistaken for it: badge first, name quoted, proven binding beside it, while the real one is plain mono", async () => {
    extra = [
      row({ section: "pending", principalUserId: "ext-9", who: "node-ai", outside: true, hint: "GitHub id 424242", scope: "edo:write", label: "Log decisions", description: "Write down choices and how they turned out." }),
      row({ section: "pending", principalUserId: "ext-10", who: "prioritizer", outside: true, hint: null, scope: "metric:compute", label: "Refresh numbers", description: "Update the numbers shown on the dashboards." }),
    ];
    fetchMock.mockImplementation(() => json(200, view()));
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await screen.findByRole("table");
    const imposter = screen.getByRole("switch", { name: /^node-ai: Log decisions$/ }).closest("tr")!;
    const who = within(imposter).getAllByRole("cell")[0]!;
    expect(who.textContent).toBe("outside\u201cnode-ai\u201dGitHub id 424242");
    expect(who.querySelector("span")?.textContent).toBe("outside"); // the badge is the first thing in the cell
    // No proof of a binding: say so, still badged and quoted.
    const noBinding = within(screen.getByRole("switch", { name: /^prioritizer: Refresh numbers$/ }).closest("tr")!).getAllByRole("cell")[0]!;
    expect(noBinding.textContent).toBe("outside\u201cprioritizer\u201dNo linked account");
    // This node's own AI of the same name is plain: no badge, no quotes.
    const mineRow = screen.getAllByRole("switch", { name: /^node-ai: Save notes$/ })[0]!.closest("tr")!;
    const mineCell = within(mineRow).getAllByRole("cell")[0]!;
    expect(mineCell.textContent).toBe("node-ai");
    expect(mineCell.querySelector("span")).toHaveClass("font-mono"); // an identifier, in mono
  });

  it("says how many outside rows are not shown when the list is cut", async () => {
    more = 7;
    fetchMock.mockImplementation(() => json(200, view()));
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    expect(await screen.findByText(/7 more outside rows are not shown/)).toBeInTheDocument();
  });

  it("flipping a pending ask ON approves it; the x dismisses it", async () => {
    const calls: Array<{ method: string; body?: unknown }> = [];
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method !== "GET") asked = false; // the ask leaves the asks block either way
      return json(200, method === "GET" ? view() : { changed: true });
    });
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    const pendingSwitch = await screen.findByRole("switch", { name: ASK });
    expect(pendingSwitch).toHaveAttribute("aria-checked", "false");
    await userEvent.click(pendingSwitch);
    await waitFor(() => expect(screen.queryByRole("switch", { name: ASK })).toBeNull());
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ principalUserId: "ext-1", scope: "work_item:transition" });

    asked = true;
    window.dispatchEvent(new Event("focus"));
    await userEvent.click(await screen.findByRole("button", { name: /^Dismiss the ask: Helper bot: Update work items$/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({ principalUserId: "ext-1", scope: "work_item:transition", deny: true });
  });

  it("an outside agent's row turns OFF with the same switch", async () => {
    const calls: Array<{ method: string; body?: unknown }> = [];
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return json(200, method === "GET" ? view() : { changed: true });
    });
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await userEvent.click(await screen.findByRole("switch", { name: /^Review agent: Log decisions$/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({ principalUserId: "ext-2", scope: "edo:write" });
  });

  it("lets an admin whose first load failed transiently see the table on the next focus", async () => {
    let attempt = 0;
    fetchMock.mockImplementation(() => (++attempt === 1 ? json(500, { error: "boom" }) : json(200, view())));
    const { container } = render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await flush();
    expect(container).toBeEmptyDOMElement(); // a transient failure shows nothing
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(screen.getAllByRole("switch")).toHaveLength(4); // and recovers
  });

  it("ignores a stale load that finishes after a click's reload", async () => {
    let releaseStale: (r: Response) => void = () => {};
    let gets = 0;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") { allowed = true; return json(200, { changed: true }); }
      gets += 1;
      if (gets === 2) return new Promise<Response>((resolve) => { releaseStale = resolve; }); // a focus load, held open
      return json(200, view());
    });
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await screen.findByRole("switch", { name: SAVE });
    window.dispatchEvent(new Event("focus")); // GET #2: started before the click, answers late with the old state
    await userEvent.click(screen.getByRole("switch", { name: SAVE }));
    await waitFor(() => expect(screen.getByRole("switch", { name: SAVE })).toHaveAttribute("aria-checked", "true"));
    releaseStale(fake(200, { canManage: true, permissions: view().permissions.map((p) => ({ ...p, on: false })) }));
    await flush();
    expect(screen.getByRole("switch", { name: SAVE })).toHaveAttribute("aria-checked", "true"); // not overwritten
  });

  it("keeps the admin's table when a reload after a click fails with a 500, and hides it on a 403", async () => {
    let mode: "ok" | "500" | "403" = "ok";
    fetchMock.mockImplementation((_u: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") !== "GET") return json(200, { changed: true });
      return mode === "ok" ? json(200, view()) : mode === "500" ? json(500, {}) : json(403, {});
    });
    const { container } = render(<AgentAccessSection endpoints={ENDPOINTS} />);
    const first = await screen.findByRole("switch", { name: SAVE });
    mode = "500";
    await userEvent.click(first);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(screen.getAllByRole("switch")).toHaveLength(4); // still there
    mode = "403";
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("shows a Skeleton in the saving row and ignores clicks on the other switches, never dimming a switch", async () => {
    fetchMock.mockImplementation((_u: string, init?: RequestInit) =>
      (init?.method ?? "GET") === "GET" ? json(200, view()) : new Promise<Response>(() => {}));
    const { container } = render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await userEvent.click(await screen.findByRole("switch", { name: SAVE }));
    await waitFor(() => expect(container.querySelector(".animate-pulse")).not.toBeNull());
    expect(screen.queryByRole("switch", { name: SAVE })).toBeNull(); // the saving row shows the Skeleton instead
    expect(container.querySelector("tr[aria-busy=true]")).not.toBeNull(); // and says so to a screen reader
    expect(screen.getByRole("status")).toHaveTextContent("Saving");
    const others = screen.getAllByRole("switch");
    expect(others).toHaveLength(3);
    for (const sw of others) {
      expect(sw).not.toBeDisabled();
      expect(sw.className).not.toMatch(/opacity/);
    }
    const before = fetchMock.mock.calls.length;
    await userEvent.click(others[0]!);
    expect(fetchMock.mock.calls.length).toBe(before); // locked: the click does nothing
  });

  it("uses no-store fetches with the browser session only", async () => {
    fetchMock.mockImplementation(() => json(200, view()));
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await screen.findByRole("table");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("same-origin");
  });

  it("shows a save failure as one line and keeps the table", async () => {
    fetchMock.mockImplementation((_u: string, init?: RequestInit) =>
      (init?.method ?? "GET") === "GET" ? json(200, view()) : json(500, { error: "x" }));
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await userEvent.click(await screen.findByRole("switch", { name: SAVE }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save that change. Try again.");
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("prints no token, id, key, scope string or path in the page text, labels included", async () => {
    allowed = true;
    fetchMock.mockImplementation(() => json(200, view()));
    const { container } = render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await screen.findByRole("table");
    const labels = [...container.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")).join(" ");
    const text = `${container.textContent ?? ""} ${labels}`;
    for (const bad of ["knowledge:write", "work_item", "u-node-ai", "ext-1", "/api/", "token", "curl", "Bearer"]) expect(text).not.toContain(bad);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
});
