// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/orgs/org-section`
 * Purpose: `/orgs/[id]`. Helps an owner or admin decide what the org has left, who may act for it and which nodes bill it.
 *   Three blocks: Balance (balance · spent this month), People (name · role badge, row menu Make owner / Make admin / Remove, Invite with wallet and role),
 *   Linked nodes (origin · status badge, row menu Unlink, "Link a node": enter an origin, copy the code).
 * Scope: Presentation over `useOrg`. The server decides every right; the section only hides what the caller's role can never do (an admin sees no owner actions and no link controls).
 * Invariants:
 *   - ONLY_OWNERS_TOUCH_OWNERS: an admin has no menu on an owner row and no Make owner; only an owner invites an owner. The server refuses it too.
 *   - ONLY_OWNERS_LINK: Unlink and Link a node render for an owner only.
 *   - CODE_IS_SHOWN_ONCE: the link code appears after the origin is accepted, with Copy; typing a new origin removes it.
 *   - NON_DISCLOSING: an unknown org and an org the caller is not in read the same one line.
 *   - UNKNOWN_IS_NOT_ZERO: a balance that is loading or failed reads "—"; a spend that may be cut by the ledger page reads with a trailing "+".
 * Side-effects: IO (through the hook)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

"use client";

import { type FormEvent, useState } from "react";

import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { Skeleton } from "../ui/skeleton.js";
import { formatCredits, memberLabel, type OrgEndpoints, type OrgMember, type OrgRole, ORG_ERROR_COPY, UNAVAILABLE_COPY } from "./org-client.js";
import { ErrorLine, OrgHeading, Pill, type RowMenuItem, RoleSelect, RolePill, RowMenu } from "./org-parts.js";
import { useOrg } from "./use-org.js";

export interface OrgSectionProps {
  readonly endpoints: OrgEndpoints;
  /** The org's id, from the page's route. */
  readonly orgId: string;
  readonly className?: string;
}

