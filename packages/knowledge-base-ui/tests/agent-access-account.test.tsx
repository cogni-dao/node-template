// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import "@testing-library/jest-dom/vitest";
import type { NodeAiPermissionView } from "@cogni/agent-grants";
import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentAccessSection,
  ApprovalFragmentScrub,
  splitApprovalFragment,
  useApprovalFragment,
} from "../src/index.js";

const TOKEN = "A".repeat(43);
const ENDPOINTS = { roles: "/api/v1/agent-access/mine", preview: "/api/v1/agent-access/mine/preview" };

const row = (o: Partial<NodeAiPermissionView> & Pick<NodeAiPermissionView, "section" | "principalUserId" | "who" | "scope">): NodeAiPermissionView => ({
  outside: false,
  hint: null,
  label: "Read your credit balance",
  description: "See the credit balance of the account it acts for.",
  on: false,
  until: null,
  resource: "account",
  rowId: null,
  ...o,
});

let aiOn = false;
let outsideOn = true;
const list = (): { permissions: NodeAiPermissionView[]; more: number } => ({
  more: 0,
  permissions: [
    row({ section: "node", principalUserId: "u-node-ai", who: "node-ai", scope: "account:read", on: aiOn, rowId: aiOn ? "11111111-1111-4111-8111-111111111111" : null, until: aiOn ? "2026-11-20T00:00:00.000Z" : null }),
    ...(outsideOn
      ? [row({ section: "outside", principalUserId: "ext-2", who: "Reader bot", outside: true, scope: "account:read", on: true, rowId: "22222222-2222-4222-8222-222222222222", until: "2026-11-21T00:00:00.000Z" })]
      : []),
  ],
});
const askRow = row({ section: "pending", principalUserId: "ext-9", who: "Asker bot", outside: true, hint: "GitHub linked", scope: "account:read", viaLink: true });

const fake = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
const json = (status: number, body: unknown) => Promise.resolve(fake(status, body));
const flush = () =>
  act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });

