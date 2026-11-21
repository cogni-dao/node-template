// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/orgs/orgs-section`
 * Purpose: `/orgs`. Helps a person decide which org to open, whether to join one they were invited to, or to make one.
 *   Rows: org name · my role badge · balance (one whole-row link). Invites: org name · role badge · Accept. One action to create: an org name.
 * Scope: Presentation over `useOrgList`. Shown to every signed-in person; a signed-out caller (401) sees nothing.
 * Invariants:
 *   - ONE_SURFACE_PER_ROW: the whole org row is the link (stretched anchor); the balance is text inside it.
 *   - MONEY_IS_DOLLARS: the balance reads through the injected `formatMoney`; the package holds no rate.
 *   - REFUSAL_IN_PLAIN_WORDS: a refused create (a second org, `org_role_limit`) shows the server's refusal as one sentence under the form.
 *   - A click in flight replaces its button with a Skeleton and locks the other buttons.
 * Side-effects: IO (through the hook)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

"use client";

import { type ComponentType, type FormEvent, type ReactNode, useState } from "react";

import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { Skeleton } from "../ui/skeleton.js";
import { type OrgEndpoints, UNAVAILABLE_COPY } from "./org-client.js";
import { ErrorLine, OrgHeading, RolePill } from "./org-parts.js";
import { useOrgList } from "./use-org-list.js";

export interface OrgLinkProps {
  readonly href: string;
  readonly className?: string;
  readonly children?: ReactNode;
}

export type OrgLinkComponent = ComponentType<OrgLinkProps>;

const DefaultLink: OrgLinkComponent = (props) => <a {...props} />;

export interface OrgsSectionProps {
  readonly endpoints: OrgEndpoints;
  /** The page of one org (default `/orgs/{id}`). */
  readonly hrefFor?: (orgUserId: string) => string;
  /** The router's link (`next/link`); default `<a>`. */
  readonly LinkComponent?: OrgLinkComponent;
  /** How a credit amount reads to a person (the node passes its one dollars formatter; the package holds no rate). */
  readonly formatMoney: (credits: number) => string;
  readonly className?: string;
}

export function OrgsSection({ endpoints, formatMoney, hrefFor = (id) => `/orgs/${encodeURIComponent(id)}`, LinkComponent = DefaultLink, className }: OrgsSectionProps) {
  const { state, busy, error, create, accept, reload } = useOrgList(endpoints);
  const [name, setName] = useState("");

  if (state.status === "loading") {
    return (
      <section aria-label="Orgs" className={className}>
        <div className="pt-8 pb-2">
          <Skeleton className="h-6 w-24" />
          <div className="mt-2 border-border border-b" />
        </div>
        <Skeleton className="mt-3 h-12 w-full" />
        <Skeleton className="mt-2 h-12 w-full" />
      </section>
    );
  }
  if (state.status === "hidden") return null;
  if (state.status === "unavailable") {
    return (
      <section aria-label="Orgs" className={className}>
        <p className="flex items-center gap-3 py-3 text-destructive text-sm" role="alert">
          {UNAVAILABLE_COPY}
          <button type="button" className="text-foreground underline" onClick={() => void reload()}>
            Try again
          </button>
        </p>
      </section>
    );
  }

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy !== null) return;
    if (await create(name)) setName("");
  };

  return (
    <section aria-labelledby="orgs-heading" className={className}>
      <OrgHeading id="orgs-heading">Orgs</OrgHeading>
      {state.orgs.length > 0 && (
        <ul className="divide-y divide-border">
          {state.orgs.map((o) => (
            <li key={o.orgUserId} className="relative flex min-h-12 items-center gap-3 py-2 hover:bg-accent">
              <LinkComponent href={hrefFor(o.orgUserId)} className="min-w-0 flex-1 break-words font-medium text-foreground after:absolute after:inset-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                {o.name}
              </LinkComponent>
              <RolePill role={o.role} />
              <span className="shrink-0 whitespace-nowrap text-right text-foreground tabular-nums" aria-label="Balance">
                {formatMoney(o.balanceCredits)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={onCreate} className="flex items-center gap-2 py-3">
        <Input aria-label="Org name" placeholder="Org name" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} className="min-w-0 flex-1" />
        {busy === "create" ? (
          <Skeleton className="h-9 w-24" />
        ) : (
          <Button type="submit" disabled={!name.trim() || busy !== null} className="shrink-0">
            Create org
          </Button>
        )}
      </form>
      <ErrorLine message={error} />

      {state.invites.length > 0 && (
        <>
          <OrgHeading id="org-invites-heading">Invites</OrgHeading>
          <ul className="divide-y divide-border">
            {state.invites.map((i) => (
              <li key={i.id} className="flex min-h-12 items-center gap-3 py-2">
                <span className="min-w-0 flex-1 break-words font-medium text-foreground">{i.orgName}</span>
                <RolePill role={i.role} />
                {busy === i.id ? (
                  <Skeleton className="h-8 w-16" />
                ) : (
                  <Button size="sm" aria-label={`Accept ${i.orgName}`} disabled={busy !== null} onClick={() => void accept(i.id)}>
                    Accept
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