export function OrgSection({ endpoints, orgId, className }: OrgSectionProps) {
  const org = useOrg(endpoints, orgId);
  const { state, busy, error } = org;
  const [wallet, setWallet] = useState("");
  const [inviteRole, setInviteRole] = useState<OrgRole>("admin");
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);

  if (state.status === "loading") {
    return (
      <section aria-label="Org" className={className}>
        <Skeleton className="mt-8 h-8 w-48" />
        <Skeleton className="mt-4 h-12 w-full" />
        <Skeleton className="mt-2 h-12 w-full" />
      </section>
    );
  }
  if (state.status === "hidden") return null;
  if (state.status === "missing") {
    return (
      <p className="py-6 text-muted-foreground text-sm" role="status">
        {ORG_ERROR_COPY.not_found}
      </p>
    );
  }
  if (state.status === "unavailable") {
    return (
      <p className="flex items-center gap-3 py-3 text-destructive text-sm" role="alert">
        {UNAVAILABLE_COPY}
        <button type="button" className="text-foreground underline" onClick={() => void org.reload()}>
          Try again
        </button>
      </p>
    );
  }

  const isOwner = state.role === "owner";
  const locked = busy !== null;

  const memberMenu = (m: OrgMember): RowMenuItem[] => {
    if (m.role === "owner") {
      return isOwner
        ? [
            { label: "Make admin", onSelect: () => void org.setRole(m.userId, "admin") },
            { label: "Remove", onSelect: () => void org.remove(m.userId) },
          ]
        : [];
    }
    return [
      ...(isOwner ? [{ label: "Make owner", onSelect: () => void org.setRole(m.userId, "owner") }] : []),
      { label: "Remove", onSelect: () => void org.remove(m.userId) },
    ];
  };

  const onInvite = async (e: FormEvent) => {
    e.preventDefault();
    if (!wallet.trim() || locked) return;
    if (await org.invite(wallet, isOwner ? inviteRole : "admin")) setWallet("");
  };

  const onLink = async (e: FormEvent) => {
    e.preventDefault();
    if (!origin.trim() || locked) return;
    setCopied(false);
    if (await org.makeCode(origin)) setOrigin("");
  };

  const onCopy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const { balance } = state;

  return (
    <section aria-labelledby="org-heading" className={className}>
      <div className="flex items-center gap-3 pt-8">
        <h1 id="org-heading" className="min-w-0 break-words font-semibold text-foreground text-xl">
          {state.org.name}
        </h1>
        {state.org.suspended && <Pill tone="bad">Suspended</Pill>}
      </div>
      <ErrorLine message={error} />

      <dl className="flex gap-8 pt-6 pb-2">
        <div>
          <dt className="text-muted-foreground text-sm">Balance</dt>
          <dd className="font-semibold text-foreground text-lg tabular-nums">{balance ? formatCredits(balance.balance) : balance === undefined ? <Skeleton className="h-6 w-16" /> : "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-sm">Spent this month</dt>
          <dd className="font-semibold text-foreground text-lg tabular-nums">{balance ? `${formatCredits(balance.spent)}${balance.partial ? "+" : ""}` : balance === undefined ? <Skeleton className="h-6 w-16" /> : "—"}</dd>
        </div>
      </dl>

      <OrgHeading id="org-people-heading">People</OrgHeading>
      <ul className="divide-y divide-border">
        {state.members.map((m) => (
          <li key={m.userId} className="flex min-h-12 items-center gap-3 py-2">
            <span className="min-w-0 flex-1 break-words font-medium text-foreground">{memberLabel(m)}</span>
            <RolePill role={m.role} />
            {busy === `role:${m.userId}` || busy === `remove:${m.userId}` ? (
              <Skeleton className="h-9 w-9" />
            ) : (
              <RowMenu label={`Actions for ${memberLabel(m)}`} items={locked ? [] : memberMenu(m)} />
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={onInvite} className="flex items-center gap-2 py-3">
        <Input aria-label="Wallet" placeholder="Wallet 0x…" value={wallet} onChange={(e) => setWallet(e.target.value)} className="min-w-0 flex-1" />
        {isOwner && <RoleSelect label="Role" value={inviteRole} onChange={setInviteRole} roles={["admin", "owner"]} />}
        {busy === "invite" ? (
          <Skeleton className="h-9 w-16" />
        ) : (
          <Button type="submit" disabled={!wallet.trim() || locked} className="shrink-0">
            Invite
          </Button>
        )}
      </form>

      <OrgHeading id="org-links-heading">Linked nodes</OrgHeading>
      {state.links.length > 0 && (
        <ul className="divide-y divide-border">
          {state.links.map((l) => (
            <li key={l.id} className="flex min-h-12 items-center gap-3 py-2">
              <span className="min-w-0 flex-1 break-all font-medium text-foreground">{l.issuer}</span>
              <Pill tone="ok">Linked</Pill>
              {busy === `unlink:${l.id}` ? (
                <Skeleton className="h-9 w-9" />
              ) : (
                isOwner && <RowMenu label={`Actions for ${l.issuer}`} items={locked ? [] : [{ label: "Unlink", onSelect: () => void org.unlink(l.id) }]} />
              )}
            </li>
          ))}
        </ul>
      )}
      {isOwner && (
        <form onSubmit={onLink} className="flex items-center gap-2 py-3">
          <Input
            aria-label="Node origin"
            placeholder="https://…"
            value={origin}
            onChange={(e) => {
              setOrigin(e.target.value);
              if (org.linkCode) org.clearCode();
            }}
            className="min-w-0 flex-1"
          />
          {busy === "code" ? (
            <Skeleton className="h-9 w-28" />
          ) : (
            <Button type="submit" disabled={!origin.trim() || locked} className="shrink-0">
              Link a node
            </Button>
          )}
        </form>
      )}
      {isOwner && org.linkCode && (
        <div className="flex items-center gap-2 pb-3">
          <Input aria-label="Link code" readOnly value={org.linkCode.code} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 font-mono" />
          <Button variant="outline" className="shrink-0" onClick={() => void onCopy(org.linkCode?.code ?? "")}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      )}
    </section>
  );
}
