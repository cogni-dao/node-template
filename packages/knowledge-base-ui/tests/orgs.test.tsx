// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminOrgAccounts, BillToSelect, clearOrgsCache, OrgAccountPage, YourOrgs } from "../src/orgs.js";

const fake = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
const flush = () =>
  act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });

const fetchMock = vi.fn();
beforeEach(() => {
  clearOrgsCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const org = { orgUserId: "o1", billingAccountId: "acct-1", name: "toks5.example.com", role: "admin", balance: 1200, status: "connected" };

describe("the org surfaces stay out of the way", () => {
  it("shows nothing in the account menu and nothing in the composer for a person with no org (no empty heading, no Bill to)", async () => {
    fetchMock.mockResolvedValue(fake(200, { orgs: [] }));
    const { container } = render(
      <>
        <YourOrgs endpoint="/api/v1/orgs" href={() => "/orgs/x"} />
        <BillToSelect endpoint="/api/v1/orgs" value={null} onChange={() => undefined} />
      </>
    );
    await flush();
    expect(container).toBeEmptyDOMElement();
  });

  it("lists each org as name, role badge and balance, and a suspended org is marked and cannot be picked as Bill to", async () => {
    fetchMock.mockResolvedValue(fake(200, { orgs: [org, { ...org, orgUserId: "o2", billingAccountId: "acct-2", name: "frozen.example.com", role: "spend", status: "suspended", balance: 0 }] }));
    const onChange = vi.fn();
    render(
      <>
        <YourOrgs endpoint="/api/v1/orgs" href={(o) => `/orgs/${o.orgUserId}`} formatBalance={(n) => `$${n / 100}`} />
        <BillToSelect endpoint="/api/v1/orgs" value={null} onChange={onChange} />
      </>
    );
    await flush();
    expect(screen.getByRole("menuitem", { name: /toks5\.example\.com/ })).toHaveAttribute("href", "/orgs/o1");
    expect(screen.getByText("$12")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "frozen.example.com (suspended)" })).toBeDisabled();
    await userEvent.selectOptions(screen.getByRole("combobox"), "acct-1");
    expect(onChange).toHaveBeenCalledWith("acct-1", expect.objectContaining({ billingAccountId: "acct-1", balance: 1200 }));
  });
});

describe("the org account page", () => {
  const view = (over: Record<string, unknown> = {}) => ({
    org: {
      orgUserId: "o1",
      name: "toks5.example.com",
      role: "admin",
      status: "connected",
      suspendReason: null,
      balance: 1200,
      billingAccountId: "acct-1",
      canManage: true,
      adminLapsed: false,
      people: [
        { who: "0x00000000000000000000000000000000000000a1", kind: "person", role: "admin", held: false, removable: false },
        { who: "0x00000000000000000000000000000000000000a2", kind: "person", role: "spend", held: true, removable: true },
      ],
      history: [{ act: "org.connected", actor: "toks5.example.com", reason: null, at: "2026-11-26T00:00:00.000Z" }],
      peopleNext: null,
      historyNext: null,
      ...over,
    },
  });

  it("offers Remove only on a spend grant, never on an admin (admins come from the org's statement)", async () => {
    fetchMock.mockResolvedValue(fake(200, view()));
    render(<OrgAccountPage orgEndpoint="/api/v1/orgs/o1" spendEndpoint="/api/v1/orgs/o1/spend" fundHref={(id) => `/credits?billingAccountId=${id}`} />);
    await flush();
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(1);
    expect(screen.getByText("waiting")).toBeInTheDocument();
  });

  it("grants spend with one POST of the wallet and reads the page again", async () => {
    fetchMock.mockResolvedValueOnce(fake(200, view())).mockResolvedValueOnce(fake(200, { changed: true, held: true })).mockResolvedValueOnce(fake(200, view()));
    render(<OrgAccountPage orgEndpoint="/api/v1/orgs/o1" spendEndpoint="/api/v1/orgs/o1/spend" fundHref={(id) => `/credits?billingAccountId=${id}`} />);
    await flush();
    await userEvent.type(screen.getByLabelText("Wallet"), "0x00000000000000000000000000000000000000b1");
    await userEvent.click(screen.getByRole("button", { name: "Grant spend" }));
    await flush();
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/orgs/o1/spend", expect.objectContaining({ method: "POST", body: JSON.stringify({ wallet: "0x00000000000000000000000000000000000000b1" }) }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("shows a spender only the summary: no Fund and no billing account id, never the people or the history", async () => {
    fetchMock.mockResolvedValue(fake(200, view({ role: "spend", billingAccountId: undefined, canManage: false, people: [], history: [] })));
    const { container } = render(<OrgAccountPage orgEndpoint="/api/v1/orgs/o1" spendEndpoint="/api/v1/orgs/o1/spend" fundHref={(id) => `/credits?billingAccountId=${id}`} />);
    await flush();
    expect(screen.queryByRole("link", { name: "Fund" })).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain("acct-1");
    expect(screen.queryByRole("button", { name: "Grant spend" })).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows an admin Fund, linked with the org's billing account id, and nothing when the node passes no fundHref", async () => {
    fetchMock.mockResolvedValue(fake(200, view()));
    const { unmount } = render(<OrgAccountPage orgEndpoint="/api/v1/orgs/o1" spendEndpoint="/api/v1/orgs/o1/spend" fundHref={(id) => `/credits?billingAccountId=${id}`} />);
    await flush();
    expect(screen.getByRole("link", { name: "Fund" })).toHaveAttribute("href", "/credits?billingAccountId=acct-1");
    unmount();
    clearOrgsCache();
    render(<OrgAccountPage orgEndpoint="/api/v1/orgs/o1" spendEndpoint="/api/v1/orgs/o1/spend" />);
    await flush();
    expect(screen.queryByRole("link", { name: "Fund" })).not.toBeInTheDocument();
  });
});

