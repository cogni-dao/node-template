// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/chat/hooks/chat-session.client`
 * Purpose: Durable same-tab chat draft and in-flight request state.
 * Scope: Browser sessionStorage only. No network calls or React state.
 * Invariants: IDs are allocated before send; a pending envelope is immutable across retries.
 * Side-effects: sessionStorage reads/writes (quota/security failures are intentionally non-fatal).
 * Links: ChatRuntimeProvider.client.tsx
 * @internal
 */

import type { GraphId, ModelRef } from "@cogni/ai-core";

const STORAGE_PREFIX = "cogni.chat.v1";
const MAX_DRAFT_CHARS = 20_000;
const NEW_THREAD_KEY = `${STORAGE_PREFIX}.new-thread`;

export type ChatRunPhase =
  | "idle"
  | "saving"
  | "queued"
  | "running"
  | "reconnecting"
  | "failed";

export interface PendingChatEnvelope {
  stateKey: string;
  messageId: string;
  runId: string;
  /** Present until durable acceptance; removed before accepted state is stored. */
  message?: string;
  modelRef: ModelRef;
  graphName: GraphId;
  createdAt: string;
  /** Last acknowledged Redis stream ID received from data-run-cursor. */
  cursor?: string;
  /** True only after X-State-Key and X-Run-Id acknowledge durable acceptance. */
  accepted?: boolean;
}

export interface ChatSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function shouldLoadExistingThread(
  pending: PendingChatEnvelope | null
): boolean {
  return pending == null || pending.accepted === true;
}

export function acceptPendingEnvelope(
  envelope: PendingChatEnvelope
): PendingChatEnvelope {
  const { message: _acceptedPrompt, ...accepted } = envelope;
  return { ...accepted, accepted: true };
}

export function createReconnectRequest(envelope: PendingChatEnvelope): {
  api: string;
  headers?: { "Last-Event-ID": string };
} {
  return {
    api: `/api/v1/ai/runs/${encodeURIComponent(envelope.runId)}/ui-stream`,
    ...(envelope.cursor
      ? { headers: { "Last-Event-ID": envelope.cursor } }
      : {}),
  };
}

function draftKey(stateKey: string): string {
  return `${STORAGE_PREFIX}.draft.${stateKey}`;
}

function pendingKey(stateKey: string): string {
  return `${STORAGE_PREFIX}.pending.${stateKey}`;
}

function browserStorage(): ChatSessionStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readNewThreadStateKey(
  storage: ChatSessionStorage | null = browserStorage()
): string | null {
  try {
    const value = storage?.getItem(NEW_THREAD_KEY) ?? null;
    return value && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeNewThreadStateKey(
  stateKey: string,
  storage: ChatSessionStorage | null = browserStorage()
): boolean {
  try {
    storage?.setItem(NEW_THREAD_KEY, stateKey);
    return storage != null;
  } catch {
    return false;
  }
}

export function clearNewThreadStateKey(
  stateKey: string,
  storage: ChatSessionStorage | null = browserStorage()
): void {
  try {
    if (storage?.getItem(NEW_THREAD_KEY) === stateKey) {
      storage.removeItem(NEW_THREAD_KEY);
    }
  } catch {
    // Best-effort pointer only; the keyed draft remains safe.
  }
}

export function createChatIds(generateId?: () => string): Pick<
  PendingChatEnvelope,
  "stateKey" | "messageId" | "runId"
>;
export function createChatIds(
  generateId: () => string = () => crypto.randomUUID()
): Pick<PendingChatEnvelope, "stateKey" | "messageId" | "runId"> {
  return {
    stateKey: generateId(),
    messageId: generateId(),
    runId: generateId(),
  };
}

export function createPendingEnvelope(input: {
  stateKey: string;
  message: string;
  modelRef: ModelRef;
  graphName: GraphId;
  now?: Date;
  generateId?: () => string;
}): PendingChatEnvelope {
  const generateId = input.generateId ?? (() => crypto.randomUUID());
  return {
    stateKey: input.stateKey,
    messageId: generateId(),
    runId: generateId(),
    message: input.message,
    modelRef: input.modelRef,
    graphName: input.graphName,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}

export function readChatDraft(
  stateKey: string,
  storage: ChatSessionStorage | null = browserStorage()
): string {
  if (!storage) return "";
  try {
    return storage.getItem(draftKey(stateKey)) ?? "";
  } catch {
    return "";
  }
}

export function writeChatDraft(
  stateKey: string,
  draft: string,
  storage: ChatSessionStorage | null = browserStorage()
): boolean {
  if (!storage) return false;
  try {
    if (!draft) {
      storage.removeItem(draftKey(stateKey));
      return true;
    }
    storage.setItem(draftKey(stateKey), draft.slice(0, MAX_DRAFT_CHARS));
    return true;
  } catch {
    return false;
  }
}

export function clearChatDraft(
  stateKey: string,
  storage: ChatSessionStorage | null = browserStorage()
): void {
  try {
    storage?.removeItem(draftKey(stateKey));
  } catch {
    // Draft durability is best-effort when storage is unavailable or full.
  }
}

export function readPendingEnvelope(
  stateKey: string,
  storage: ChatSessionStorage | null = browserStorage()
): PendingChatEnvelope | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(pendingKey(stateKey));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingChatEnvelope>;
    if (
      value.stateKey !== stateKey ||
      typeof value.messageId !== "string" ||
      typeof value.runId !== "string" ||
      typeof value.createdAt !== "string" ||
      typeof value.modelRef !== "object" ||
      value.modelRef == null ||
      typeof value.graphName !== "string"
    ) {
      return null;
    }
    if (!value.accepted && typeof value.message !== "string") return null;
    return value as PendingChatEnvelope;
  } catch {
    return null;
  }
}

export function writePendingEnvelope(
  envelope: PendingChatEnvelope,
  storage: ChatSessionStorage | null = browserStorage()
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(pendingKey(envelope.stateKey), JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}

export function clearPendingEnvelope(
  stateKey: string,
  storage: ChatSessionStorage | null = browserStorage()
): void {
  try {
    storage?.removeItem(pendingKey(stateKey));
  } catch {
    // Pending state is best-effort when storage is unavailable.
  }
}
