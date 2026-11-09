// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-base-ui/knowledge-cells`
 * Purpose: Knowledge table cells every node renders: the confidence bar and the copy-permalink button (moved from node-template's app, task.0059).
 * Scope: Pure presentation plus a clipboard write. No fetching or routing.
 * Invariants:
 *   - CONFIDENCE_CLAMPED: 0–100; null renders the neutral placeholder. Anchors: < 30 draft · 30–60 candidate · 60–80 established · 80–95 canonical · 95+ hardened, all on the semantic CSS-var palette.
 *   - COPY_DOES_NOT_SELECT: the copy button stops propagation, so it lives inside a clickable row.
 * Side-effects: clipboard write (copy button)
 * Links: task.0059, docs/spec/knowledge-syntropy.md
 * @public
 */

"use client";

import { Check, Link2 } from "lucide-react";
import { type MouseEvent, type ReactElement, useState } from "react";

function toneFor(v: number): { fill: string; track: string; label: string } {
  if (v < 30)
    return { fill: "bg-muted-foreground/40", track: "bg-muted", label: "draft" };
  if (v < 60)
    return { fill: "bg-warning/80", track: "bg-warning/10", label: "candidate" };
  if (v < 80)
    return { fill: "bg-info/80", track: "bg-info/10", label: "established" };
  if (v < 95)
    return { fill: "bg-success/80", track: "bg-success/10", label: "canonical" };
  return { fill: "bg-primary/85", track: "bg-primary/10", label: "hardened" };
}

export interface ConfidenceBarProps {
  readonly value: number | null;
  readonly width?: number;
}

export function ConfidenceBar({
  value,
  width = 64,
}: ConfidenceBarProps): ReactElement {
  if (value == null) {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground text-xs">
        <span className="block h-1 rounded-full bg-muted/60" style={{ width }} />
        <span className="font-mono opacity-60">—</span>
      </span>
    );
  }
  const clamped = Math.max(0, Math.min(100, value));
  const { fill, track, label } = toneFor(clamped);
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs"
      title={`${label} · ${clamped}%`}
    >
      <span
        className={`relative block h-1 overflow-hidden rounded-full ${track}`}
        style={{ width }}
      >
        <span
          className={`absolute inset-y-0 left-0 ${fill}`}
          style={{ width: `${clamped}%` }}
        />
      </span>
      <span className="w-7 font-mono text-muted-foreground tabular-nums">
        {clamped}
      </span>
    </span>
  );
}

export interface CopyLinkButtonProps {
  /** App-relative path to the block, e.g. `/knowledge/<id>`; resolved against the live origin. */
  readonly path: string;
  readonly label?: string;
}

export function CopyLinkButton({
  path,
  label = "Copy link",
}: CopyLinkButtonProps): ReactElement {
  const [copied, setCopied] = useState(false);
  const onCopy = async (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    const url =
      typeof window !== "undefined"
        ? new URL(path, window.location.origin).toString()
        : path;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context or denied): no-op.
    }
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? "Copied!" : label}
      aria-label={label}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {copied ? (
        <Check className="size-3.5 text-success" />
      ) : (
        <Link2 className="size-3.5" />
      )}
    </button>
  );
}
