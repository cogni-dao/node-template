// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentAccessSection } from "../src/index.js";

const OWNER = { mine: "/api/v1/agent-access/mine", ais: "/api/v1/profile/ai", aisRevoke: "/api/v1/profile/ai/revoke", requests: "/api/v1/agent-access/mine/requests", claims: "/api/v1/profile/ai/claims" };
const ASK = "11111111-1111-4111-8111-111111111111";
const LIVE = "22222222-2222-4222-8222-222222222222";
const CLAIM = "33333333-3333-4333-8333-333333333333";

const fake = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
const flush = () => act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); });

let perms: unknown[] = [];
let agents: unknown[] = [];
let claimState: "open" | "claimed" | "missing" = "missing";
const calls: Array<{ url: string; method: string; body?: unknown }> = [];
const scroll = vi.fn();

const permission = (o: Record<string, unknown>) => ({ principalUserId: "a-1", who: "Helper bot", scope: "knowledge:contribute", label: "Propose changes to the knowledge base", description: "Suggest new or changed notes.", on: false, until: null, ...o });

beforeEach(() => {
  calls.length = 0;
  perms = [permission({ requestId: ASK }), permission({ requestId: LIVE, scope: "knowledge:read", label: "Read the knowledge base", description: "Read this node's notes.", on: true, until: "2026-12-12T00:00:00.000Z" })];
  agents = [{ agentId: "a-1", name: "Helper bot", createdAt: "2026-11-01T00:00:00.000Z", keyState: "active" }];
  claimState = "missing";
  scroll.mockReset();
  Element.prototype.scrollIntoView = scroll;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url === OWNER.mine && method === "GET") return fake(200, { permissions: perms });
    if (url === OWNER.ais && method === "GET") return fake(200, { agents, grantsLeft: 4 });
    if (url === OWNER.ais && method === "POST") return fake(201, { setupLine: "Set yourself up with code cogni_sg_v1_abc", expiresAt: "x", grantsLeft: 3 });
    if (url === `${OWNER.claims}/${CLAIM}` && method === "GET") return claimState === "missing" ? fake(404, { error: "not_found" }) : fake(200, { claimId: CLAIM, agentName: "Loose bot", state: claimState });
    if (url === `${OWNER.claims}/${CLAIM}` && method === "POST") { claimState = "claimed"; return fake(200, { claimed: true }); }
    return fake(200, { changed: true });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("AgentAccessSection with owner endpoints: Your AIs", () => {
  it("shows a Skeleton while loading (never bare text), then asks waiting, the AI with its live row, and Add an AI", async () => {
    let release: (v: Response) => void = () => {};
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<Response>((r) => { release = r; }));
    const { container } = render(<AgentAccessSection endpoints={OWNER} />);
    expect(screen.queryByText("Loading")).toBeNull();
    expect(container.querySelector('[aria-busy="true"] [aria-hidden="true"]')).not.toBeNull(); // the standard Skeleton
    release(fake(200, { permissions: perms }));
    await flush();
    expect(screen.getByText("Asks waiting")).toBeInTheDocument();
    expect(screen.getByText(/asks to: Propose changes to the knowledge base/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Helper bot: Read the knowledge base" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Add an AI" })).toBeEnabled();
    expect(container.textContent ?? "").not.toMatch(/cogni_|api\/v1|knowledge:contribute/); // tokenless: no key, id, scope string or API path
  });

  it("empty: says so plainly and still offers Add an AI; unavailable: says so with Try again", async () => {
    perms = [];
    agents = [];
    render(<AgentAccessSection endpoints={OWNER} />);
    await flush();
    expect(screen.getByText("You have not added an AI yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add an AI" })).toBeInTheDocument();
    cleanup();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));
    render(<AgentAccessSection endpoints={OWNER} />);
    await flush();
    expect(screen.getByText("Try again")).toBeInTheDocument();
  });

  it("Approve and Deny post the decision by the request id; Off turns a live row off; Revoke ends the AI's keys", async () => {
    const user = userEvent.setup();
    render(<AgentAccessSection endpoints={OWNER} />);
    await flush();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await flush();
    expect(calls).toContainEqual({ url: `${OWNER.requests}/${ASK}`, method: "POST", body: { decision: "approve" } });
    await user.click(screen.getByRole("button", { name: "Deny" }));
    await flush();
    expect(calls).toContainEqual({ url: `${OWNER.requests}/${ASK}`, method: "POST", body: { decision: "deny" } });
    await user.click(screen.getByRole("switch", { name: "Helper bot: Read the knowledge base" }));
    await flush();
    expect(calls).toContainEqual({ url: OWNER.mine, method: "DELETE", body: { principalUserId: "a-1", scope: "knowledge:read" } });
    await user.click(screen.getByRole("button", { name: "Revoke Helper bot" }));
    await flush();
    expect(calls).toContainEqual({ url: OWNER.aisRevoke, method: "POST", body: { agentId: "a-1" } });
  });

  it("Add an AI shows the setup line once with a copy control, and Done drops it", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<AgentAccessSection endpoints={OWNER} />);
    await flush();
    await user.click(screen.getByRole("button", { name: "Add an AI" }));
    await flush();
    const field = screen.getByLabelText("Setup line for your AI") as HTMLTextAreaElement;
    expect(field.value).toContain("cogni_sg_v1_abc");
    await user.click(screen.getByRole("button", { name: "Copy setup line" }));
    expect(writeText).toHaveBeenCalledWith(field.value);
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByLabelText("Setup line for your AI")).toBeNull();
  });

  it("?request=<id> scrolls to and highlights that ask; an id this person does not have highlights nothing", async () => {
    const { container } = render(<AgentAccessSection endpoints={OWNER} highlightId={ASK} />);
    await flush();
    const row = container.querySelector(`#ask-${ASK}`);
    expect(row).not.toBeNull();
    expect(row?.className).toContain("ring-1");
    expect(scroll).toHaveBeenCalled();
    expect(container.querySelector(`#ask-${LIVE}`)?.className).not.toContain("ring-1");
    cleanup();
    scroll.mockReset();
    const stray = render(<AgentAccessSection endpoints={OWNER} highlightId="99999999-9999-4999-8999-999999999999" />);
    await flush();
    expect(stray.container.querySelector(".ring-1")).toBeNull();
    expect(scroll).not.toHaveBeenCalled();
  });

  it("?claim=<id> shows a claim row; Claim posts to that claim and the row goes away", async () => {
    const user = userEvent.setup();
    claimState = "open";
    const { container } = render(<AgentAccessSection endpoints={OWNER} highlightId={CLAIM} />);
    await flush();
    expect(container.querySelector(`#claim-${CLAIM}`)).not.toBeNull();
    expect(screen.getByText(/Loose bot/)).toBeInTheDocument();
    expect(scroll).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Claim" }));
    await flush();
    expect(calls).toContainEqual({ url: `${OWNER.claims}/${CLAIM}`, method: "POST" });
    expect(container.querySelector(`#claim-${CLAIM}`)).toBeNull();
  });

  it("a used claim link says so", async () => {
    claimState = "claimed";
    render(<AgentAccessSection endpoints={OWNER} highlightId={CLAIM} />);
    await flush();
    expect(screen.getByText("This link was already used.")).toBeInTheDocument();
    expect(within(document.body).queryByRole("button", { name: "Claim" })).toBeNull();
  });
});

describe("AgentAccessSection with admin endpoints: the approval link highlights its row", () => {
  it("?request=<id> scrolls to and highlights that pending ask", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      fake(200, {
        canManage: true,
        more: 0,
        permissions: [
          { section: "pending", requestId: ASK, principalUserId: "ext-1", who: "Loose bot", outside: true, hint: "No owner", scope: "knowledge:contribute", label: "Propose changes", description: "Suggest notes.", on: false, until: null },
          { section: "pending", requestId: LIVE, principalUserId: "ext-2", who: "Other bot", outside: true, hint: "No owner", scope: "edo:write", label: "Log decisions", description: "Write choices.", on: false, until: null },
        ],
      })
    ));
    const { container } = render(<AgentAccessSection endpoints={{ roles: "/api/v1/admin/ai-access" }} highlightId={ASK} />);
    await flush();
    expect(container.querySelector(`#ask-${ASK}`)?.className).toContain("ring-1");
    expect(container.querySelector(`#ask-${LIVE}`)?.className ?? "").not.toContain("ring-1");
    expect(scroll).toHaveBeenCalled();
  });
});
