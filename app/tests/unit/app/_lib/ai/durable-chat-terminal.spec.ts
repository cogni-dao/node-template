// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/_lib/ai/durable-chat-terminal`
 * Purpose: Prove terminal success cannot outrun assistant transcript durability.
 * Scope: Pure coordinator with fake persistence and publication callbacks.
 * Invariants: delayed save delays done; failed save suppresses done.
 * Side-effects: none
 * @internal
 */

import type { ThreadPersistencePort } from "@/ports";
import { describe, expect, it, vi } from "vitest";
import { persistAssistantThenPublishTerminal } from "@/app/_lib/ai/durable-chat-terminal";

function persistenceWith(
  saveThread: ThreadPersistencePort["saveThread"]
): ThreadPersistencePort {
  return {
    loadThread: vi.fn().mockResolvedValue([]),
    saveThread,
    softDelete: vi.fn(),
    listThreads: vi.fn(),
  };
}

const inputBase = {
  runId: "123e4567-e89b-42d3-a456-426614174000",
  stateKey: "thread-1",
  actorUserId: "10000000-0000-4000-a000-000000000001",
  accumulatedEvents: [
    { type: "assistant_final" as const, content: "durable answer" },
  ],
};

describe("persistAssistantThenPublishTerminal", () => {
  it("does not publish terminal done until a delayed assistant save resolves", async () => {
    let releaseSave: (() => void) | undefined;
    const saveThread = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve;
        })
    );
    const publishTerminal = vi.fn().mockResolvedValue(undefined);
    const operation = persistAssistantThenPublishTerminal({
      ...inputBase,
      threadPersistenceForUser: () => persistenceWith(saveThread),
      publishTerminal,
    });

    await vi.waitFor(() => expect(saveThread).toHaveBeenCalledOnce());
    expect(publishTerminal).not.toHaveBeenCalled();
    releaseSave?.();
    await operation;
    expect(publishTerminal).toHaveBeenCalledOnce();
  });

  it("suppresses terminal done when assistant persistence fails", async () => {
    const publishTerminal = vi.fn().mockResolvedValue(undefined);
    const operation = persistAssistantThenPublishTerminal({
      ...inputBase,
      threadPersistenceForUser: () =>
        persistenceWith(vi.fn().mockRejectedValue(new Error("database down"))),
      publishTerminal,
    });

    await expect(operation).rejects.toThrow("database down");
    expect(publishTerminal).not.toHaveBeenCalled();
  });
});
