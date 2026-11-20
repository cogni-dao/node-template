// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/read-http`
 * Purpose: The single-item read route core every node serves (story.0085): parse `include` and `artifact`, read the envelope, and
 *   return the one terminal log event, so every fork serves the same parts the shared item view draws and logs the same lines.
 * Scope: Framework-free. A node route keeps auth, its store read, its response codec and its logger; it logs the returned `event`
 *   and sends `body` with `status`. Unexpected errors are rethrown for the node's route wrapper.
 * Invariants:
 *   - ONE_TERMINAL_EVENT: every handled request returns exactly one event, success or refused, with ids and codes, never the body.
 *   - EVENT_NAMES_HERE: the two event names are owned here; a node's own name table repeats them only as these values.
 *   - UNKNOWN_INCLUDE_REFUSED: an unknown `include` part is HTTP 400 `invalid_input`, never ignored.
 *   - ONE_READ_TAXONOMY: the codes and the 499 abort are the list and board reads' (`WORK_READ_ERROR_CODES`, read-handlers).
 * Side-effects: none
 * Links: hub work-item-view-capability, publish-shared-runtime-core, ./write-http.ts
 * @public
 */

import { z } from "zod";

import type { WorkItemsBusyReason } from "./errors.js";
import {
  backendUnavailableBody,
  backendUnavailableReason,
  classifyWorkReadError,
  WORK_READ_CLIENT_CLOSED,
  WORK_READ_ERROR_CODES,
} from "./read-handlers.js";

/** Optional envelope parts a single-item read can add: `GET /api/v1/work/items/{id}?include=links,artifacts,history`. */
export const WORK_ITEM_INCLUDES = ["links", "artifacts", "history"] as const;
export type WorkItemInclude = (typeof WORK_ITEM_INCLUDES)[number];

/** The single-item read input: the path id, the envelope parts and one artifact in full. */
export const WorkItemGetInputSchema = z.object({
  id: z.string(),
  include: z.array(z.enum(WORK_ITEM_INCLUDES)).optional(),
  artifact: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
});
export type WorkItemGetInput = z.infer<typeof WorkItemGetInputSchema>;

export const WORK_ITEM_READ_EVENTS = {
  getSuccess: "work.items.get_success",
  getRefused: "work.items.get_refused",
} as const;

export interface WorkItemReadEvent {
  readonly event: (typeof WORK_ITEM_READ_EVENTS)[keyof typeof WORK_ITEM_READ_EVENTS];
  readonly routeId: "work.items.get";
  readonly outcome: "success" | "refused";
  readonly status: number;
  readonly workItemId: string;
  readonly errorCode?: string;
  /** A busy or unavailable store: why, from the closed set (task.0162). */
  readonly reason?: WorkItemsBusyReason;
  /** The envelope parts asked for, in request order. */
  readonly include?: readonly WorkItemInclude[];
}

export interface WorkItemReadResult {
  readonly status: number;
  /** `null` only for an aborted request (499). */
  readonly body: unknown;
  readonly event: WorkItemReadEvent;
}


/** The envelope options a node's store read takes. */
export interface WorkItemEnvelopeOptions {
  readonly includeLinks: boolean;
  readonly includeArtifacts: boolean;
  readonly includeHistory: boolean;
  readonly artifactId?: string;
}

/** A node's own refusal for an error the package does not know (for example forbidden). */
export type NodeReadRefusal = { readonly status: number; readonly errorCode: string; readonly body: unknown };

interface ReadDeps<R> {
  /** The request's query string: `include` (repeated or comma list) and `artifact`. */
  readonly searchParams: URLSearchParams;
  /** The request's signal: an aborted read is 499 `client_aborted` with no body. */
  readonly signal?: AbortSignal;
  /** The node's envelope read; `null` when no item has the id. */
  readonly read: (id: string, options: WorkItemEnvelopeOptions) => Promise<R | null>;
  /** The success body (the node's output codec). */
  readonly toBody: (result: R) => unknown;
  /** Node-only errors; anything still unknown is rethrown. */
  readonly mapNodeError?: (error: unknown) => NodeReadRefusal | undefined;
}

/** GET /work/items/{id}: parse the parts, read the envelope, and the one terminal event. */
export async function handleWorkItemGet<R>(id: string, deps: ReadDeps<R>): Promise<WorkItemReadResult> {
  const refuse = (status: number, errorCode: string, body: unknown, reason?: WorkItemsBusyReason): WorkItemReadResult => ({
    status,
    body,
    event: {
      event: WORK_ITEM_READ_EVENTS.getRefused,
      routeId: "work.items.get",
      outcome: "refused",
      status,
      workItemId: id,
      errorCode,
      ...(reason !== undefined ? { reason } : {}),
    },
  });

  const requested = deps.searchParams
    .getAll("include")
    .flatMap((value) => value.split(","))
    .filter(Boolean);
  const artifact = deps.searchParams.get("artifact");
  const parsed = WorkItemGetInputSchema.safeParse({
    id,
    ...(requested.length && { include: requested }),
    ...(artifact !== null && { artifact }),
  });
  if (!parsed.success)
    return refuse(400, WORK_READ_ERROR_CODES.INVALID_INPUT, { error: "invalid input", issues: parsed.error.issues });

  const include = parsed.data.include ?? [];
  let item: R | null;
  try {
    item = await deps.read(id, {
      includeLinks: include.includes("links"),
      includeArtifacts: include.includes("artifacts"),
      includeHistory: include.includes("history"),
      ...(parsed.data.artifact !== undefined && { artifactId: parsed.data.artifact }),
    });
  } catch (error) {
    if (deps.signal?.aborted) return refuse(WORK_READ_CLIENT_CLOSED, WORK_READ_ERROR_CODES.CLIENT_ABORTED, null);
    if (classifyWorkReadError(error) === "backend_unavailable") {
      // task.0162: the 503 names its reason in the body and on the one terminal event.
      const reason = backendUnavailableReason(error) ?? "capacity_held";
      return refuse(503, WORK_READ_ERROR_CODES.BACKEND_UNAVAILABLE, backendUnavailableBody(reason), reason);
    }
    const node = deps.mapNodeError?.(error);
    if (node) return refuse(node.status, node.errorCode, node.body);
    throw error;
  }
  if (item === null) return refuse(404, "not_found", { error: `Work item not found: ${id}` });

  return {
    status: 200,
    body: deps.toBody(item),
    event: {
      event: WORK_ITEM_READ_EVENTS.getSuccess,
      routeId: "work.items.get",
      outcome: "success",
      status: 200,
      workItemId: id,
      ...(include.length ? { include } : {}),
    },
  };
}
