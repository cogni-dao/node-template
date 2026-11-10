// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

"use client";

import {
  type CSSProperties,
  type ReactElement,
  useMemo,
  useSyncExternalStore,
} from "react";

/**
 * The only sandbox capability granted to authored knowledge HTML.
 * Navigation still requires an explicit user activation.
 */
export const KNOWLEDGE_HTML_SANDBOX =
  "allow-top-navigation-by-user-activation" as const;

/**
 * Normalize authored anchors before they enter the opaque-origin iframe.
 * Authored bases/targets are untrusted; only resolved HTTP(S) URLs may leave it.
 */
export function normalizeKnowledgeHtmlNavigation(
  documentHtml: string,
  parentUrl: string
): string {
  const document = new DOMParser().parseFromString(documentHtml, "text/html");

  document.querySelectorAll("base").forEach((base) => {
    base.remove();
  });
  document.querySelectorAll<HTMLAnchorElement>("a").forEach((anchor) => {
    const authoredHref = anchor.getAttribute("href");
    if (!authoredHref) return;

    let resolved: URL;
    try {
      resolved = new URL(authoredHref, parentUrl);
    } catch {
      anchor.removeAttribute("href");
      anchor.removeAttribute("target");
      return;
    }

    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      anchor.removeAttribute("href");
      anchor.removeAttribute("target");
      return;
    }

    anchor.href = resolved.href;
    anchor.target = "_top";
    anchor.rel = "noopener noreferrer";
  });

  const doctype = document.doctype
    ? `<!doctype ${document.doctype.name}>\n`
    : "";
  const htmlElement = document.querySelector("html");
  return htmlElement ? `${doctype}${htmlElement.outerHTML}` : documentHtml;
}

export interface KnowledgeHtmlFrameProps {
  readonly documentHtml: string;
  readonly title: string;
  readonly className?: string;
  readonly busy?: boolean;
}

/**
 * Default frame height. A node may set `--height-artifact-canvas`; nodes that
 * never defined it would otherwise collapse the frame to the 150px iframe default.
 */
const FRAME_STYLE: CSSProperties = {
  height: "var(--height-artifact-canvas, 720px)",
};

const subscribeNever = () => () => {};
const onClient = () => true;
const onServer = () => false;

/** Small stable hash so a changed document always gets a fresh iframe. */
function documentKey(html: string): string {
  let hash = 5381;
  for (let i = 0; i < html.length; i++) {
    hash = ((hash << 5) + hash + html.charCodeAt(i)) | 0;
  }
  return `${html.length}:${hash >>> 0}`;
}

/**
 * Owns the security boundary shared by every node's knowledge renderer.
 *
 * FINAL_SRCDOC_AT_INSERT: the iframe is created with its final `srcdoc` and
 * never mutated. Chrome isolates sandboxed frames in their own process; a
 * `srcdoc` change while the first navigation is in flight commits an empty
 * document (the "black box"). A new document gets a new iframe instead.
 */
export function KnowledgeHtmlFrame({
  documentHtml,
  title,
  className,
  busy = false,
}: KnowledgeHtmlFrameProps): ReactElement {
  const isClient = useSyncExternalStore(subscribeNever, onClient, onServer);
  const srcDoc = useMemo(
    () =>
      isClient && documentHtml
        ? normalizeKnowledgeHtmlNavigation(documentHtml, window.location.href)
        : "",
    [isClient, documentHtml]
  );

  if (!srcDoc) {
    return (
      <div
        role="status"
        aria-label={title}
        aria-busy="true"
        className={className}
        style={FRAME_STYLE}
      />
    );
  }

  return (
    <iframe
      key={documentKey(srcDoc)}
      title={title}
      srcDoc={srcDoc}
      sandbox={KNOWLEDGE_HTML_SANDBOX}
      referrerPolicy="no-referrer"
      aria-busy={busy}
      className={className}
      style={FRAME_STYLE}
    />
  );
}
