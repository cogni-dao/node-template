// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrgAdminSection } from "../src/orgs/org-admin-section.js";
import { OrgSection } from "../src/orgs/org-section.js";
import { OrgsSection } from "../src/orgs/orgs-section.js";
import { ENDPOINTS, type FxOrg, member, newWorld, type OrgsWorld, serve } from "./_fixtures/orgs-server.js";

let world: OrgsWorld;

/** A stand-in for the node's dollars formatter: a visible mark proves the section drew through the injected one. */
const formatMoney = (credits: number): string => `¤${credits}`;

const org = (o: Partial<FxOrg> & Pick<FxOrg, "orgUserId" | "name">): FxOrg => ({
  billingAccountId: `ba-${o.orgUserId}`,
  suspended: false,
  role: "owner",
  members: [],
  links: [],
  ...o,
});

const addOrg = (o: FxOrg, balance = 0, ledger: OrgsWorld["balances"][string]["ledger"] = []) => {
  world.orgs.push(o);
  world.balances[o.billingAccountId] = { balance, ledger };
};

const writes = () => world.calls.filter((c) => c.method !== "GET");

beforeEach(() => {
  world = newWorld();
  vi.stubGlobal("fetch", vi.fn(serve(world)));
  vi.useRealTimers();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OrgsSection (/orgs)", () => {
  it("each org row is name, my role badge and its balance, and the whole row opens the org", async () => {
    // Defect: a row with no role badge, a balance that is wrong, or a link that covers only part of the row.
    addOrg(org({ orgUserId: "o1", name: "Acme", role: "owner" }), 12345);
    addOrg(org({ orgUserId: "o2", name: "Beta", role: "admin" }), 7);
    render(<OrgsSection endpoints={ENDPOINTS} formatMoney={formatMoney} />);
    const row = (await screen.findByRole("link", { name: "Acme" })).closest("li") as HTMLElement;
    expect(within(row).getByText("Owner")).toBeInTheDocument();
    await waitFor(() => expect(within(row).getByText("¤12345")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Acme" })).toHaveAttribute("href", "/orgs/o1");
    const beta = screen.getByRole("link", { name: "Beta" }).closest("li") as HTMLElement;
    expect(within(beta).getByText("Admin")).toBeInTheDocument();
    await waitFor(() => expect(within(beta).getByText("¤7")).toBeInTheDocument());
  });

  it("the balance comes with the list: no per-org credits read, and the injected formatter draws it", async () => {
    // Defect: one extra credits request per org on every visit (N+1), or credits drawn raw instead of through the node's dollars formatter.
    addOrg(org({ orgUserId: "o1", name: "Acme" }), 5);
    addOrg(org({ orgUserId: "o2", name: "Beta" }), 6);
    render(<OrgsSection endpoints={ENDPOINTS} formatMoney={formatMoney} />);
    const row = (await screen.findByRole("link", { name: "Acme" })).closest("li") as HTMLElement;
    expect(within(row).getByLabelText("Balance")).toHaveTextContent("¤5");
    expect(world.calls.filter((c) => c.path.includes("/credits"))).toEqual([]);
  });

  it("Create org sends the trimmed name, clears the box and shows the new org", async () => {
    // Defect: the name sent with its spaces, the box left filled after a success, or a list that does not refresh.
    const user = userEvent.setup();
    render(<OrgsSection endpoints={ENDPOINTS} formatMoney={formatMoney} />);
    await user.type(await screen.findByLabelText("Org name"), "  toks5  ");
    await user.click(screen.getByRole("button", { name: "Create org" }));
    expect(await screen.findByRole("link", { name: "toks5" })).toBeInTheDocument();
    expect(writes()).toEqual([{ method: "POST", path: "/api/v1/orgs", body: { name: "toks5" } }]);
    expect(screen.getByLabelText("Org name")).toHaveValue("");
  });

  it("a second create refused with org_role_limit shows its plain message and keeps what was typed", async () => {
    // Defect: the raw code or a blank failure shown, or the typed name thrown away so the person must retype it.
    const user = userEvent.setup();
    addOrg(org({ orgUserId: "o1", name: "Acme" }));
    render(<OrgsSection endpoints={ENDPOINTS} formatMoney={formatMoney} />);
    world.refuse = { status: 409, error: "org_role_limit" };
    await user.type(await screen.findByLabelText("Org name"), "Second");
    await user.click(screen.getByRole("button", { name: "Create org" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You already have a role in an org. Only one is allowed for now.");
    expect(screen.queryByText(/org_role_limit/)).toBeNull();
    expect(screen.getByLabelText("Org name")).toHaveValue("Second");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("Create org stays off until there is a name", async () => {
    // Defect: an empty create sent to the server.
    render(<OrgsSection endpoints={ENDPOINTS} formatMoney={formatMoney} />);
    expect(await screen.findByRole("button", { name: "Create org" })).toBeDisabled();
  });

  it("an invite row is org name, role badge and Accept; Accept joins and the org moves to the list", async () => {
    // Defect: Accept that posts the wrong invite, or leaves the invite on the page after the grant is written.
    const user = userEvent.setup();
    world.invites.push({ id: "inv-9", orgUserId: "o9", orgName: "Zed", role: "admin", expiresAt: "2026-11-27T00:00:00.000Z" });
    render(<OrgsSection endpoints={ENDPOINTS} formatMoney={formatMoney} />);
    const row = (await screen.findByText("Zed")).closest("li") as HTMLElement;
    expect(within(row).getByText("Admin")).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "Accept Zed" }));
    expect(await screen.findByRole("link", { name: "Zed" })).toBeInTheDocument();
    expect(writes()).toEqual([{ method: "POST", path: "/api/v1/orgs/invites/inv-9/accept" }]);
    expect(screen.queryByRole("button", { name: /Accept/ })).toBeNull();
  });

  it("a signed-out visitor sees nothing", async () => {
    // Defect: a signed-out person shown an empty Create org form that can never work.
    world.statusFor["/api/v1/orgs"] = 401;
    const { container } = render(<OrgsSection endpoints={ENDPOINTS} formatMoney={formatMoney} />);
    await waitFor(() => expect(world.calls.length).toBeGreaterThan(0));
    await waitFor(() => expect(container.querySelector(".animate-pulse")).toBeNull());
    expect(container).toBeEmptyDOMElement();
  });
});

const owner = () =>
  org({
    orgUserId: "o1",
    name: "Acme",
    role: "owner",
    members: [member("me", "owner", "Me"), member("u-ana", "admin", "Ana"), member("u-bo", "owner", "Bo")],
    links: [{ id: "l1", issuer: "https://toks5.cognidao.org", services: ["node-ai"], createdAt: "2026-11-02T00:00:00.000Z" }],
  });

const menu = async (user: ReturnType<typeof userEvent.setup>, name: string) => user.click(await screen.findByRole("button", { name }));

describe("OrgSection (/orgs/[id])", () => {
  it("shows the balance and what was spent this month, counting only this month's charges", async () => {
    // Defect: spent-this-month that counts top-ups, last month's charges or an unknown as zero.
    const now = new Date();
    const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 1)).toISOString();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString();
    addOrg(owner(), 9000, [
      { amount: -300, reason: "charge_receipt", createdAt: thisMonth },
      { amount: -200, reason: "charge_receipt", createdAt: thisMonth },
      { amount: 5000, reason: "widget_payment", createdAt: thisMonth },
      { amount: -900, reason: "charge_receipt", createdAt: lastMonth },
    ]);
    render(<OrgSection endpoints={ENDPOINTS} orgId="o1" formatMoney={formatMoney} />);
    const balance = (await screen.findByText("Balance")).closest("div") as HTMLElement;
    await waitFor(() => expect(within(balance).getByText("¤9000")).toBeInTheDocument());
    expect((screen.getByText("Spent this month").closest("div") as HTMLElement)).toHaveTextContent("¤500");
  });

  it("a ledger read that fails shows a dash for spend, never 0, and keeps the balance", async () => {
    // Defect: a failed ledger read drawn as "spent 0", or one failed read hiding the balance the org read already carried.
    addOrg(owner(), 777);
    world.statusFor["/api/v1/accounts"] = 503;
    render(<OrgSection endpoints={ENDPOINTS} orgId="o1" formatMoney={formatMoney} />);
    const spent = (await screen.findByText("Spent this month")).closest("div") as HTMLElement;
    await waitFor(() => expect(spent).toHaveTextContent("—"));
    expect(screen.getByText("Balance").closest("div")).toHaveTextContent("¤777");
  });

  it("a person with no name is shown by wallet, in short form", async () => {
    // Defect: an unnamed person shown as an opaque id when the wallet is what the owner invited by.
    addOrg(org({ orgUserId: "o1", name: "Acme", members: [member("me", "owner", "Me"), member("u-9", "admin", null, "0xabc123def4567890abc123def4567890abc12345")] }));
    render(<OrgSection endpoints={ENDPOINTS} orgId="o1" formatMoney={formatMoney} />);
    expect(await screen.findByText("0xabc1…2345")).toBeInTheDocument();
  });

  it("an owner's row menu changes roles and removes with the right person and role", async () => {
    // Defect: a role change or removal sent for the wrong person, or with the wrong role.
    const user = userEvent.setup();
    addOrg(owner());
    render(<OrgSection endpoints={ENDPOINTS} orgId="o1" formatMoney={formatMoney} />);
    await menu(user, "Actions for Ana");
    await user.click(await screen.findByRole("menuitem", { name: "Make owner" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: "PATCH", path: "/api/v1/orgs/o1/members/u-ana", body: { role: "owner" } });

    await menu(user, "Actions for Bo");
    await user.click(await screen.findByRole("menuitem", { name: "Make admin" }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toEqual({ method: "PATCH", path: "/api/v1/orgs/o1/members/u-bo", body: { role: "admin" } });

    await menu(user, "Actions for Bo");
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
    await waitFor(() => expect(writes()).toHaveLength(3));
    expect(writes()[2]).toEqual({ method: "DELETE", path: "/api/v1/orgs/o1/members/u-bo" });
    await waitFor(() => expect(screen.queryByText("Bo")).toBeNull());
  });

  it("the menu of an admin row offers Make owner and Remove, an owner row Make admin and Remove", async () => {
    // Defect: a menu that offers the role the person already has, so one click changes nothing.
    const user = userEvent.setup();
    addOrg(owner());
    render(<OrgSection endpoints={ENDPOINTS} orgId="o1" formatMoney={formatMoney} />);
    await menu(user, "Actions for Ana");
    expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent)).toEqual(["Make owner", "Remove"]);
    await user.keyboard("{Escape}");
    await menu(user, "Actions for Bo");
    expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent)).toEqual(["Make admin", "Remove"]);
  });

  it("removing the last owner shows its plain refusal and keeps the person listed", async () => {
    // Defect: the page drops a person the server refused to remove, or shows the raw code.
    const user = userEvent.setup();
    addOrg(org({ orgUserId: "o1", name: "Acme", members: [member("me", "owner", "Me")] }));
    render(<OrgSection endpoints={ENDPOINTS} orgId="o1" formatMoney={formatMoney} />);
    await menu(user, "Actions for Me");
    await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("An org keeps at least one owner.");
    expect(screen.getByText("Me")).toBeInTheDocument();
  });

  it("an admin has no actions on an owner row, no Make owner, no owner choice on Invite and no link controls", async () => {
    // Defect: controls an admin can never use, which only produce refusals (RIGHTS: only owners touch owners and links).
    const user = userEvent.setup();
    addOrg({ ...owner(), role: "admin" });
    render(<OrgSection endpoints={ENDPOINTS} orgId="o1" formatMoney={formatMoney} />);
    await screen.findByText("Bo");
    expect(screen.queryByRole("button", { name: "Actions for Bo" })).toBeNull();
    await menu(user, "Actions for Ana");
    expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent)).toEqual(["Remove"]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Link a node" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Actions for https/ })).toBeNull();
    await user.type(screen.getByLabelText("Wallet"), "0x1111111111111111111111111111111111111111");
    await user.click(screen.getByRole("button", { name: "Invite" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]?.body).toEqual({ wallet: "0x1111111111111111111111111111111111111111", role: "admin" });
  });

  it("Invite sends the wallet and the chosen role, then clears the wallet", async () => {
    // Defect: the role choice ignored (everyone invited as admin) or a wallet left behind after the invite.
    const user = userEvent.setup();
    addOrg(owner());
    render(<OrgSection endpoints={ENDPOINTS} orgId="o1" formatMoney={formatMoney} />);
    await user.type(await screen.findByLabelText("Wallet"), " 0x2222222222222222222222222222222222222222 ");
    await user.selectOptions(screen.getByLabelText("Role"), "owner");
    await user.click(screen.getByRole("button", { name: "Invite" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: "POST", path: "/api/v1/orgs/o1/invites", body: { wallet: "0x2222222222222222222222222222222222222222", role: "owner" } });
    await waitFor(() => expect(screen.getByLabelText("Wallet")).toHaveValue(""));
  });

  it("a bad wallet shows its plain refusal and keeps the wallet for editing", async () => {
    // Defect: a refused invite that silently clears the box.
    const user = userEvent.setup();
    addOrg(owner());
    render(<OrgSection endpoints={ENDPOINTS} orgId="o1" formatMoney={formatMoney} />);
    await user.type(await screen.findByLabelText("Wallet"), "not-a-wallet");
    await user.click(screen.getByRole("button", { name: "Invite" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a wallet address.");
    expect(screen.getByLabelText("Wallet")).toHaveValue("not-a-wallet");
  });

  it("Link a node turns an origin into a code to copy, and typing a new origin removes the old code", async () => {
    // Defect: a code shown that is never copyable, one that stays on screen for the wrong node, or an origin sent with stray spaces.
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    addOrg(owner());
    render(<OrgSection endpoints={ENDPOINTS} orgId="o1" formatMoney={formatMoney} />);
    await user.type(await screen.findByLabelText("Node origin"), " https://toks5.cognidao.org ");
    await user.click(screen.getByRole("button", { name: "Link a node" }));
    const code = await screen.findByLabelText("Link code");
    expect(code).toHaveValue("LNK-abc123");
    expect(writes()).toEqual([{ method: "POST", path: "/api/v1/orgs/o1/link-codes", body: { origin: "https://toks5.cognidao.org" } }]);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("LNK-abc123");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Node origin"), "x");
    expect(screen.queryByLabelText("Link code")).toBeNull();
  });

  it("an origin that is not https shows its plain refusal and no code", async () => {
    // Defect: a code shown for an origin the server refused.
    const user = userEvent.setup();
    addOrg(owner());
    render(<OrgSection endpoints={ENDPOINTS} orgId="o1" formatMoney={formatMoney} />);
    await user.type(await screen.findByLabelText("Node origin"), "http://insecure.test");
    await user.click(screen.getByRole("button", { name: "Link a node" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter an https address");
    expect(screen.queryByLabelText("Link code")).toBeNull();
  });

  it("a linked node is origin and a status badge; Unlink in its menu closes that link only", async () => {
    // Defect: Unlink that closes a different link, or leaves the node listed after it closed.
    const user = userEvent.setup();
    addOrg(owner());
    render(<OrgSection endpoints={ENDPOINTS} orgId="o1" formatMoney={formatMoney} />);
    const row = (await screen.findByText("https://toks5.cognidao.org")).closest("li") as HTMLElement;
    expect(within(row).getByText("Linked")).toBeInTheDocument();
    await menu(user, "Actions for https://toks5.cognidao.org");
    await user.click(await screen.findByRole("menuitem", { name: "Unlink" }));
    await waitFor(() => expect(screen.queryByText("https://toks5.cognidao.org")).toBeNull());
    expect(writes()).toEqual([{ method: "DELETE", path: "/api/v1/orgs/o1/links/l1" }]);
  });

  it("follows every page of people, so a long org is never cut at page one", async () => {
    // Defect: only the first page of people drawn, hiding an owner or an admin.
    world.memberPage = 2;
    addOrg(org({ orgUserId: "o1", name: "Acme", members: [member("me", "owner", "Me"), member("a", "admin", "Ana"), member("b", "admin", "Bea"), member("c", "admin", "Cy"), member("d", "admin", "Di")] }));
    render(<OrgSection endpoints={ENDPOINTS} orgId="o1" formatMoney={formatMoney} />);
    expect(await screen.findByText("Di")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Actions for / })).toHaveLength(5);
  });

  it("a person who is not in the org reads one neutral line, the same as an org that does not exist", async () => {
    // Defect: a removed admin told that the org exists, or shown a broken page.
    world.statusFor["/api/v1/orgs/o1"] = 404;
    render(<OrgSection endpoints={ENDPOINTS} orgId="o1" formatMoney={formatMoney} />);
    expect(await screen.findByRole("status")).toHaveTextContent("That is not available.");
    expect(screen.queryByLabelText("Wallet")).toBeNull();
  });

  it("a suspended org says so beside its name", async () => {
    // Defect: an owner left guessing why every run is refused.
    addOrg({ ...owner(), suspended: true });
    render(<OrgSection endpoints={ENDPOINTS} orgId="o1" formatMoney={formatMoney} />);
    expect(await screen.findByText("Suspended")).toBeInTheDocument();
  });
});

describe("OrgAdminSection (/admin)", () => {
  beforeEach(() => {
    world.allOrgs = [
      { orgUserId: "o1", name: "Acme", suspended: false },
      { orgUserId: "o2", name: "Beta", suspended: true },
    ];
  });

  it("lists each org with a status badge; only an active org has Suspend, and there is no Resume", async () => {
    // Defect: a Resume control (suspend is final in P1) or a Suspend on an org that is already suspended.
    render(<OrgAdminSection endpoints={ENDPOINTS} />);
    const acme = (await screen.findByText("Acme")).closest("li") as HTMLElement;
    expect(within(acme).getByText("Active")).toBeInTheDocument();
    expect(within(acme).getByRole("button", { name: "Suspend Acme" })).toBeInTheDocument();
    const beta = screen.getByText("Beta").closest("li") as HTMLElement;
    expect(within(beta).getByText("Suspended")).toBeInTheDocument();
    expect(within(beta).queryByRole("button")).toBeNull();
    expect(screen.queryByText(/resume/i)).toBeNull();
  });

  it("Suspend asks once more, then sends suspended: true for that org only", async () => {
    // Defect: a one-click irreversible action, or a suspend sent for the wrong org or as false.
    const user = userEvent.setup();
    render(<OrgAdminSection endpoints={ENDPOINTS} />);
    await user.click(await screen.findByRole("button", { name: "Suspend Acme" }));
    expect(writes()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Confirm suspend Acme" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: "POST", path: "/api/v1/orgs/o1/suspension", body: { suspended: true } });
    const acme = (await screen.findByText("Acme")).closest("li") as HTMLElement;
    await waitFor(() => expect(within(acme).getByText("Suspended")).toBeInTheDocument());
    expect(within(acme).queryByRole("button")).toBeNull();
  });

  it("a person who is not the node admin sees nothing", async () => {
    // Defect: a non-admin shown the org list or a Suspend button that can only fail.
    world.statusFor["/api/v1/admin/orgs"] = 403;
    const { container } = render(<OrgAdminSection endpoints={ENDPOINTS} />);
    await waitFor(() => expect(world.calls.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });
});
