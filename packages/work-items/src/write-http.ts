// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/write-http`
 * Purpose: The work-item create and PATCH route core every node serves (bug.0063): parse, write, map each refusal, and return the one
 *   terminal log event, so every fork logs the same `work.items.{create,patch}_{success,refused}` lines.
 * Scope: Framework-free. A node route keeps auth, the session actor, its store call, its response codec and its logger; it logs the
 *   returned `event` and sends `body` with `status`. Unexpected errors are rethrown for the node's route wrapper.
 * Invariants:
 *   - ONE_TERMINAL_EVENT: every handled request returns exactly one event, success or refused, with ids and codes, never the body.
 *   - EVENT_NAMES_HERE: the four event names are owned here; a node's own name table repeats them only as these values.
 *   - PACKAGE_ERRORS_FIRST: `workItemWriteErrorResponse` answers every write-contract error and `backendUnavailableReason` every busy store (503 with `reason`); `mapNodeError` answers only node errors.
 * Side-effects: none (the injected write does the IO)
 * Links: ./write-errors.ts, hub work-gate-enforcement
 * @public
 */

import type { WriteAttribution, WriteRunKind } from "./attribution.js";
import type { WorkItemsBusyReason } from "./errors.js";
import { backendUnavailableBody, backendUnavailableReason } from "./read-handlers.js";
import { workItemWriteErrorResponse } from "./write-errors.js";

export const WORK_ITEM_WRITE_EVENTS = {
  createSuccess: "work.items.create_success",
  createRefused: "work.items.create_refused",
  patchSuccess: "work.items.patch_success",
  patchRefused: "work.items.patch_refused",
} as const;

export interface WorkItemWriteEvent {
  readonly event: (typeof WORK_ITEM_WRITE_EVENTS)[keyof typeof WORK_ITEM_WRITE_EVENTS];
  readonly routeId: "work.items.create" | "work.items.patch";
  readonly outcome: "success" | "refused";
  readonly status: number;
  readonly errorCode?: string;
  readonly workItemId?: string;
  readonly node?: string;
  readonly citeCount?: number;
  /** Who acted, who asked, which run (task.0133, hub activity-attribution): the host-built attribution of the write, ids only. A route write has the actor alone. */
  readonly actor?: string;
  readonly requestedBy?: string;
  readonly runId?: string;
  readonly runKind?: WriteRunKind;
  /** A refused stage move: the stages and the missing artifact or fact. */
  readonly from?: string;
  readonly to?: string;
  readonly missing?: string;
  /** A busy or unavailable store: why, from the closed set (task.0162). */
  readonly reason?: WorkItemsBusyReason;
}

export interface WorkItemWriteResult {
  readonly status: number;
  readonly body: unknown;
  readonly event: WorkItemWriteEvent;
}

/** A node's own refusal for an error the package does not know (not found, forbidden, admin required). */
export type NodeWriteRefusal = { readonly status: number; readonly errorCode: string; readonly body: unknown };

type Parse<T> = (body: unknown) =>
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: { readonly issues: readonly unknown[] } };