describe("/admin org accounts", () => {
  it("will not suspend without a reason and sends the reason with the suspension", async () => {
    fetchMock
      .mockResolvedValueOnce(fake(200, { orgs: [{ orgUserId: "o1", name: "toks5.example.com", status: "connected", reason: null }], next: null }))
      .mockResolvedValueOnce(fake(200, { orgUserId: "o1", status: "suspended" }));
    render(<AdminOrgAccounts endpoint="/api/v1/admin/orgs" suspensionEndpoint={(id) => `/api/v1/admin/orgs/${id}/suspension`} />);
    await flush();
    await userEvent.click(screen.getByRole("button", { name: "Suspend" }));
    const confirm = screen.getAllByRole("button", { name: "Suspend" })[0] as HTMLElement;
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Reason"), "chargeback");
    await userEvent.click(confirm);
    await flush();
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/admin/orgs/o1/suspension", expect.objectContaining({ method: "POST", body: JSON.stringify({ suspend: true, reason: "chargeback" }) }));
    expect(screen.getByText("suspended")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
  });
});

describe("/admin org accounts: paging", () => {
  it("shows the first page, appends the next on More and drops More on the last page, so no account past the first page is hidden", async () => {
    fetchMock
      .mockResolvedValueOnce(fake(200, { orgs: [{ orgUserId: "o1", name: "a.example.com", status: "connected", reason: null }], next: "https://a.example.com" }))
      .mockResolvedValueOnce(fake(200, { orgs: [{ orgUserId: "o2", name: "b.example.com", status: "connected", reason: null }], next: null }));
    render(<AdminOrgAccounts endpoint="/api/v1/admin/orgs" suspensionEndpoint={(id) => `/api/v1/admin/orgs/${id}/suspension`} />);
    await flush();
    expect(screen.queryByText("b.example.com")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await flush();
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/admin/orgs?after=https%3A%2F%2Fa.example.com", expect.anything());
    expect(screen.getByText("a.example.com")).toBeInTheDocument();
    expect(screen.getByText("b.example.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
  });
});

describe("/admin org accounts: restore", () => {
  it("shows the status the SERVER answered after Restore, so an org that is still disconnected is not shown as connected", async () => {
    fetchMock
      .mockResolvedValueOnce(fake(200, { orgs: [{ orgUserId: "o1", name: "toks5.example.com", status: "suspended", reason: "chargeback" }], next: null }))
      .mockResolvedValueOnce(fake(200, { status: "disconnected" }));
    render(<AdminOrgAccounts endpoint="/api/v1/admin/orgs" suspensionEndpoint={(id) => `/api/v1/admin/orgs/${id}/suspension`} />);
    await flush();
    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    await userEvent.type(screen.getByLabelText("Reason"), "resolved");
    await userEvent.click(screen.getAllByRole("button", { name: "Restore" })[0] as HTMLElement);
    await flush();
    expect(screen.getByText("disconnected")).toBeInTheDocument();
    expect(screen.queryByText("connected")).not.toBeInTheDocument();
  });
});

describe("Bill to when the orgs cannot be read", () => {
  it("keeps the select, with the chosen org and an error, while an org is chosen, and never resets the payer by itself", async () => {
    fetchMock.mockResolvedValue(fake(500, {}));
    const onChange = vi.fn();
    render(<BillToSelect endpoint="/api/v1/orgs" value="acct-1" onChange={onChange} />);
    await flush();
    expect(screen.getByRole("combobox")).toHaveValue("acct-1");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.selectOptions(screen.getByRole("combobox"), "");
    expect(onChange).toHaveBeenCalledWith(null, null);
  });

  it("shows nothing when the read fails and the person bills their own account", async () => {
    fetchMock.mockResolvedValue(fake(500, {}));
    const { container } = render(<BillToSelect endpoint="/api/v1/orgs" value={null} onChange={() => undefined} />);
    await flush();
    expect(container).toBeEmptyDOMElement();
  });
});

describe("failure states", () => {
  it("shows an error, not a blank page, when the admin list cannot load", async () => {
    fetchMock.mockResolvedValue(fake(500, {}));
    render(<AdminOrgAccounts endpoint="/api/v1/admin/orgs" suspensionEndpoint={(id) => `/api/v1/admin/orgs/${id}/suspension`} />);
    await flush();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("renders each org as a menu item of the host's own item component, not a bare link", async () => {
    fetchMock.mockResolvedValue(fake(200, { orgs: [org] }));
    render(
      <YourOrgs
        endpoint="/api/v1/orgs"
        href={(o) => `/orgs/${o.orgUserId}`}
        LinkComponent={({ href, className, children }) => (
          <a role="menuitem" href={href} className={className}>
            {children}
          </a>
        )}
      />
    );
    await flush();
    expect(screen.getByRole("menuitem", { name: /toks5\.example\.com/ })).toHaveAttribute("href", "/orgs/o1");
  });
});

describe("my orgs is one shared read", () => {
  it("the account menu and the composer make ONE request between them, not one per mount", async () => {
    fetchMock.mockResolvedValue(fake(200, { orgs: [org], more: false }));
    render(
      <>
        <YourOrgs endpoint="/api/v1/orgs" href={(o) => `/orgs/${o.orgUserId}`} />
        <BillToSelect endpoint="/api/v1/orgs" value={null} onChange={() => undefined} />
      </>
    );
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("pages the list by origin: More asks with the cursor and appends the next orgs, so an org past the first hundred is reachable (no sentence saying it is hidden)", async () => {
    const second = { ...org, orgUserId: "o9", billingAccountId: "acct-9", name: "zzz.example.com" };
    fetchMock
      .mockResolvedValueOnce(fake(200, { orgs: [org], next: "https://toks5.example.com" }))
      .mockResolvedValueOnce(fake(200, { orgs: [second], next: null }));
    render(<YourOrgs endpoint="/api/v1/orgs" href={(o) => `/orgs/${o.orgUserId}`} />);
    await flush();
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await flush();
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/orgs?after=https%3A%2F%2Ftoks5.example.com", expect.anything());
    expect(screen.getByRole("menuitem", { name: /zzz\.example\.com/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
    expect(screen.queryByText(/not shown/i)).not.toBeInTheDocument();
  });
});

describe("the org page never truncates its audit trail", () => {
  const first = { who: "0x00000000000000000000000000000000000000a1", kind: "person", role: "admin", held: false, removable: false };
  const view = (over: Record<string, unknown>) => ({
    org: { orgUserId: "o1", name: "toks5.example.com", role: "admin", status: "connected", suspendReason: null, balance: 1, canManage: true, adminLapsed: false, people: [first], peopleNext: null, history: [{ act: "org.connected", actor: "a", reason: null, at: "2026-11-26T00:00:00.000Z" }], historyNext: null, ...over },
  });

  it("offers More on the history, asks with the cursor, and appends the older events (never a sentence saying history is hidden)", async () => {
    fetchMock
      .mockResolvedValueOnce(fake(200, view({ historyNext: "2026-11-26T00:00:00.000Z|abc" })))
      .mockResolvedValueOnce(fake(200, view({ people: [], history: [{ act: "org.suspended", actor: "b", reason: "older reason", at: "2026-11-25T00:00:00.000Z" }], historyNext: null })));
    render(<OrgAccountPage orgEndpoint="/api/v1/orgs/o1" spendEndpoint="/api/v1/orgs/o1/spend" />);
    await flush();
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await flush();
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/orgs/o1?historyBefore=2026-11-26T00%3A00%3A00.000Z%7Cabc", expect.anything());
    expect(screen.getByText(/older reason/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More" })).not.toBeInTheDocument();
    expect(screen.queryByText(/not shown/i)).not.toBeInTheDocument();
  });

  it("pages the people the same way, with the offset cursor", async () => {
    fetchMock
      .mockResolvedValueOnce(fake(200, view({ peopleNext: "2026-11-26 00:00:00.5+00|abc" })))
      .mockResolvedValueOnce(fake(200, view({ people: [{ who: "0x00000000000000000000000000000000000000b9", kind: "person", role: "spend", held: false, removable: true }], history: [], peopleNext: null })));
    render(<OrgAccountPage orgEndpoint="/api/v1/orgs/o1" spendEndpoint="/api/v1/orgs/o1/spend" />);
    await flush();
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await flush();
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/orgs/o1?peopleAfter=2026-11-26%2000%3A00%3A00.5%2B00%7Cabc", expect.anything());
    expect(screen.getByText("0x0000…00b9")).toBeInTheDocument();
  });
});
