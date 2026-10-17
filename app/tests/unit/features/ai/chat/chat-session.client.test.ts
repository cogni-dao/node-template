// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/ai/chat/chat-session.client`
 * Purpose: Proves stable chat identity, safe storage, prompt purge, and replay transport inputs.
 * Scope: Pure unit tests with an in-memory Storage fake; no browser or network IO.
 * Invariants: Exact retries retain IDs; accepted storage does not retain prompt text.
 * Side-effects: none
 * @internal
 */

import type { GraphId, ModelRef } from "@cogni/ai-core";
import { describe, expect, it } from "vitest";

import {
  acceptPendingEnvelope,
  type ChatSessionStorage,
  createChatIds,
  createPendingEnvelope,
  createReconnectRequest,
  readNewThreadStateKey,
  readChatDraft,
  readPendingEnvelope,
  shouldLoadExistingThread,
  writeChatDraft,
  writePendingEnvelope,
  writeNewThreadStateKey,
} from "@/features/ai/chat/hooks/chat-session.client";

class MemoryStorage implements ChatSessionStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

const modelRef = {
  providerKey: "platform",
  modelId: "test-model",
} as ModelRef;
const graphName = "langgraph:default" as GraphId;

function envelope(storage?: MemoryStorage) {
  let sequence = 0;
  const pending = createPendingEnvelope({
    stateKey: "thread-1",
    message: "private prompt",
    modelRef,
    graphName,
    now: new Date("2026-09-15T00:00:00.000Z"),
    generateId: () => `stable-${++sequence}`,
  });
  if (storage) writePendingEnvelope(pending, storage);
  return pending;
}

describe("chat session durability", () => {
  it("allocates every identity before send", () => {
    let sequence = 0;
    expect(createChatIds(() => `id-${++sequence}`)).toEqual({
      stateKey: "id-1",
      messageId: "id-2",
      clientRunSeed: "id-3",
    });
  });

  it("round-trips an unaccepted envelope for an exact retry", () => {
    const storage = new MemoryStorage();
    const pending = envelope(storage);
    expect(readPendingEnvelope("thread-1", storage)).toEqual(pending);
    expect(shouldLoadExistingThread(pending)).toBe(false);
    expect(
      shouldLoadExistingThread(
        acceptPendingEnvelope(
          pending,
          "00000000-0000-4000-8000-000000000000"
        )
      )
    ).toBe(true);
    expect(shouldLoadExistingThread(null)).toBe(true);
  });

  it("loads durable history before restoring an unaccepted follow-up", () => {
    const pending = createPendingEnvelope({
      stateKey: "existing-thread",
      message: "follow up",
      modelRef,
      graphName,
      hasDurableHistory: true,
      generateId: () => "stable-id",
    });

    expect(shouldLoadExistingThread(pending)).toBe(true);
  });

  it("purges prompt text after durable acceptance but retains replay identity", () => {
    const storage = new MemoryStorage();
    const accepted = acceptPendingEnvelope(
      envelope(),
      "11111111-1111-4111-8111-111111111111"
    );
    writePendingEnvelope(accepted, storage);

    const restored = readPendingEnvelope("thread-1", storage);
    expect(restored).toMatchObject({
      messageId: "stable-1",
      clientRunSeed: "stable-2",
      runId: "11111111-1111-4111-8111-111111111111",
      accepted: true,
    });
    expect(restored).not.toHaveProperty("message");
    expect(JSON.stringify(restored)).not.toContain("private prompt");
  });

  it("builds the UI-message replay request with the last cursor", () => {
    expect(
      createReconnectRequest(
        acceptPendingEnvelope(
          envelope(),
          "22222222-2222-4222-8222-222222222222"
        ),
        "42-7"
      )
    ).toEqual({
      api: "/api/v1/ai/runs/22222222-2222-4222-8222-222222222222/ui-stream",
      headers: { "Last-Event-ID": "42-7" },
    });
  });

  it("keeps the client seed for POST retry but reconnects with the server ID", () => {
    const pending = envelope();
    const accepted = acceptPendingEnvelope(
      pending,
      "33333333-3333-4333-8333-333333333333"
    );
    expect(accepted.clientRunSeed).toBe(pending.clientRunSeed);
    expect(accepted.runId).not.toBe(accepted.clientRunSeed);
    expect(createReconnectRequest(accepted).api).toContain(accepted.runId);
  });

  it("caps drafts and treats quota failures as non-fatal", () => {
    const storage = new MemoryStorage();
    expect(writeChatDraft("thread-1", "x".repeat(30_000), storage)).toBe(true);
    expect(readChatDraft("thread-1", storage)).toHaveLength(20_000);

    const fullStorage: ChatSessionStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem: () => undefined,
    };
    expect(writeChatDraft("thread-1", "kept in memory", fullStorage)).toBe(false);
  });

  it("keeps the unsent new-thread identity across same-tab navigation", () => {
    const storage = new MemoryStorage();
    expect(writeNewThreadStateKey("draft-thread", storage)).toBe(true);
    expect(readNewThreadStateKey(storage)).toBe("draft-thread");
  });
});