interface WriteDeps<T, R> {
  /** The request body; rejects on malformed JSON. */
  readonly readJson: () => Promise<unknown>;
  /** The node's contract parse (its create or PATCH input schema's `safeParse`). */
  readonly parse: Parse<T>;
  /** The node's store write, as the session actor. */
  readonly write: (input: T) => Promise<R>;
  /** The host-built attribution of this write (the session's caller for a route): its ids ride every terminal event, success and refused. */
  readonly attribution: WriteAttribution;
  /** The success body (the node's output codec). */
  readonly toBody: (result: R) => unknown;
  /** Node-only errors; anything still unknown is rethrown. */
  readonly mapNodeError?: (error: unknown) => NodeWriteRefusal | undefined;
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** The attribution's ids as event fields: the actor, then the requester and the run only when the write has them. */
const attributionEventFields = (attribution: WriteAttribution): Partial<WorkItemWriteEvent> => ({
  actor: attribution.actor,
  ...(attribution.requestedBy !== undefined ? { requestedBy: attribution.requestedBy } : {}),
  ...(attribution.run ? { runId: attribution.run.id, runKind: attribution.run.kind } : {}),
});

async function handleWrite<T, R>(
  kind: "create" | "patch",
  deps: WriteDeps<T, R>,
  pathId: string | undefined,
  successFields: (input: T, result: R) => Partial<WorkItemWriteEvent>,
): Promise<WorkItemWriteResult> {
  const routeId = kind === "create" ? "work.items.create" : "work.items.patch";
  const refusedEvent = kind === "create" ? WORK_ITEM_WRITE_EVENTS.createRefused : WORK_ITEM_WRITE_EVENTS.patchRefused;
  const refuse = (status: number, errorCode: string, body: unknown, extra: Partial<WorkItemWriteEvent> = {}): WorkItemWriteResult => ({
    status,
    body,
    event: {
      event: refusedEvent,
      routeId,
      outcome: "refused",
      status,
      errorCode,
      ...(pathId !== undefined ? { workItemId: pathId } : {}),
      ...attributionEventFields(deps.attribution),
      ...extra,
    },
  });

  let body: unknown;
  try {
    body = await deps.readJson();
  } catch {
    return refuse(400, "invalid_json", { error: "invalid JSON body" });
  }
  if (pathId !== undefined && typeof body === "object" && body !== null && "id" in body) {
    const bodyId = (body as { id?: unknown }).id;
    if (bodyId !== undefined && bodyId !== pathId) return refuse(400, "id_mismatch", { error: "body id must match path id" });
  }
  const parsed = deps.parse(
    pathId !== undefined ? { ...(typeof body === "object" && body !== null ? body : {}), id: pathId } : body,
  );
  if (!parsed.success) return refuse(400, "invalid_input", { error: "invalid input", issues: parsed.error.issues });

  try {
    const result = await deps.write(parsed.data);
    const status = kind === "create" ? 201 : 200;
    return {
      status,
      body: deps.toBody(result),
      event: {
        event: kind === "create" ? WORK_ITEM_WRITE_EVENTS.createSuccess : WORK_ITEM_WRITE_EVENTS.patchSuccess,
        routeId,
        outcome: "success",
        status,
        ...(pathId !== undefined ? { workItemId: pathId } : {}),
        ...attributionEventFields(deps.attribution),
        ...successFields(parsed.data, result),
      },
    };
  } catch (error) {
    const mapped = workItemWriteErrorResponse(error, kind);
    if (mapped) {
      const gate = mapped.body as { from?: unknown; to?: unknown; missing?: unknown };
      const from = text(gate.from);
      const to = text(gate.to);
      const missing = text(gate.missing);
      return refuse(mapped.status, mapped.errorCode, mapped.body, {
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(missing ? { missing } : {}),
      });
    }
    // A busy or unavailable store is a package error too: 503 with its closed reason on the one terminal event.
    const reason = backendUnavailableReason(error);
    if (reason) return refuse(503, "backend_unavailable", backendUnavailableBody(reason), { reason });
    const node = deps.mapNodeError?.(error);
    if (node) return refuse(node.status, node.errorCode, node.body);
    throw error;
  }
}

/** POST /work/items: parse, create, and the one terminal event. */
export function handleWorkItemCreate<T, R extends { readonly id: string; readonly node?: string | null | undefined }>(
  deps: WriteDeps<T, R>,
): Promise<WorkItemWriteResult> {
  return handleWrite("create", deps, undefined, (_input, created) => ({
    workItemId: created.id,
    ...(created.node ? { node: created.node } : {}),
  }));
}

/** PATCH /work/items/{id}: the path id is authoritative; parse, patch, and the one terminal event. */
export function handleWorkItemPatch<T extends { readonly cites?: readonly unknown[] | undefined }, R>(
  id: string,
  deps: WriteDeps<T, R>,
): Promise<WorkItemWriteResult> {
  return handleWrite("patch", deps, id, (input) => ({ citeCount: input.cites?.length ?? 0 }));
}