const fetchMock = vi.fn();
beforeEach(() => {
  aiOn = false;
  outsideOn = true;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("AgentAccessSection, account mode (the profile)", () => {
  it("shows a Skeleton while loading, then the table to any signed-in person (no canManage)", async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockReturnValue(new Promise<Response>((r) => { release = r; }));
    const { container } = render(<AgentAccessSection endpoints={ENDPOINTS} mode="account" />);
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    release(fake(200, list())); // no canManage in the body
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Who", "Can do", "Until", "On"]);
  });

  it("lists this node's AI Off with an Until choice (1, 7 or 30 days, default 7), and an outside AI On with its end date", async () => {
    fetchMock.mockImplementation(() => json(200, list()));
    render(<AgentAccessSection endpoints={ENDPOINTS} mode="account" />);
    await screen.findByRole("table");
    const until = screen.getByRole("combobox", { name: /^Until: node-ai: Read your credit balance$/ });
    expect(until).toHaveValue("7");
    expect(within(until).getAllByRole("option").map((o) => o.textContent)).toEqual(["1 day", "7 days", "30 days"]);
    expect(screen.getByRole("switch", { name: /^node-ai: Read your credit balance$/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("switch", { name: /^Reader bot: Read your credit balance$/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/^Until Nov (20|21)$/)).toBeInTheDocument();
    expect(screen.getAllByRole("combobox")).toHaveLength(1); // an On row shows its end, not a choice
  });

  it("turning this node's AI On sends its id and permission with the chosen days; turning it Off sends the row id", async () => {
    const calls: Array<{ method: string; body?: unknown }> = [];
    fetchMock.mockImplementation((_u: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "POST") aiOn = true;
      if (method === "DELETE") aiOn = false;
      return json(200, method === "GET" ? list() : { changed: true });
    });
    render(<AgentAccessSection endpoints={ENDPOINTS} mode="account" />);
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: /^Until: node-ai/ }), "30");
    await userEvent.click(screen.getByRole("switch", { name: /^node-ai: Read your credit balance$/ }));
    await waitFor(() => expect(screen.getByRole("switch", { name: /^node-ai: Read your credit balance$/ })).toHaveAttribute("aria-checked", "true"));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ principalUserId: "u-node-ai", scope: "account:read", days: 30 });
    await userEvent.click(screen.getByRole("switch", { name: /^node-ai: Read your credit balance$/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({ rowId: "11111111-1111-4111-8111-111111111111" });
  });

  it("an AI's link: the token is previewed in a POST body, the ask is shown highlighted, On sends the token with days, and the ask is dropped", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    let decided = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === ENDPOINTS.preview) return json(200, { permission: askRow });
      if (method === "POST") decided = true;
      return json(200, method === "GET" ? { ...list(), permissions: [...list().permissions, ...(decided ? [row({ section: "outside", principalUserId: "ext-9", who: "Asker bot", outside: true, scope: "account:read", on: true, rowId: "33333333-3333-4333-8333-333333333333", until: "2026-11-20T00:00:00.000Z" })] : [])] } : { changed: true });
    });
    const { container } = render(<AgentAccessSection endpoints={ENDPOINTS} mode="account" token={TOKEN} />);
    const ask = await screen.findByRole("switch", { name: /^Asker bot: Read your credit balance$/ });
    const tr = ask.closest("tr") as HTMLElement;
    expect(tr.className).toMatch(/ring-1/); // highlighted
    expect(tr.id).toBe("ai-access-highlight"); // a constant id: no token, id or scope string in the markup
    expect(calls.find((c) => c.url === ENDPOINTS.preview)).toMatchObject({ method: "POST", body: { token: TOKEN } });
    expect(calls.every((c) => !c.url.includes(TOKEN))).toBe(true); // never in a URL
    expect(container.textContent).not.toContain(TOKEN);
    await userEvent.click(ask);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === ENDPOINTS.roles)).toBe(true));
    expect(calls.find((c) => c.method === "POST" && c.url === ENDPOINTS.roles)?.body).toEqual({ token: TOKEN, days: 7 });
    await waitFor(() => expect(screen.getByRole("switch", { name: /^Asker bot: Read your credit balance$/ })).toHaveAttribute("aria-checked", "true"));
    expect(screen.queryByText("Asks waiting")).toBeNull(); // the used-up ask left the block
  });

  it("the x on an ask sends the token with deny, and a link that opens nothing shows one neutral line", async () => {
    const calls: Array<{ method: string; body?: unknown }> = [];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === ENDPOINTS.preview) return json(200, { permission: askRow });
      return json(200, method === "GET" ? list() : { changed: true });
    });
    render(<AgentAccessSection endpoints={ENDPOINTS} mode="account" token={TOKEN} />);
    await userEvent.click(await screen.findByRole("button", { name: /^Dismiss the ask: Asker bot: Read your credit balance$/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({ token: TOKEN, deny: true });
    cleanup();
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string) => (url === ENDPOINTS.preview ? json(404, { error: "not_found" }) : json(200, list())));
    render(<AgentAccessSection endpoints={ENDPOINTS} mode="account" token={TOKEN} />);
    expect(await screen.findByRole("status")).toHaveTextContent("That link is not valid any more. Ask the AI for a new one.");
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("the profile never shows a node row, and the admin table never shows an account row, even if the server sent one", async () => {
    const mixed = {
      more: 0,
      permissions: [
        row({ section: "node", principalUserId: "u-node-ai", who: "node-ai", scope: "account:read", label: "Read your credit balance" }),
        row({ section: "node", principalUserId: "u-node-ai", who: "node-ai", scope: "knowledge:write", label: "Save notes", description: "Save notes into the knowledge base.", resource: "node" }),
      ],
    };
    fetchMock.mockImplementation(() => json(200, mixed));
    render(<AgentAccessSection endpoints={ENDPOINTS} mode="account" />);
    await screen.findByRole("table");
    expect(screen.queryByText("Save notes")).toBeNull();
    expect(screen.getByText("Read your credit balance")).toBeInTheDocument();
    cleanup();
    fetchMock.mockImplementation(() => json(200, { canManage: true, ...mixed }));
    render(<AgentAccessSection endpoints={{ roles: "/api/v1/admin/ai-access" }} />);
    await screen.findByRole("table");
    expect(screen.getByText("Save notes")).toBeInTheDocument();
    expect(screen.queryByText("Read your credit balance")).toBeNull();
  });

  it("a 401 shows nothing; a 503 shows the retry line", async () => {
    fetchMock.mockImplementation(() => json(401, {}));
    const { container } = render(<AgentAccessSection endpoints={ENDPOINTS} mode="account" />);
    await flush();
    expect(container).toBeEmptyDOMElement();
    cleanup();
    fetchMock.mockImplementation(() => json(503, {}));
    render(<AgentAccessSection endpoints={ENDPOINTS} mode="account" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Can't check access right now. Try again.");
  });
});

