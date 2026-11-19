// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { UIMessageChunk } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startStreamHeartbeat } from "@/app/_lib/ai/stream-heartbeat";

describe("startStreamHeartbeat (bug.0059)", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps a silent stream alive with transient chunks until stopped", () => {
    vi.useFakeTimers();
    const chunks: UIMessageChunk[] = [];
    const stop = startStreamHeartbeat({ write: (c) => chunks.push(c) }, 15_000);

    vi.advanceTimersByTime(65_000);
    expect(chunks).toHaveLength(4);
    expect(chunks.every((c) => (c as { transient?: boolean }).transient === true)).toBe(true);

    stop();
    vi.advanceTimersByTime(60_000);
    expect(chunks).toHaveLength(4);
  });
});
