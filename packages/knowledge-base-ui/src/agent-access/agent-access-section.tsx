// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/agent-access/agent-access-section`
 * Purpose: "This node's AI": a DAO admin allows or removes each node AI's jobs by clicking.
 * Scope: Presentation over `useAgentAccess`. Renders nothing for a non-admin. One card per AI; each job is a row with
 *   the label above a full-width button, so the layout holds at 360px. Allow asks once (Confirm); Remove never asks.
 * Invariants:
 *   - NON_ADMIN_SEES_NOTHING: renders `null` while loading and for every state except a confirmed admin view (`ready`)
 *     or a confirmed 503 (`unavailable`). No heading, rule or skeleton shows to a non-admin, except the accepted 503 alert
 *     (the page cannot tell who is an admin while the check is down).
 *   - Focus stays on the row: after Allow, Confirm, Cancel or Remove the row's button gets focus again.
 *   - HUMAN_SURFACE_TOKENLESS: the text holds no token, id, key, scope string or API path.
 *   - Buttons are at least 40px tall (Button size "lg").
 * Side-effects: IO (through the hook)
 * Links: https://cognidao.org/knowledge/ai-access-surface-design
 * @public
 */

"use client";

import type { JobRisk, NodeAiJobView, NodeAiView } from "@cogni/agent-grants";
import { useEffect, useRef, useState } from "react";

import { Alert } from "../ui/alert.js";
import { Button } from "../ui/button.js";
import { Chip } from "../ui/chip.js";
import {
  type AgentAccessEndpoints,
  UNAVAILABLE_COPY,
  useAgentAccess,
} from "./use-agent-access.js";

const RISK_COPY: Record<JobRisk, { text: string; tone: "neutral" | "warning" | "danger" }> = {
  low: { text: "Low risk", tone: "neutral" },
  medium: { text: "Medium risk", tone: "warning" },
  high: { text: "High risk", tone: "danger" },
};

export interface AgentAccessSectionProps {
  readonly endpoints: AgentAccessEndpoints;
  readonly className?: string;
}

export function AgentAccessSection({ endpoints, className }: AgentAccessSectionProps) {
  const { state, busy, error, allow, remove, reload } = useAgentAccess(endpoints);
  const [confirming, setConfirming] = useState<string | null>(null);
  // Focus follows the row through Allow -> Confirm -> Remove (the button unmounts each time). Refs, not DOM attributes,
  // so no scope string or id lands in the page.
  const rows = useRef(new Map<string, HTMLElement>());
  const [focusRow, setFocusRow] = useState<string | null>(null);
  useEffect(() => {
    if (focusRow === null) return;
    rows.current.get(focusRow)?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    setFocusRow(null);
  }, [focusRow, state]);

  // No flash: nothing renders until the server confirms an admin view or a 503.
  if (state.status === "hidden" || state.status === "loading") return null;

  return (
    <section aria-labelledby="node-ai-heading" className={className}>
      <div className="pt-8 pb-2">
        <h2 id="node-ai-heading" className="font-semibold text-foreground text-lg">
          This node&apos;s AI
        </h2>
        <p className="mt-1 text-muted-foreground text-sm">
          Choose which jobs each assistant may do for this node.
        </p>
        <div className="mt-2 border-border border-b" />
      </div>

      {state.status === "unavailable" && (
        <div className="space-y-3 py-4">
          <Alert variant="destructive">{UNAVAILABLE_COPY}</Alert>
          <Button size="lg" variant="outline" className="w-full sm:w-auto" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      )}

      {state.status === "ready" && (
        <div className="space-y-4 py-4">
          {error && <Alert variant="destructive">{error}</Alert>}
          {state.view.ai.length === 0 && (
            <p className="text-muted-foreground text-sm">This node has no assistants to manage yet.</p>
          )}
          {state.view.ai.map((ai) => (
            <AiCard
              key={ai.principal}
              ai={ai}
              busy={busy}
              confirming={confirming}
              rows={rows.current}
              onAsk={setConfirming}
              onCancel={(key) => {
                setConfirming(null);
                setFocusRow(key);
              }}
              onAllow={async (job) => {
                setConfirming(null);
                await allow(ai.principal, job.scope);
                setFocusRow(`${ai.principal}|${job.scope}`);
              }}
              onRemove={async (job) => {
                await remove(ai.principal, job.scope);
                setFocusRow(`${ai.principal}|${job.scope}`);
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** "Update work items" -> "update work items": the job label, as it reads after a verb. */
const afterVerb = (label: string) => `${label.charAt(0).toLowerCase()}${label.slice(1)}`;

function AiCard(props: {
  ai: NodeAiView;
  busy: string | null;
  confirming: string | null;
  rows: Map<string, HTMLElement>;
  onAsk: (key: string) => void;
  onCancel: (key: string) => void;
  onAllow: (job: NodeAiJobView) => Promise<void>;
  onRemove: (job: NodeAiJobView) => Promise<void>;
}) {
  const { ai, busy, confirming, rows, onAsk, onCancel, onAllow, onRemove } = props;
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="font-medium text-foreground">{ai.name}</h3>
      <p className="text-muted-foreground text-sm">{ai.blurb}</p>
      <ul className="mt-3 divide-y divide-border">
        {ai.jobs.map((job) => {
          const key = `${ai.principal}|${job.scope}`;
          const anyBusy = busy !== null; // one click at a time: no two jobs clobber each other
          const risk = RISK_COPY[job.risk];
          return (
            <li
              key={key}
              ref={(el) => {
                if (el) rows.set(key, el);
                else rows.delete(key);
              }}
              className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0"
            >
              <div className="min-w-0">
                <div className="font-medium text-foreground text-sm">{job.label}</div>
                <div className="mt-1 flex flex-wrap gap-2">
                  <Chip tone={risk.tone}>{risk.text}</Chip>
                  {job.allowed && <Chip tone="success">Allowed</Chip>}
                </div>
              </div>
              {job.allowed ? (
                <Button
                  size="lg"
                  variant="destructive"
                  className="w-full"
                  disabled={anyBusy}
                  aria-label={`Remove ${ai.name}: ${job.label}`}
                  onClick={() => void onRemove(job)}
                >
                  Remove
                </Button>
              ) : confirming === key ? (
                <div className="space-y-3 rounded-md border border-border bg-muted/40 p-3">
                  <p className="text-foreground text-sm">
                    Let {ai.name} {afterVerb(job.label)}?
                  </p>
                  <div className="flex flex-col gap-2">
                    <Button
                      size="lg"
                      className="w-full"
                      autoFocus
                      disabled={anyBusy}
                      aria-label={`Confirm: let ${ai.name} ${afterVerb(job.label)}`}
                      onClick={() => void onAllow(job)}
                    >
                      Confirm
                    </Button>
                    <Button
                      size="lg"
                      variant="ghost"
                      className="w-full"
                      aria-label={`Cancel: do not let ${ai.name} ${afterVerb(job.label)}`}
                      onClick={() => onCancel(key)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  size="lg"
                  className="w-full"
                  disabled={anyBusy}
                  aria-label={`Allow ${ai.name} to ${afterVerb(job.label)}`}
                  onClick={() => onAsk(key)}
                >
                  Allow
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