describe("AgentAccessSection, admin mode and a link", () => {
  it("previews the token and highlights the node ask that is already in the table; sends no token with the click", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const adminView = {
      canManage: true,
      more: 0,
      permissions: [row({ section: "pending", principalUserId: "ext-1", who: "Helper bot", outside: true, scope: "knowledge:contribute", label: "Propose changes", description: "Suggest notes.", resource: "node" })],
    };
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/preview")) return json(200, { permission: adminView.permissions[0] });
      return json(200, adminView);
    });
    render(<AgentAccessSection endpoints={{ roles: "/api/v1/admin/ai-access", preview: "/api/v1/admin/ai-access/preview" }} token={TOKEN} />);
    const sw = await screen.findByRole("switch", { name: /^Helper bot: Propose changes$/ });
    await waitFor(() => expect(sw.closest("tr")?.className).toMatch(/ring-1/));
    await userEvent.click(sw);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/api/v1/admin/ai-access")).toBe(true));
    expect(calls.find((c) => c.method === "POST" && c.url === "/api/v1/admin/ai-access")?.body).toEqual({ principalUserId: "ext-1", scope: "knowledge:contribute" });
  });
});

describe("the one-time link fragment", () => {
  it("splitApprovalFragment takes only our key and keeps every other value in order", () => {
    expect(splitApprovalFragment("#agent-request=T")).toEqual({ token: "T", rest: null });
    expect(splitApprovalFragment("#attestation=jwt&agent-request=T&x=y")).toEqual({ token: "T", rest: "attestation=jwt&x=y" });
    expect(splitApprovalFragment("#attestation=jwt")).toEqual({ token: null, rest: "attestation=jwt" });
    expect(splitApprovalFragment("")).toEqual({ token: null, rest: null });
  });

  it("useApprovalFragment reads the token once and removes it from the address bar and history on /profile, leaving #attestation alone", async () => {
    window.history.replaceState(null, "", `/profile?x=1#attestation=jwt&agent-request=${TOKEN}`);
    const { result } = renderHook(() => useApprovalFragment());
    await waitFor(() => expect(result.current).toBe(TOKEN));
    expect(window.location.hash).toBe("#attestation=jwt");
    expect(window.location.search).toBe("?x=1");
    expect(window.location.href).not.toContain(TOKEN);
  });

  it("useApprovalFragment returns null when there is no fragment, and does not touch an unrelated one", async () => {
    window.history.replaceState(null, "", "/admin/ai-access#attestation=jwt");
    const { result } = renderHook(() => useApprovalFragment());
    await flush();
    expect(result.current).toBeNull();
    expect(window.location.hash).toBe("#attestation=jwt");
  });

  it("ApprovalFragmentScrub removes the token on any other path, and keeps the page's own fragments", async () => {
    window.history.replaceState(null, "", `/dashboard#agent-request=${TOKEN}`);
    render(<ApprovalFragmentScrub />);
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    window.history.replaceState(null, "", `/chat#attestation=jwt&agent-request=${TOKEN}`);
    render(<ApprovalFragmentScrub pathname="/chat" />);
    expect(window.location.hash).toBe("#attestation=jwt");
  });

  it("ApprovalFragmentScrub leaves the token on /profile and /admin/ai-access for the page's hook", () => {
    for (const path of ["/profile", "/admin/ai-access"]) {
      window.history.replaceState(null, "", `${path}#agent-request=${TOKEN}`);
      const { unmount } = render(<ApprovalFragmentScrub />);
      expect(window.location.hash).toBe(`#agent-request=${TOKEN}`);
      unmount();
    }
  });
});
