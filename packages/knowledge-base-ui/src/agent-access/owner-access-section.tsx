// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/agent-access/owner-access-section`
 * Purpose: "Your AIs" on a person's profile, rendered by the same `AgentAccessSection` the admin page renders. Sections: a claim row (when a `?claim=<id>` link is open), asks waiting that the
 *   person decides, their AIs with the permissions they have turned On (and Off), and Add an AI (the setup line is shown once, with a copy control).
 * Scope: Presentation over `useOwnerAccess`. Lists the person's own AIs and personal rows only: no node-wide permission and no admin control.
 * Invariants:
 *   - APPROVER_FOLLOWS_RESOURCE: the person decides for AIs they own. A node permission never appears here; it is Admin's.
 *   - ONE_CONTROL_ONE_DECISION: the switch is the whole decision for a live row (Off); an ask has Approve and Deny. No confirm step.
 *   - HUMAN_SURFACE_TOKENLESS: the text holds names and the declared descriptions, no key, id, scope string or API path. The setup line is the one place a one-time code is shown.
 *   - Loading is a Skeleton, never bare text; an empty list says so plainly; an unavailable first load says so with Try again.
 *   - A click in flight replaces that row's control with a Skeleton. A switch is never shown dimmed.
 * Side-effects: IO (through the hook), clipboard write (copy control)
 * Links: https://cognidao.org/knowledge/ai-access-surface-design, https://cognidao.org/work/items/task.5465
 * @public
 */

"use client";

import type { YourAiPermissionView } from "@cogni/agent-grants";
import { Check, Copy } from "lucide-react";
import { type ReactElement, useState } from "react";

import { Button } from "../ui/button.js";
import { Skeleton } from "../ui/skeleton.js";
import { HIGHLIGHT_CLASS, useScrollToHighlight } from "./highlight.js";
import { Switch } from "./switch.js";
import type { OwnerAccessEndpoints } from "./use-agent-access.js";
import { UNAVAILABLE_COPY } from "./use-agent-access.js";
import { type OwnedAi, useOwnerAccess } from "./use-owner-access.js";

const KEY_STATE_TEXT: Record<OwnedAi["keyState"], string> = {
  active: "Key active",
  pending: "Waiting for the AI to confirm its key",
  expired: "Key expired",
  revoked: "Key revoked",
  none: "No key",
};

export interface OwnerAccessSectionProps {
  readonly endpoints: OwnerAccessEndpoints;
  readonly className?: string | undefined;
  readonly highlightId?: string | undefined;
}

