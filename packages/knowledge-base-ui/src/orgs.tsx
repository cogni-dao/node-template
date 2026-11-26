// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/orgs`
 * Purpose: The org account pages (task.0181, `org-account-lifecycle`), every page a table of rows (name, badge, one number, one action) and no top-level tab:
 *   `YourOrgs` (account menu, only when the person holds a role), `OrgAccountPage` (who spends, grant or remove `org:spend`, Fund, history), `BillToSelect` (the composer),
 *   `OrgConnectionsPage` (the org's governance page: Connect by origin, Disconnect) and `AdminOrgAccounts` (`/admin`: Suspend and Restore with a reason).
 * Scope: Presentation over fetch. The node passes its endpoints, links and money formatter; the package decides nothing about authority (the routes do).
 * Invariants:
 *   - MINIMAL_TEXT: a row is a name, a badge, one number and one action; no subtitles, no sentences. A reason a person typed is the only free text shown.
 *   - NOTHING_FOR_NO_ROLE: `YourOrgs` and `BillToSelect` render nothing while loading, on any failure and when the person has no org.
 *   - ONE_CLICK_ONE_ACT: a click is one request; the row's button is disabled while it runs and the list is read again after.
 *   - NO_TOKEN_OR_ID_TEXT: the text carries names, wallets as short addresses, and the badge words only.
 * Side-effects: IO (fetch to the node's routes)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

"use client";

import type { AdminOrgRow, MyOrgRow, OrgAccountView, OrgEventRow, OrgPersonRow } from "@cogni/agent-grants/org-accounts";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { cn } from "./cn.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Skeleton } from "./ui/skeleton.js";

export type { AdminOrgRow, MyOrgRow, OrgAccountView, OrgEventRow, OrgPersonRow };

/** One connection of the org to another node, as the governance page lists it. */
export interface OrgConnectionRow {
  readonly origin: string;
  readonly name: string;
  readonly status: "connected" | "disconnected" | "suspended" | "unreachable";
  readonly reason: string | null;
}

const defaultBalance = (credits: number): string => credits.toLocaleString();

const short = (who: string): string => (/^0x[0-9a-f]{40}$/i.test(who) ? `${who.slice(0, 6)}…${who.slice(-4)}` : who);

const BADGE = "rounded border border-foreground/40 px-1 text-xs";

function Badge({ children, tone }: { children: ReactNode; tone?: "bad" }) {
  return <span className={cn(BADGE, tone === "bad" && "border-destructive text-destructive")}>{children}</span>;
}

const statusTone = (status: string) => (status === "suspended" || status === "unreachable" ? ("bad" as const) : undefined);

type Loaded<T> = { readonly status: "loading" } | { readonly status: "failed"; readonly code: number } | { readonly status: "ready"; readonly data: T };

/** One GET shared by every component that asks for the same URL inside `staleMs`, so the account menu and the composer make ONE request per freshness window, not one per mount. */
const shared = new Map<string, { at: number; read: Promise<{ ok: boolean; status: number; body: unknown }> }>();

/** Forget every shared read (sign-out, or a test). */
export function clearOrgsCache(): void {
  shared.clear();
}

function read(url: string, staleMs: number): Promise<{ ok: boolean; status: number; body: unknown }> {
  const hit = staleMs > 0 ? shared.get(url) : undefined;
  if (hit && Date.now() - hit.at < staleMs) return hit.read;
  const pending = fetch(url, { credentials: "same-origin", cache: "no-store" }).then(async (res) => ({ ok: res.ok, status: res.status, body: res.ok ? ((await res.json()) as unknown) : null }));
  if (staleMs > 0) {
    shared.set(url, { at: Date.now(), read: pending });
    // A failed read is never shared: the next mount asks again.
    pending.then((r) => r.ok || shared.delete(url), () => shared.delete(url));
  }
  return pending;
}

/** One GET, read again on demand (`reload` always asks the server). With `staleMs`, a mount reuses a read that fresh. A non-2xx answer or a network failure is `failed` with the status (0 for the network). */
function useGet<T>(url: string, staleMs = 0): { state: Loaded<T>; reload: () => Promise<void> } {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const alive = useRef(true);
  const seq = useRef(0);
  const load = useCallback(
    async (freshFor: number) => {
      const mine = ++seq.current;
      try {
        const res = await read(url, freshFor);
        if (!alive.current || mine !== seq.current) return;
        setState(res.ok && res.body ? { status: "ready", data: res.body as T } : { status: "failed", code: res.status });
      } catch {
        if (alive.current && mine === seq.current) setState({ status: "failed", code: 0 });
      }
    },
    [url]
  );
  const reload = useCallback(() => load(0), [load]);
  useEffect(() => {
    alive.current = true;
    void load(staleMs);
    return () => {
      alive.current = false;
    };
  }, [load, staleMs]);
  return { state, reload };
}

/** One write. Resolves the status; never throws. */
type OrgStatus = MyOrgRow["status"];

/** Like `send`, and also the `status` field of a JSON answer when it carries a known one (the server's word, not the page's guess). */
async function sendRead(url: string, body: unknown): Promise<{ code: number; status: OrgStatus | null }> {
  try {
    const res = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let status: OrgStatus | null = null;
    try {
      const answer = (await res.json()) as { status?: unknown };
      if (answer.status === "connected" || answer.status === "disconnected" || answer.status === "suspended") status = answer.status;
    } catch {
      /* no JSON body: the caller falls back to what it asked for */
    }
    return { code: res.status, status };
  } catch {
    return { code: 0, status: null };
  }
}

async function send(url: string, method: "POST" | "DELETE", body: unknown): Promise<number> {
  try {
    const res = await fetch(url, { method, credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return res.status;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------

export interface YourOrgsProps {
  /** `GET /api/v1/orgs`. */
  readonly endpoint: string;
  /** Where one org's page is. */
  readonly href: (org: MyOrgRow) => string;
  /**
   * The node's link component (default `<a>`). It renders the row AS A MENU ITEM of the host's menu: the account menu passes its own item wrapper, so keyboard focus and roving
   * behave like Profile and Sign out. It receives the row's classes in `className`.
   */
  readonly LinkComponent?: (props: { href: string; className?: string; children: ReactNode }) => ReactNode;
  readonly formatBalance?: (credits: number) => string;
  readonly className?: string;
}

/**
 * "My orgs", keyset-paged by origin: the first page is the shared read (the account menu and the composer make one request between them); `more` appends the next page. A first page with no org
 * but a cursor (candidates that held no role) keeps loading until it finds one or runs out, so the menu never hides orgs behind an empty first page.
 */
function useMyOrgs(endpoint: string) {
  const { state } = useGet<{ orgs: MyOrgRow[]; next?: string | null }>(endpoint, MINE_STALE_MS);
  const [extra, setExtra] = useState<MyOrgRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (state.status !== "ready") return;
    setExtra([]);
    setNext(state.data.next ?? null);
  }, [state]);
  const more = useCallback(async () => {
    if (!next || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${endpoint}?after=${encodeURIComponent(next)}`, { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) throw new Error("page");
      const page = (await res.json()) as { orgs: MyOrgRow[]; next?: string | null };
      setExtra((current) => [...current, ...page.orgs]);
      setNext(page.next ?? null);
    } catch {
      setNext(null);
    }
    setBusy(false);
  }, [endpoint, next, busy]);
  const orgs = state.status === "ready" ? [...state.data.orgs, ...extra] : [];
  useEffect(() => {
    if (state.status === "ready" && orgs.length === 0 && next) void more();
  }, [state.status, orgs.length, next, more]);
  return { ready: state.status === "ready", failed: state.status === "failed", orgs, next, busy, more };
}

/** The account menu and the composer share one read of "my orgs" for this long. */
const MINE_STALE_MS = 30_000;

/** The default row: a plain anchor that is a menu item of whatever menu it sits in. Module level, so it keeps one identity across renders. */
function DefaultMenuLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return (
    <a href={href} className={className} role="menuitem">
      {children}
    </a>
  );
}

const MORE_OPTION = "__more";

const ROW_CLASS = "flex items-center justify-between gap-3 rounded px-2 py-1.5 text-sm hover:bg-accent";

/** Account menu, "Your orgs": org name · role badge · balance · open, each row a menu item. Nothing at all when the person holds no role. */
export function YourOrgs({ endpoint, href, LinkComponent, formatBalance = defaultBalance, className }: YourOrgsProps) {
  const mine = useMyOrgs(endpoint);
  if (!mine.ready || mine.orgs.length === 0) return null;
  const Link = LinkComponent ?? DefaultMenuLink;
  return (
    <div role="group" aria-label="Your orgs" className={className}>
      <div className="px-2 py-1 font-medium text-muted-foreground text-xs">Your orgs</div>
      {mine.orgs.map((org) => (
        <Link key={org.orgUserId} href={href(org)} className={ROW_CLASS}>
          <span className="min-w-0 max-w-full truncate">{org.name}</span>
          <span className="flex shrink-0 items-center gap-2">
            <Badge>{org.role}</Badge>
            {org.status === "suspended" && <Badge tone="bad">suspended</Badge>}
            <span className="tabular-nums text-muted-foreground">{formatBalance(org.balance)}</span>
          </span>
        </Link>
      ))}
      {mine.next && (
        <Button variant="ghost" size="sm" className="w-full" disabled={mine.busy} onClick={() => void mine.more()}>
          More
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------

export interface BillToSelectProps {
  /** `GET /api/v1/orgs`. */
  readonly endpoint: string;
  /** The chosen org account's billing account id, or null for the person's own. */
  readonly value: string | null;
  /** The choice, with the chosen org's row (its balance: the model gate and picker use it, not the person's own), or `null` for the person's own. */
  readonly onChange: (billingAccountId: string | null, org: MyOrgRow | null) => void;
  readonly className?: string;
}

/** The composer's "Bill to": me, or an org the person may spend from. Nothing when the person has no org. */
export function BillToSelect({ endpoint, value, onChange, className }: BillToSelectProps) {
  const mine = useMyOrgs(endpoint);
  // NEVER_RESET_THE_PAYER_SILENTLY: while an org is chosen and the list cannot be read, the select stays, showing the chosen org and the error; only the person's own pick changes it.
  if (mine.failed && value) {
    return (
      <label className={cn("flex items-center gap-2 text-sm", className)}>
        <span className="text-muted-foreground">Bill to</span>
        <select className="rounded border border-input bg-background px-2 py-1 text-base" value={value} onChange={(event) => {
            if (event.target.value === "") onChange(null, null);
          }}>
          <option value={value}>Selected org</option>
          <option value="">Me</option>
        </select>
        <span className="text-destructive" role="alert">
          Can't load your orgs.
        </span>
      </label>
    );
  }
  if (!mine.ready || mine.orgs.length === 0) return null;
  return (
    <label className={cn("flex items-center gap-2 text-sm", className)}>
      <span className="text-muted-foreground">Bill to</span>
      <select
        className="rounded border border-input bg-background px-2 py-1 text-base"
        value={value ?? ""}
        onChange={(event) => {
          if (event.target.value === MORE_OPTION) {
            void mine.more();
            return;
          }
          const chosen = mine.orgs.find((o) => o.billingAccountId === event.target.value) ?? null;
          onChange(chosen ? chosen.billingAccountId : null, chosen);
        }}
      >
        <option value="">Me</option>
        {mine.orgs.map((org) => (
          <option key={org.billingAccountId} value={org.billingAccountId} disabled={org.status === "suspended"}>
            {org.name}
            {org.status === "suspended" ? " (suspended)" : ""}
          </option>
        ))}
        {mine.next && <option value={MORE_OPTION}>More…</option>}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------

export interface OrgAccountPageProps {
  /** `GET /api/v1/orgs/{orgId}` for this org. */
  readonly orgEndpoint: string;
  /** `/api/v1/orgs/{orgId}/spend` for this org (POST grants, DELETE removes). */
  readonly spendEndpoint: string;
  /** Billing's top-up link for THIS org account, given its billing account id. Absent = no Fund action. Fund shows only for an `org:admin` viewer whose view carries `billingAccountId`. */
  readonly fundHref?: (billingAccountId: string) => string;
  readonly formatBalance?: (credits: number) => string;
  readonly className?: string;
}

const ACT_WORDS: Readonly<Record<string, string>> = {
  "org.connected": "connected",
  "org.admins_changed": "admins changed",
  "org.services_changed": "services changed",
  "org.disconnected": "disconnected",
  "org.spend_granted": "spend granted",
  "org.spend_claimed": "spend claimed",
  "org.spend_removed": "spend removed",
  "org.suspended": "suspended",
  "org.restored": "restored",
  "org.funded": "funded",
};

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** The org account page: who acts and spends here (grant or remove `org:spend`), Fund, and the history. A person with no role sees nothing (the route's one 404). */
export function OrgAccountPage({ orgEndpoint, spendEndpoint, fundHref, formatBalance = defaultBalance, className }: OrgAccountPageProps) {
  const { state, reload } = useGet<{ org: OrgAccountView }>(orgEndpoint);
  const [wallet, setWallet] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The people and the history are paged (a complete view never truncates): More appends the next page to what the first read returned.
  const [morePeople, setMorePeople] = useState<OrgPersonRow[]>([]);
  const [peopleNext, setPeopleNext] = useState<string | null>(null);
  const [moreHistory, setMoreHistory] = useState<OrgEventRow[]>([]);
  const [historyNext, setHistoryNext] = useState<string | null>(null);
  useEffect(() => {
    if (state.status !== "ready") return;
    setMorePeople([]);
    setMoreHistory([]);
    setPeopleNext(state.data.org.peopleNext);
    setHistoryNext(state.data.org.historyNext);
  }, [state]);

  const more = async (list: "people" | "history") => {
    const query = list === "history" ? `historyBefore=${encodeURIComponent(historyNext ?? "")}` : `peopleAfter=${encodeURIComponent(peopleNext ?? "")}`;
    setBusy("more");
    setError(null);
    try {
      const res = await fetch(`${orgEndpoint}?${query}`, { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) throw new Error("page");
      const page = ((await res.json()) as { org: OrgAccountView }).org;
      if (list === "history") {
        setMoreHistory((current) => [...current, ...page.history]);
        setHistoryNext(page.historyNext);
      } else {
        setMorePeople((current) => [...current, ...page.people]);
        setPeopleNext(page.peopleNext);
      }
    } catch {
      setError("Couldn't load more. Try again.");
    }
    setBusy(null);
  };

  const act = async (key: string, method: "POST" | "DELETE", address: string) => {
    setBusy(key);
    setError(null);
    const status = await send(spendEndpoint, method, { wallet: address });
    setBusy(null);
    if (status >= 200 && status < 300) {
      if (method === "POST") setWallet("");
      await reload();
    } else setError(status === 400 ? "Not a wallet address." : "Couldn't save. Try again.");
  };

  if (state.status === "loading") return <Skeleton className="h-24 w-full" />;
  if (state.status === "failed") return state.code === 404 ? null : <p className="text-destructive text-sm" role="alert">Can't load. Try again.</p>;
  const org = state.data.org;
  return (
    <section aria-label={org.name} className={className}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-border border-b pb-3">
        <div className="flex items-center gap-2">
          <h1 className="font-semibold text-lg">{org.name}</h1>
          <Badge>{org.role}</Badge>
          {org.status !== "connected" && <Badge tone={statusTone(org.status)}>{org.status}</Badge>}
          {org.adminLapsed && <Badge tone="bad">admin lapsed</Badge>}
        </div>
        <div className="flex items-center gap-3">
          <span className="tabular-nums">{formatBalance(org.balance)}</span>
          {fundHref && org.role === "admin" && org.billingAccountId ? (
            <Button asChild size="sm">
              <a href={fundHref(org.billingAccountId)}>Fund</a>
            </Button>
          ) : null}
        </div>
      </header>
      {org.status === "suspended" && org.suspendReason && <p className="py-2 text-destructive text-sm">{org.suspendReason}</p>}
      {error && <p className="py-2 text-destructive text-sm" role="alert">{error}</p>}

      {org.canManage && (
        <>
          <div className="overflow-x-auto">
          <table className="mt-4 w-full text-left text-sm">
            <tbody className="divide-y divide-border">
              {[...org.people, ...morePeople].map((p) => (
                <tr key={`${p.kind}:${p.who}:${p.role}:${p.held}`}>
                  <td className="py-2 pr-3 font-mono">{short(p.who)}</td>
                  <td className="py-2 pr-3">
                    <Badge>{p.role}</Badge> {p.held && <Badge>waiting</Badge>}
                  </td>
                  <td className="py-2 text-right">
                    {p.removable && (
                      <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void act(`rm:${p.who}`, "DELETE", p.who)}>
                        Remove
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="py-2 pr-3" colSpan={2}>
                  <Input
                    className="min-w-0 font-mono"
                    placeholder="0x…"
                    aria-label="Wallet"
                    value={wallet}
                    onChange={(event) => setWallet(event.target.value.trim())}
                  />
                </td>
                <td className="py-2 text-right">
                  <Button size="sm" disabled={busy !== null || wallet === ""} onClick={() => void act("grant", "POST", wallet)}>
                    Grant spend
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>
          </div>
          {peopleNext !== null && (
            <div className="pt-1 text-right">
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void more("people")}>
                More
              </Button>
            </div>
          )}

          <div className="overflow-x-auto">
          <table className="mt-6 w-full text-left text-sm" aria-label="History">
            <tbody className="divide-y divide-border">
              {[...org.history, ...moreHistory].map((e, i) => (
                <tr key={`${e.at}:${i}`}>
                  <td className="py-1.5 pr-3">
                    {ACT_WORDS[e.act] ?? e.act}
                    {e.reason ? <span className="text-muted-foreground"> · {e.reason}</span> : null}
                  </td>
                  <td className="py-1.5 pr-3 font-mono text-muted-foreground">{short(e.actor)}</td>
                  <td className="whitespace-nowrap py-1.5 text-right text-muted-foreground">{when(e.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          {historyNext !== null && (
            <div className="pt-1 text-right">
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void more("history")}>
                More
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------

export interface OrgConnectionsPageProps {
  /** `/api/v1/admin/org-connections` (GET lists, POST connects, DELETE disconnects). */
  readonly endpoint: string;
  readonly className?: string;
}

/** The org's own governance page: its accounts on other nodes, node · status · Disconnect, and Connect for an origin. */
export function OrgConnectionsPage({ endpoint, className }: OrgConnectionsPageProps) {
  const { state, reload } = useGet<{ connections: OrgConnectionRow[]; next?: string | null }>(endpoint);
  const [origin, setOrigin] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moreRows, setMoreRows] = useState<OrgConnectionRow[]>([]);
  const [connectionsNext, setConnectionsNext] = useState<string | null>(null);
  useEffect(() => {
    if (state.status !== "ready") return;
    setMoreRows([]);
    setConnectionsNext(state.data.next ?? null);
  }, [state]);

  const moreConnections = async () => {
    if (!connectionsNext) return;
    setBusy("more");
    setError(null);
    try {
      const res = await fetch(`${endpoint}?after=${encodeURIComponent(connectionsNext)}`, { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) throw new Error("page");
      const page = (await res.json()) as { connections: OrgConnectionRow[]; next?: string | null };
      setMoreRows((current) => [...current, ...page.connections]);
      setConnectionsNext(page.next ?? null);
    } catch {
      setError("Couldn't load more. Try again.");
    }
    setBusy(null);
  };

  const act = async (key: string, method: "POST" | "DELETE", target: string) => {
    setBusy(key);
    setError(null);
    const status = await send(endpoint, method, { origin: target });
    setBusy(null);
    if (status >= 200 && status < 300) {
      if (method === "POST") setOrigin("");
      await reload();
    } else
      setError(
        status === 400 ? "Not in the node directory." : status === 409 ? "Node id does not match the directory." : status === 503 ? "No signing key here." : "Couldn't reach it. Try again."
      );
  };

  if (state.status === "loading") return <Skeleton className="h-24 w-full" />;
  if (state.status === "failed") return <p className="text-destructive text-sm" role="alert">Can't load. Try again.</p>;
  return (
    <section aria-label="Connections" className={className}>
      {error && <p className="pb-2 text-destructive text-sm" role="alert">{error}</p>}
      <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <tbody className="divide-y divide-border">
          {[...state.data.connections, ...moreRows].map((c) => (
            <tr key={c.origin}>
              <td className="py-2 pr-3">{c.name}</td>
              <td className="py-2 pr-3">
                <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                {c.status === "suspended" && c.reason ? <span className="text-muted-foreground"> · {c.reason}</span> : null}
              </td>
              <td className="py-2 text-right">
                {c.status === "disconnected" ? (
                  <Button size="sm" disabled={busy !== null} onClick={() => void act(`c:${c.origin}`, "POST", c.origin)}>Connect</Button>
                ) : (
                  <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void act(`d:${c.origin}`, "DELETE", c.origin)}>Disconnect</Button>
                )}
              </td>
            </tr>
          ))}
          <tr>
            <td className="py-2 pr-3" colSpan={2}>
              <Input
                className="min-w-0"
                placeholder="https://node.example"
                aria-label="Node address"
                value={origin}
                onChange={(event) => setOrigin(event.target.value.trim())}
              />
            </td>
            <td className="py-2 text-right">
              <Button size="sm" disabled={busy !== null || origin === ""} onClick={() => void act("connect", "POST", origin)}>Connect</Button>
            </td>
          </tr>
        </tbody>
      </table>
      </div>
      {connectionsNext && (
        <div className="pt-1 text-right">
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void moreConnections()}>
            More
          </Button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------

export interface AdminOrgAccountsProps {
  /** `GET /api/v1/admin/orgs`. */
  readonly endpoint: string;
  /** `POST /api/v1/admin/orgs/{orgId}/suspension` for an org. */
  readonly suspensionEndpoint: (orgUserId: string) => string;
  readonly className?: string;
}

/** `/admin` org accounts: name · status · Suspend or Restore, each with a reason. Pages of 50 with More. */
export function AdminOrgAccounts({ endpoint, suspensionEndpoint, className }: AdminOrgAccountsProps) {
  const { state } = useGet<{ orgs: AdminOrgRow[]; next: string | null }>(endpoint);
  const [rows, setRows] = useState<AdminOrgRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (state.status === "ready") {
      setRows(state.data.orgs);
      setNext(state.data.next);
    }
  }, [state]);

  const more = async () => {
    if (!next) return;
    setBusy(true);
    try {
      const res = await fetch(`${endpoint}?after=${encodeURIComponent(next)}`, { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) throw new Error("page");
      const page = (await res.json()) as { orgs: AdminOrgRow[]; next: string | null };
      setRows((current) => [...(current ?? []), ...page.orgs]);
      setNext(page.next);
    } catch {
      setError("Couldn't load more. Try again.");
    }
    setBusy(false);
  };

  const submit = async (org: AdminOrgRow) => {
    setBusy(true);
    setError(null);
    const suspend = org.status !== "suspended";
    const answer = await sendRead(suspensionEndpoint(org.orgUserId), { suspend, reason });
    const status = answer.code;
    setBusy(false);
    if (status >= 200 && status < 300) {
      // The row shows the status the SERVER answered: a restored org that is still disconnected is not "connected".
      const shown: OrgStatus = answer.status ?? (suspend ? "suspended" : "connected");
      setRows((current) => (current ?? []).map((r) => (r.orgUserId === org.orgUserId ? { ...r, status: shown, reason: shown === "suspended" ? reason : null } : r)));
      setOpen(null);
      setReason("");
    } else setError(status === 400 ? "A reason is required." : "Couldn't save. Try again.");
  };

  if (state.status === "failed") return <p className="text-destructive text-sm" role="alert">Can't load. Try again.</p>;
  if (state.status === "loading" || rows === null) return <Skeleton className="h-16 w-full" />;
  if (rows.length === 0) return null;
  return (
    <section aria-label="Org accounts" className={className}>
      {error && <p className="pb-2 text-destructive text-sm" role="alert">{error}</p>}
      <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <tbody className="divide-y divide-border">
          {rows.map((org) => (
            <tr key={org.orgUserId}>
              <td className="py-2 pr-3">{org.name}</td>
              <td className="py-2 pr-3">
                <Badge tone={statusTone(org.status)}>{org.status}</Badge>
                {org.status === "suspended" && org.reason ? <span className="text-muted-foreground"> · {org.reason}</span> : null}
              </td>
              <td className="py-2 text-right">
                {open === org.orgUserId ? (
                  <span className="inline-flex min-w-0 flex-wrap items-center justify-end gap-2">
                    <Input
                      className="min-w-0 sm:w-48"
                      placeholder="Reason"
                      aria-label="Reason"
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                    />
                    <Button size="sm" disabled={busy || reason.trim() === ""} onClick={() => void submit(org)}>
                      {org.status === "suspended" ? "Restore" : "Suspend"}
                    </Button>
                  </span>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => { setOpen(org.orgUserId); setReason(""); setError(null); }}>
                    {org.status === "suspended" ? "Restore" : "Suspend"}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
</div>
      {next ? (
        <div className="pt-2 text-right">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void more()}>
            More
          </Button>
        </div>
      ) : null}
    </section>
  );
}
