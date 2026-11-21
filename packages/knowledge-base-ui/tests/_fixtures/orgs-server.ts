// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * A fake of the org routes the sections call (`/api/v1/orgs/**`, `/api/v1/accounts/{id}/credits`, `/api/v1/admin/orgs`), holding one small world in memory.
 * It answers the way the routes in `app/src/app/api/v1/orgs` do (`{ error: code }` with the route's status), so a section is driven end to end without a network.
 */

export type Role = "owner" | "admin";

export interface FxMember {
  userId: string;
  name: string | null;
  wallet: string | null;
  role: Role;
  since: string;
}
export interface FxLink {
  id: string;
  issuer: string;
  services: string[];
  createdAt: string;
}
export interface FxOrg {
  orgUserId: string;
  name: string;
  billingAccountId: string;
  suspended: boolean;
  role: Role;
  members: FxMember[];
  links: FxLink[];
}
export interface FxLedger {
  amount: number;
  reason: string;
  createdAt: string;
}

export interface Call {
  method: string;
  path: string;
  body?: unknown;
}

export interface OrgsWorld {
  orgs: FxOrg[];
  invites: Array<{ id: string; orgUserId: string; orgName: string; role: Role; expiresAt: string }>;
  balances: Record<string, { balance: number; ledger: FxLedger[] }>;
  /** Every org on the node, for the admin list. */
  allOrgs: Array<{ orgUserId: string; name: string; suspended: boolean }>;
  /** When set, the next write answers this refusal once. */
  refuse: { status: number; error: string } | null;
  /** Statuses by path prefix that replace the normal answer (e.g. `{ "/api/v1/orgs/o1": 404 }`). */
  statusFor: Record<string, number>;
  /** Page size for the members list, to prove the sections follow cursors. */
  memberPage: number;
  calls: Call[];
}

export const ENDPOINTS = { orgs: "/api/v1/orgs", accounts: "/api/v1/accounts", adminOrgs: "/api/v1/admin/orgs" } as const;

export const member = (userId: string, role: Role, name: string | null = null, wallet: string | null = null): FxMember => ({ userId, name, wallet, role, since: "2026-11-01T00:00:00.000Z" });

export function newWorld(): OrgsWorld {
  return { orgs: [], invites: [], balances: {}, allOrgs: [], refuse: null, statusFor: {}, memberPage: 100, calls: [] };
}

const reply = (status: number, body: unknown) => Promise.resolve({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Promise<Response>;

/** The `fetch` to stub: `vi.stubGlobal("fetch", serve(world))`. */
export function serve(w: OrgsWorld) {
  return (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input, "http://node.test");
    const method = init?.method ?? "GET";
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    w.calls.push({ method, path, ...(body !== undefined ? { body } : {}) });

    const forced = Object.entries(w.statusFor).find(([prefix]) => path.startsWith(prefix));
    if (forced) return reply(forced[1], { error: forced[1] === 404 ? "not_found" : "authz_denied" });
    if (method !== "GET" && w.refuse) {
      const r = w.refuse;
      w.refuse = null;
      return reply(r.status, { error: r.error });
    }

    // Credits: GET /api/v1/accounts/{id}/credits?limit=
    const credits = path.match(/^\/api\/v1\/accounts\/([^/]+)\/credits$/);
    if (credits) {
      const b = w.balances[decodeURIComponent(credits[1] as string)];
      if (!b) return reply(404, { error: "not_found" });
      const limit = Number(url.searchParams.get("limit") ?? 20);
      return reply(200, {
        billingAccountId: credits[1],
        balanceCredits: b.balance,
        ledger: b.ledger.slice(0, limit).map((l, i) => ({ id: `l${i}`, balanceAfter: 0, reference: null, metadata: null, ...l })),
      });
    }

    if (path === "/api/v1/admin/orgs") return reply(200, { orgs: w.allOrgs, nextCursor: null });

    if (path === "/api/v1/orgs" && method === "GET") {
      return reply(200, { orgs: w.orgs.map(({ members: _m, links: _l, ...o }) => ({ ...o, balanceCredits: w.balances[o.billingAccountId]?.balance ?? 0 })), nextCursor: null });
    }
    if (path === "/api/v1/orgs" && method === "POST") {
      const name = String((body as { name: string }).name);
      const o: FxOrg = { orgUserId: `org-${w.orgs.length + 1}`, name, billingAccountId: `ba-${w.orgs.length + 1}`, suspended: false, role: "owner", members: [member("me", "owner", "Me")], links: [] };
      w.orgs.push(o);
      w.balances[o.billingAccountId] = { balance: 0, ledger: [] };
      return reply(201, { orgUserId: o.orgUserId, billingAccountId: o.billingAccountId, name });
    }
    if (path === "/api/v1/orgs/invites/mine") return reply(200, { invites: w.invites, nextCursor: null });
    const accept = path.match(/^\/api\/v1\/orgs\/invites\/([^/]+)\/accept$/);
    if (accept) {
      const i = w.invites.find((x) => x.id === accept[1]);
      if (!i) return reply(404, { error: "invite_not_found" });
      w.invites = w.invites.filter((x) => x !== i);
      w.orgs.push({ orgUserId: i.orgUserId, name: i.orgName, billingAccountId: `ba-${i.orgUserId}`, suspended: false, role: i.role, members: [member("me", i.role, "Me")], links: [] });
      w.balances[`ba-${i.orgUserId}`] = { balance: 0, ledger: [] };
      return reply(200, { orgUserId: i.orgUserId, role: i.role });
    }

    const sub = path.match(/^\/api\/v1\/orgs\/([^/]+)(?:\/(members|invites|link-codes|links|suspension)(?:\/([^/]+))?)?$/);
    if (!sub) return reply(404, { error: "not_found" });
    const [, orgId, kind, target] = sub;
    const org = w.orgs.find((o) => o.orgUserId === orgId);

    if (kind === "suspension" && method === "POST") {
      const row = w.allOrgs.find((o) => o.orgUserId === orgId);
      if (!row) return reply(404, { error: "not_found" });
      row.suspended = (body as { suspended: boolean }).suspended;
      return reply(200, { suspended: row.suspended });
    }
    if (!org) return reply(404, { error: "not_found" });

    const page = <T>(rows: T[], keyOf: (t: T) => string, size: number) => {
      const after = url.searchParams.get("cursor");
      const start = after ? rows.findIndex((r) => keyOf(r) === after) + 1 : 0;
      const items = rows.slice(start, start + size);
      const last = items[items.length - 1];
      return { items, nextCursor: start + size < rows.length && last ? keyOf(last) : null };
    };

    if (!kind && method === "GET") {
      const { members, links, ...record } = org;
      const { role, ...rec } = record;
      return reply(200, { org: { ...rec, balanceCredits: w.balances[rec.billingAccountId]?.balance ?? 0 }, role, members: page(members, (m) => m.userId, w.memberPage), links: page(links, (l) => l.id, 100) });
    }
    if (kind === "members" && !target && method === "GET") return reply(200, page(org.members, (m) => m.userId, w.memberPage));
    if (kind === "links" && !target && method === "GET") return reply(200, page(org.links, (l) => l.id, 100));
    if (kind === "members" && target && method === "PATCH") {
      const m = org.members.find((x) => x.userId === target);
      if (!m) return reply(404, { error: "not_found" });
      const from = m.role;
      m.role = (body as { role: Role }).role;
      return reply(200, { changed: from !== m.role, from, to: m.role });
    }
    if (kind === "members" && target && method === "DELETE") {
      const owners = org.members.filter((x) => x.role === "owner");
      const m = org.members.find((x) => x.userId === target);
      if (m?.role === "owner" && owners.length === 1) return reply(409, { error: "last_owner" });
      org.members = org.members.filter((x) => x.userId !== target);
      return reply(200, { removed: true });
    }
    if (kind === "invites" && method === "POST") {
      const b = body as { wallet: string; role: Role };
      if (!/^0x[0-9a-fA-F]{40}$/.test(b.wallet)) return reply(400, { error: "invalid_wallet" });
      return reply(201, { id: "inv-1", role: b.role, expiresAt: "2026-11-27T00:00:00.000Z" });
    }
    if (kind === "link-codes" && method === "POST") {
      const origin = (body as { origin: string }).origin;
      if (!origin.startsWith("https://")) return reply(400, { error: "invalid_origin" });
      return reply(201, { code: "LNK-abc123", origin: "https://node.test", expiresAt: "2026-11-20T00:15:00.000Z" });
    }
    if (kind === "links" && target && method === "DELETE") {
      org.links = org.links.filter((l) => l.id !== target);
      return reply(200, { unlinked: true, closedBindings: 1 });
    }
    return reply(404, { error: "not_found" });
  };
}
