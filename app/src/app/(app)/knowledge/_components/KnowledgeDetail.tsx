// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/KnowledgeDetail`
 * Purpose: Slide-over Sheet that renders a single knowledge entry's full content,
 *   with a copy-link affordance to the entry's permalink. Body shared with the
 *   routable `/knowledge/[id]` page via `KnowledgeEntryBody`, so a metric shows
 *   its chart and brief here too.
 * Scope: Pure presentation; no fetching.
 * @internal
 */

"use client";

import { KnowledgeUseWhen } from "@cogni/knowledge-base-ui";
import type { ReactElement } from "react";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components";
import { CopyLinkButton } from "./CopyLinkButton";
import { type KnowledgeEntry, KnowledgeEntryBody } from "./KnowledgeEntryBody";

interface KnowledgeDetailProps {
  readonly loading?: boolean;
  readonly error?: unknown;
  readonly onRetry?: () => void;
  readonly item: KnowledgeEntry | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function KnowledgeDetail({
  item,
  loading,
  error,
  onRetry,
  open,
  onOpenChange,
}: KnowledgeDetailProps): ReactElement {
  const isHtml = item?.entryType === "html";
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className={
          isHtml
            ? "w-full overflow-y-auto sm:max-w-4xl"
            : "w-full overflow-y-auto sm:max-w-lg"
        }
      >
        {!item && (
          <SheetHeader>
            <SheetTitle>Knowledge entry</SheetTitle>
          </SheetHeader>
        )}
        {error ? (
          <p role="alert">
            Could not load this entry.{" "}
            <button type="button" onClick={onRetry}>
              Retry
            </button>
          </p>
        ) : loading && !item ? (
          <p role="status">Loading entry…</p>
        ) : null}
        {item && (
          <>
            <SheetHeader>
              <span className="font-mono text-muted-foreground text-xs">
                {item.domain}
                {item.entityId ? ` · ${item.entityId}` : ""}
              </span>
              <SheetTitle className="text-lg leading-snug">
                {item.title}
              </SheetTitle>
              <KnowledgeUseWhen
                useWhen={item.useWhen}
                className="text-muted-foreground text-sm leading-relaxed [&>span]:font-medium"
              />
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-muted-foreground text-xs">
                  {item.id}
                </span>
                <CopyLinkButton
                  path={`/knowledge/${item.id}`}
                  label="Copy block link"
                />
              </div>
            </SheetHeader>

            <div className="mt-6 flex flex-col gap-4">
              <KnowledgeEntryBody item={item} />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
