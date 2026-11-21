// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/orgs/org-admin-section`
 * Purpose: The node admin's org rows on `/admin`. Helps the admin decide which org to stop. Rows: org name · status badge · Suspend.
 * Scope: Presentation over `useOrgAdmin`. Renders nothing for anyone but a confirmed admin (the list route answers 403 to others).
 * Invariants:
 *   - SUSPEND_IS_FINAL: there is no Resume. The button asks once more ("Confirm") before it sends, and a suspended row has no button.
 *   - NON_ADMIN_SEES_NOTHING: loading, 401, 403, 404 and every other failure render `null`; only a confirmed 503 says so.
 * Side-effects: IO (through the hook)
 * Links: https://node-template.cognidao.org/knowledge/org-account-lifecycle
 * @public
 */

"use client";

import { useState } from "react";

import { Button } from "../ui/button.js";
import { Skeleton } from "../ui/skeleton.js";
import { type OrgEndpoints, UNAVAILABLE_COPY } from "./org-client.js";
import { ErrorLine, OrgHeading, Pill } from "./org-parts.js";
import { useOrgAdmin } from "./use-org-admin.js";

export interface OrgAdminSectionProps {
  readonly endpoints: OrgEndpoints;
  readonly className?: string;
}

export function OrgAdminSection({ endpoints, className }: OrgAdminSectionProps) {
  const { state, busy, error, suspend, reload } = useOrgAdmin(endpoints);
  const [confirming, setConfirming] = useState<string | null>(null);

  if (state.status === "hidden" || state.status === "loading") return null;
  if (state.status === "unavailable") {
    return (
      <p className="flex items-center gap-3 py-3 text-destructive text-sm" role="alert">
        {UNAVAILABLE_COPY}
        <button type="button" className="text-foreground underline" onClick={() => void reload()}>
          Try again
        </button>
      </p>
    );
  }
  if (state.orgs.length === 0) return null;

  return (
    <section aria-labelledby="admin-orgs-heading" className={className}>
      <OrgHeading id="admin-orgs-heading">Orgs</OrgHeading>
      <ErrorLine message={error} />
      <ul className="divide-y divide-border">
        {state.orgs.map((o) => (
          <li key={o.orgUserId} className="flex min-h-12 items-center gap-3 py-2">
            <span className="min-w-0 flex-1 break-words font-medium text-foreground">{o.name}</span>
            <Pill tone={o.suspended ? "bad" : "ok"}>{o.suspended ? "Suspended" : "Active"}</Pill>
            {o.suspended ? null : busy === o.orgUserId ? (
              <Skeleton className="h-8 w-20" />
            ) : confirming === o.orgUserId ? (
              <Button
                size="sm"
                variant="outline"
                className="w-20 border-destructive text-destructive"
                aria-label={`Confirm suspend ${o.name}`}
                disabled={busy !== null}
                onBlur={() => setConfirming(null)}
                onClick={() => {
                  setConfirming(null);
                  void suspend(o.orgUserId);
                }}
              >
                Confirm
              </Button>
            ) : (
              <Button size="sm" variant="outline" className="w-20" aria-label={`Suspend ${o.name}`} disabled={busy !== null} onClick={() => setConfirming(o.orgUserId)}>
                Suspend
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
