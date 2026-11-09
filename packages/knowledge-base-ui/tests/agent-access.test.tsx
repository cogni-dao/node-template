// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import "@testing-library/jest-dom/vitest";
import type { NodeAiAccessView } from "@cogni/agent-grants";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentAccessSection, Button } from "../src/index.js";

const ENDPOINTS = { roles: "/api/v1/agent-access/roles" };

let allowed = false;
const view = (): NodeAiAccessView => ({
  canManage: true,
  ai: [
    {
      principal: "node-ai",
      name: "General assistant",
      blurb: "Answers questions and works with this node's notes.",
      jobs: [
        { scope: "knowledge:write", label: "Save notes to this node's knowledge base", risk: "medium", allowed },
      ],
    },
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

describe("AgentAccessSection: an admin", () => {
  it("shows the unavailable state only on a confirmed 503, and retries from the button", async () => {
    fetchMock.mockImplementationOnce(() => json(503, { error: "authz_unavailable" }));
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Can't check access right now. Try again.");
    expect(screen.getByText("This node's AI")).toBeInTheDocument();
    fetchMock.mockImplementationOnce(() => json(200, view()));
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("General assistant")).toBeInTheDocument();
  });

  it("shows an empty state when the node has no assistants", async () => {
    fetchMock.mockImplementation(() => json(200, { canManage: true, ai: [] }));
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    expect(await screen.findByText(/no assistants to manage/i)).toBeInTheDocument();
  });

  it("names the job in every button, allows with one Confirm, removes with no confirm, and reloads after each click", async () => {
    const calls: Array<{ method: string; body?: unknown; headers?: Record<string, string> }> = [];
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers as Record<string, string> });
      if (method === "POST") allowed = true;
      if (method === "DELETE") allowed = false;
      return json(200, method === "GET" ? view() : { changed: true });
    });
    render(<AgentAccessSection endpoints={ENDPOINTS} />);

    const allow = await screen.findByRole("button", { name: /^Allow General assistant to save notes to this node's knowledge base$/ });
    await userEvent.click(allow);
    expect(screen.getByText(/Let General assistant save notes/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0); // asked once, nothing sent yet
    const confirm = screen.getByRole("button", { name: /^Confirm: let General assistant save notes/ });
    expect(confirm).toHaveFocus(); // focus follows the click
    await userEvent.click(confirm);
    const remove = await screen.findByRole("button", { name: /^Remove General assistant: Save notes/ });
    expect(screen.getByText("Allowed")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ principal: "node-ai", scope: "knowledge:write" });

    await userEvent.click(remove); // no confirm step
    expect(await screen.findByRole("button", { name: /^Allow General assistant to save notes/ })).toBeInTheDocument();
    expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({ principal: "node-ai", scope: "knowledge:write" });
    expect(calls.every((c) => !c.headers || !("authorization" in Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [k.toLowerCase(), v]))))).toBe(true);
  });

  it("lets an admin whose first load failed transiently see the block on the next focus", async () => {
    let attempt = 0;
    fetchMock.mockImplementation(() => (++attempt === 1 ? json(500, { error: "boom" }) : json(200, view())));
    const { container } = render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await flush();
    expect(container).toBeEmptyDOMElement(); // a transient failure shows nothing
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(screen.getByText("General assistant")).toBeInTheDocument(); // and recovers
  });

  it("keeps keyboard focus on the row through Allow, Confirm, Cancel and Remove", async () => {
    fetchMock.mockImplementation((_u: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") allowed = true;
      if (method === "DELETE") allowed = false;
      return json(200, method === "GET" ? view() : { changed: true });
    });
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await flush();
    await userEvent.click(screen.getByRole("button", { name: /^Allow General assistant/ }));
    expect(screen.getByRole("button", { name: /^Confirm/ })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: /^Cancel/ }));
    await flush();
    expect(screen.getByRole("button", { name: /^Allow General assistant/ })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: /^Allow General assistant/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Confirm/ }));
    await flush();
    expect(screen.getByRole("button", { name: /^Remove General assistant/ })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: /^Remove General assistant/ }));
    await flush();
    expect(screen.getByRole("button", { name: /^Allow General assistant/ })).toHaveFocus();
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
    await screen.findByRole("button", { name: /^Allow General assistant/ });
    window.dispatchEvent(new Event("focus")); // GET #2: started before the click, answers late with allowed=false
    await userEvent.click(screen.getByRole("button", { name: /^Allow General assistant/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Confirm/ }));
    expect(await screen.findByRole("button", { name: /^Remove General assistant/ })).toBeInTheDocument();
    releaseStale(fake(200, { ...view(), ai: [{ ...view().ai[0], jobs: [{ ...view().ai[0]!.jobs[0]!, allowed: false }] }] }));
    await flush();
    expect(screen.getByRole("button", { name: /^Remove General assistant/ })).toBeInTheDocument(); // not overwritten
  });

  it("keeps the admin's view when a reload after a click fails with a 500, and hides it on a 403", async () => {
    let mode: "ok" | "500" | "403" = "ok";
    fetchMock.mockImplementation((_u: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") !== "GET") return json(200, { changed: true });
      return mode === "ok" ? json(200, view()) : mode === "500" ? json(500, {}) : json(403, {});
    });
    const { container } = render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await userEvent.click(await screen.findByRole("button", { name: /^Allow General assistant/ }));
    mode = "500";
    await userEvent.click(screen.getByRole("button", { name: /^Confirm/ }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(screen.getByText("General assistant")).toBeInTheDocument(); // still there
    mode = "403";
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("disables every button while a click is in flight, so two jobs cannot clobber each other", async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementation((_u: string, init?: RequestInit) =>
      (init?.method ?? "GET") === "GET" ? json(200, view()) : new Promise<Response>((resolve) => { release = resolve; }));
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await userEvent.click(await screen.findByRole("button", { name: /^Allow General assistant/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Confirm/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Allow General assistant/ })).toBeDisabled());
    release(fake(200, {}));
    await flush();
  });

  it("uses no-store fetches with the browser session only", async () => {
    fetchMock.mockImplementation(() => json(200, view()));
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await screen.findByText("General assistant");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("same-origin");
  });

  it("shows a save failure as one alert and keeps the list", async () => {
    fetchMock.mockImplementation((_u: string, init?: RequestInit) =>
      (init?.method ?? "GET") === "GET" ? json(200, view()) : json(500, { error: "x" }));
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await userEvent.click(await screen.findByRole("button", { name: /^Allow General assistant/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Confirm/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save that change. Try again.");
  });

  it("prints no token, id, key, scope string or path in the page text, labels included", async () => {
    allowed = true;
    fetchMock.mockImplementation(() => json(200, view()));
    const { container } = render(<AgentAccessSection endpoints={ENDPOINTS} />);
    await screen.findByText("General assistant");
    const labels = [...container.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")).join(" ");
    const text = `${container.textContent ?? ""} ${labels}`;
    for (const bad of ["knowledge:write", "node-ai", "/api/", "token", "curl", "Bearer"]) expect(text).not.toContain(bad);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it("makes the Allow and Remove buttons at least 40px tall (size lg)", async () => {
    fetchMock.mockImplementation(() => json(200, view()));
    render(<AgentAccessSection endpoints={ENDPOINTS} />);
    expect(await screen.findByRole("button", { name: /^Allow General assistant/ })).toHaveClass("h-10");
    cleanup();
    render(<Button size="lg" variant="destructive">Remove</Button>);
    expect(screen.getByRole("button", { name: "Remove" })).toHaveClass("h-10", "bg-destructive");
  });
});
