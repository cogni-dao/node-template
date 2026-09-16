// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_lib/ai/durable-chat-terminal`
 * Purpose: Enforce assistant transcript durability before exposing terminal chat success.
 * Scope: Idempotent bounded persistence followed by a caller-provided terminal publication.
 * Invariants: Stateful success cannot publish terminal done before persistence; headless runs publish directly.
 * Side-effects: thread persistence and terminal publication callbacks
 * @internal
 */

import type { AiEvent } from "@cogni/ai-core";
import { toUserId } from "@cogni/ids";
import { assembleAssistantMessage, redactSecretsInMessages } from "@/features/ai/public.server";
import { ThreadConflictError, type ThreadPersistencePort } from "@/ports";

interface DurableChatTerminalInput {
  readonly runId: string;
  readonly stateKey?: string;
  readonly actorUserId?: string;
  readonly accumulatedEvents: readonly AiEvent[];
  readonly threadPersistenceForUser: (actorId: ReturnType<typeof toUserId>) => ThreadPersistencePort;
  readonly publishTerminal: () => Promise<void>;
  readonly onPersisted?: (result: {
    messageCount: number;
    attempt: number;
  }) => void;
  readonly maxAttempts?: number;
  readonly terminalPublishTimeoutMs?: number;
}

const DEFAULT_TERMINAL_PUBLISH_TIMEOUT_MS = 5_000;

export class TerminalPublicationError extends Error {
  constructor(cause: unknown) {
    super("Terminal stream publication failed", { cause });
    this.name = "TerminalPublicationError";
  }
}

async function publishTerminalBounded(
  publish: () => Promise<void>,
  timeoutMs: number
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      publish(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Terminal publication timed out")),
          timeoutMs
        );
      }),
    ]);
  } catch (cause) {
    throw new TerminalPublicationError(cause);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function persistAssistantThenPublishTerminal(
  input: DurableChatTerminalInput
): Promise<{ persisted: boolean; messageCount?: number; attempt?: number }> {
  let result: { persisted: boolean; messageCount?: number; attempt?: number } = {
    persisted: false,
  };

  if (input.stateKey && input.actorUserId) {
    const assistant = assembleAssistantMessage(
      input.runId,
      input.accumulatedEvents
    );
    if (!assistant) {
      throw new Error("Stateful successful run completed without assistant_final");
    }
    const persistence = input.threadPersistenceForUser(
      toUserId(input.actorUserId)
    );
    const maxAttempts = input.maxAttempts ?? 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const existing = await persistence.loadThread(
        input.actorUserId,
        input.stateKey
      );
      if (existing.some((message) => message.id === assistant.id)) {
        result = { persisted: true, messageCount: existing.length, attempt };
        break;
      }
      try {
        await persistence.saveThread(
          input.actorUserId,
          input.stateKey,
          redactSecretsInMessages([...existing, assistant]),
          existing.length
        );
        result = {
          persisted: true,
          messageCount: existing.length + 1,
          attempt,
        };
        break;
      } catch (error) {
        if (!(error instanceof ThreadConflictError) || attempt === maxAttempts) {
          throw error;
        }
      }
    }
    if (result.persisted && result.messageCount && result.attempt) {
      input.onPersisted?.({
        messageCount: result.messageCount,
        attempt: result.attempt,
      });
    }
  }

  await publishTerminalBounded(
    input.publishTerminal,
    input.terminalPublishTimeoutMs ?? DEFAULT_TERMINAL_PUBLISH_TIMEOUT_MS
  );
  return result;
}