export function OwnerAccessSection({ endpoints, className, highlightId }: OwnerAccessSectionProps): ReactElement {
  const owner = useOwnerAccess(endpoints, highlightId);
  const { state, claim, busy, error, setupLine } = owner;
  const ready = state.status === "ready";
  const asks = ready ? state.permissions.filter((p) => !p.on) : [];
  const live = ready ? state.permissions.filter((p) => p.on) : [];
  const hasHighlightedRow = !!highlightId && ready && state.permissions.some((p) => p.requestId === highlightId);
  useScrollToHighlight(hasHighlightedRow ? `ask-${highlightId}` : claim && highlightId ? `claim-${highlightId}` : null, ready);

  return (
    <section aria-labelledby="your-ais-heading" className={className}>
      <div className="pt-8 pb-2">
        <h2 id="your-ais-heading" className="font-semibold text-foreground text-lg">
          Your AIs
        </h2>
        <div className="mt-2 border-border border-b" />
      </div>
      <p className="py-2 text-muted-foreground text-sm">AIs you made act for you here. You can end an AI&apos;s access at any time.</p>

      {state.status === "loading" && (
        <div className="space-y-3 py-3" aria-busy="true" aria-label="Loading your AIs">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      )}

      {state.status === "unavailable" && (
        <p className="flex items-center gap-3 py-3 text-destructive text-sm" aria-live="polite">
          {UNAVAILABLE_COPY}
          <button type="button" className="text-foreground underline" onClick={() => void owner.reload()}>
            Try again
          </button>
        </p>
      )}

      {claim && claim.state === "open" && (
        <div id={claim.claimId === highlightId ? `claim-${claim.claimId}` : undefined} className={`mb-3 flex items-center justify-between gap-4 rounded-md border border-border p-3 ${HIGHLIGHT_CLASS}`}>
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground text-sm">&ldquo;{claim.agentName ?? "An AI"}&rdquo; asks to be your AI</div>
            <div className="text-muted-foreground text-xs">If you claim it, you can turn on what it may do for you, and end its access at any time.</div>
          </div>
          {busy === "claim" ? <Skeleton className="h-8 w-20" /> : (
            <Button size="sm" disabled={busy !== null} onClick={() => void owner.completeClaim()}>
              Claim
            </Button>
          )}
        </div>
      )}
      {claim && claim.state !== "open" && (
        <p className="mb-3 text-muted-foreground text-sm">
          {claim.state === "expired" ? "This link expired. Ask your AI for a new one." : claim.state === "claimed" ? "This link was already used." : "This AI already has an owner."}
        </p>
      )}

      {error && (
        <p className="pb-2 text-destructive text-sm" aria-live="polite">
          {error}
        </p>
      )}

      {ready && asks.length > 0 && (
        <div className="py-2">
          <h3 className="pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">Asks waiting</h3>
          <ul className="divide-y divide-border">
            {asks.map((row) => (
              <AskRow key={row.requestId} row={row} highlighted={row.requestId === highlightId} saving={busy === row.requestId} locked={busy !== null} owner={owner} />
            ))}
          </ul>
        </div>
      )}

      {ready && (
        <div className="py-2">
          <h3 className="pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">Your AIs</h3>
          {state.agents.length === 0 ? (
            <p className="py-2 text-muted-foreground text-sm">You have not added an AI yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {state.agents.map((ai) => (
                <li key={ai.agentId} className="py-3">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-foreground text-sm">{ai.name}</div>
                      <div className="text-muted-foreground text-xs">
                        Added {new Date(ai.createdAt).toLocaleDateString()} · {KEY_STATE_TEXT[ai.keyState]}
                      </div>
                    </div>
                    {(ai.keyState === "active" || ai.keyState === "pending") &&
                      (busy === `agent:${ai.agentId}` ? (
                        <Skeleton className="h-8 w-16" />
                      ) : (
                        <Button variant="outline" size="sm" disabled={busy !== null} aria-label={`Revoke ${ai.name}`} onClick={() => void owner.revokeAi(ai.agentId)}>
                          Revoke
                        </Button>
                      ))}
                  </div>
                  <ul className="pt-1">
                    {live
                      .filter((p) => p.principalUserId === ai.agentId)
                      .map((p) => (
                        <LiveRow key={p.requestId} row={p} highlighted={p.requestId === highlightId} saving={busy === p.requestId} locked={busy !== null} owner={owner} />
                      ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {setupLine && (
        <div className="my-2 space-y-2 rounded-md border border-border p-3">
          <p className="text-foreground text-sm">Give this line to your AI. It works once and is shown only now.</p>
          <div className="flex items-start gap-2">
            <textarea
              readOnly
              aria-label="Setup line for your AI"
              value={setupLine}
              rows={4}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
            />
            <CopyTextButton text={setupLine} label="Copy setup line" />
          </div>
          <Button variant="ghost" size="sm" onClick={owner.dismissSetupLine}>
            Done
          </Button>
        </div>
      )}

      {ready && (
        <div className="pt-3 pb-2">
          {busy === "add" ? (
            <Skeleton className="h-9 w-28" />
          ) : (
            <Button variant="outline" disabled={busy !== null || state.grantsLeft === 0} onClick={() => void owner.addAi()}>
              Add an AI
            </Button>
          )}
          <p className="pt-2 text-muted-foreground text-xs">Already running an AI? Tell it to claim itself on this node, then open the link it gives you.</p>
        </div>
      )}
    </section>
  );
}

type RowProps = {
  readonly row: YourAiPermissionView;
  readonly highlighted: boolean;
  readonly saving: boolean;
  readonly locked: boolean;
  readonly owner: ReturnType<typeof useOwnerAccess>;
};

function AskRow({ row, highlighted, saving, locked, owner }: RowProps): ReactElement {
  return (
    <li id={`ask-${row.requestId}`} aria-busy={saving || undefined} className={`flex items-center justify-between gap-4 py-3 ${highlighted ? HIGHLIGHT_CLASS : ""}`}>
      <div className="min-w-0">
        <div className="text-foreground text-sm">
          &ldquo;{row.who}&rdquo; asks to: {row.label}
        </div>
        <div className="text-muted-foreground text-xs">{row.description}</div>
      </div>
      {saving ? (
        <>
          <Skeleton className="h-8 w-28" />
          <span className="sr-only" role="status">Saving</span>
        </>
      ) : (
        <div className="flex shrink-0 gap-2">
          <Button size="sm" disabled={locked} onClick={() => void owner.decide(row.requestId, "approve")}>
            Approve
          </Button>
          <Button variant="outline" size="sm" disabled={locked} onClick={() => void owner.decide(row.requestId, "deny")}>
            Deny
          </Button>
        </div>
      )}
    </li>
  );
}

function LiveRow({ row, highlighted, saving, locked, owner }: RowProps): ReactElement {
  return (
    <li id={`ask-${row.requestId}`} aria-busy={saving || undefined} className={`flex items-center justify-between gap-4 py-1.5 ${highlighted ? HIGHLIGHT_CLASS : ""}`}>
      <div className="min-w-0">
        <div className="text-foreground text-sm">{row.label}</div>
        <div className="text-muted-foreground text-xs">
          {row.description}
          {row.until ? ` Ends ${new Date(row.until).toLocaleDateString()}.` : ""}
        </div>
      </div>
      {saving ? (
        <>
          <Skeleton className="h-5 w-9 rounded-full" />
          <span className="sr-only" role="status">Saving</span>
        </>
      ) : (
        <Switch on label={`${row.who}: ${row.label}`} locked={locked} onToggle={() => void owner.turnOff(row.principalUserId, row.scope, row.requestId)} />
      )}
    </li>
  );
}

/** The standard copy control (same markup as the knowledge table's copy-link button), for text that is not a link. */
function CopyTextButton({ text, label }: { text: string; label: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context or denied): the text stays selectable in the field.
    }
  };
  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      title={copied ? "Copied!" : label}
      aria-label={label}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}
