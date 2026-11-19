// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/ai/stream-heartbeat`
 * Purpose: Keep a chat stream open while a long tool call or model call sends no bytes.
 * Scope: Writes one transient `data-heartbeat` chunk every interval until stopped. Does not change message content.
 * Invariants:
 *   - TRANSIENT_ONLY: heartbeats are never part of the assistant message or thread history.
 *   - UNDER_PROXY_IDLE: the 15 s interval sits well under common proxy idle timeouts (nginx 60 s, Cloudflare 100 s),
 *     as Anthropic's SSE `ping` events do.
 * Side-effects: timers; writes UIMessageChunks through the caller's writer
 * Links: bug.0059, https://platform.claude.com/docs/en/build-with-claude/streaming
 * @internal
 */

import type { UIMessageChunk } from "ai";

export const STREAM_HEARTBEAT_MS = 15_000;

/** Starts heartbeats on `writer`; call the returned function to stop. Write errors stop it quietly. */
export function startStreamHeartbeat(
  writer: { write: (chunk: UIMessageChunk) => void },
  intervalMs: number = STREAM_HEARTBEAT_MS
): () => void {
  const timer = setInterval(() => {
    try {
      writer.write({
        type: "data-heartbeat",
        data: { at: Date.now() },
        transient: true,
      } as UIMessageChunk);
    } catch {
      clearInterval(timer);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
