// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import "@testing-library/jest-dom/vitest";
import type { NodeAiAccessView } from "@cogni/agent-grants";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentAccessSection } from "../src/index.js";

const ENDPOINTS = { roles: "/api/v1/agent-access/roles" };

let allowed = false;
const view = (): NodeAiAccessView => ({
  canManage: true,
  permissions: [
    { principal: "node-ai", ai: "General assistant", scope: "knowledge:write", permission: "Save notes to this node's knowledge base", allowed },
    { principal: "node-ai", ai: "General assistant", scope: "schedule:manage", permission: "Create and change schedules", allowed: false },
    { principal: "prioritizer", ai: "Priority scorer", scope: "work_item:transition", permission: "Update work items and their priority scores", allowed: false },
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
  allowed = false;
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

  it("does not re-check on focus while hidden", async () => {
    fetchMock.mockImplementation(() => json(200, { canManage: false, ai: [] }));
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await flush();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1); // a confirmed non-admin is not re-checked
  });
});

const SAVE = /^General assistant: Save notes to this node's knowledge base$/;

describe("AgentAccessSection: an admin", () => {
  it("shows the unavailable state only on a confirmed 503, and retries from the link", async () => {
    fetchMock.mockImplementationOnce(() => json(503, { error: "authz_unavailable" }));
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Can't check access right now. Try again.");
    expect(screen.getByText("This node's AI")).toBeInTheDocument();
    fetchMock.mockImplementationOnce(() => json(200, view()));
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findAllByRole("row")).toHaveLength(4);
  });

  it("shows an empty line when there is nothing to manage", async () => {
    fetchMock.mockImplementation(() => json(200, { canManage: true, permissions: [] }));
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    expect(await screen.findByText(/No permissions to manage/i)).toBeInTheDocument();
  });

  it("is one compact table: a row per AI and permission, columns AI, Permission and a switch", async () => {
    fetchMock.mockImplementation(() => json(200, view()));
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await screen.findByRole("table");
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["AI", "Permission", "Allowed"]);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("General assistant")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Priority scorer")).toBeInTheDocument();
    expect(screen.getAllByRole("switch")).toHaveLength(3);
    // No cards, no risk chips, no full-width buttons, no "job".
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\bjobs?\b|risk/i);
    for (const b of screen.queryAllByRole("button")) expect(b.className).not.toMatch(/w-full/);
  });

  it("allows with one inline question and removes with none, reloading after each click", async () => {
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
    expect(screen.getByText("Allow?")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0); // asked once, nothing sent yet
    await userEvent.click(screen.getByRole("button", { name: /^Yes, allow General assistant: Save notes/ }));
    const on = await screen.findByRole("switch", { name: SAVE });
    await waitFor(() => expect(on).toHaveAttribute("aria-checked", "true"));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ principal: "node-ai", scope: "knowledge:write" });

    await userEvent.click(on); // no question
    await waitFor(() => expect(screen.getByRole("switch", { name: SAVE })).toHaveAttribute("aria-checked", "false"));
    expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({ principal: "node-ai", scope: "knowledge:write" });
    expect(calls.every((c) => !c.headers || !("authorization" in Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [k.toLowerCase(), v]))))).toBe(true);
  });

  it("No on the question sends nothing and leaves the switch off", async () => {
    fetchMock.mockImplementation(() => json(200, view()));
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await userEvent.click(await screen.findByRole("switch", { name: SAVE }));
    await userEvent.click(screen.getByRole("button", { name: /^No, do not allow/ }));
    expect(screen.getByRole("switch", { name: SAVE })).toHaveAttribute("aria-checked", "false");
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toHaveLength(0);
  });

  it("lets an admin whose first load failed transiently see the table on the next focus", async () => {
    let attempt = 0;
    fetchMock.mockImplementation(() => (++attempt === 1 ? json(500, { error: "boom" }) : json(200, view())));
    const { container } = render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await flush();
    expect(container).toBeEmptyDOMElement(); // a transient failure shows nothing
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(screen.getAllByRole("switch")).toHaveLength(3); // and recovers
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
    window.dispatchEvent(new Event("focus")); // GET #2: started before the click, answers late with allowed=false
    await userEvent.click(screen.getByRole("switch", { name: SAVE }));
    await userEvent.click(screen.getByRole("button", { name: /^Yes, allow/ }));
    await waitFor(() => expect(screen.getByRole("switch", { name: SAVE })).toHaveAttribute("aria-checked", "true"));
    releaseStale(fake(200, { canManage: true, permissions: view().permissions.map((p) => ({ ...p, allowed: false })) }));
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
    await userEvent.click(await screen.findByRole("switch", { name: SAVE }));
    mode = "500";
    await userEvent.click(screen.getByRole("button", { name: /^Yes, allow/ }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(screen.getAllByRole("switch")).toHaveLength(3); // still there
    mode = "403";
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("shows a Skeleton in the saving row and ignores clicks on the other switches, never dimming a switch", async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementation((_u: string, init?: RequestInit) =>
      (init?.method ?? "GET") === "GET" ? json(200, view()) : new Promise<Response>((resolve) => { release = resolve; }));
    const { container } = render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await userEvent.click(await screen.findByRole("switch", { name: SAVE }));
    await userEvent.click(screen.getByRole("button", { name: /^Yes, allow/ }));
    await waitFor(() => expect(container.querySelector(".animate-pulse")).not.toBeNull());
    expect(screen.queryByRole("switch", { name: SAVE })).toBeNull(); // the saving row shows the Skeleton instead
    const others = screen.getAllByRole("switch");
    expect(others).toHaveLength(2);
    for (const sw of others) {
      expect(sw).not.toBeDisabled();
      expect(sw.className).not.toMatch(/opacity/);
    }
    await userEvent.click(others[0]!);
    expect(screen.queryByText("Allow?")).toBeNull(); // locked: the click does nothing
    release(fake(200, {}));
    await flush();
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
    await userEvent.click(screen.getByRole("button", { name: /^Yes, allow/ }));
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
    for (const bad of ["knowledge:write", "node-ai", "work_item", "/api/", "token", "curl", "Bearer"]) expect(text).not.toContain(bad);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
});
