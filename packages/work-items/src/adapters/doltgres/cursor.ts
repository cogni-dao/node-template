// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Versioned order-bound keyset. The native SQL projection owns the exact key. */
import {
  normalizeWorkItemOrder,
  type WorkItemOrder
} from "../../query-order.js";

export class InvalidCursorError extends Error {
  constructor(message = "invalid_cursor: restart pagination without a cursor") {
    super(message);
    this.name = "InvalidCursorError";
  }
}
export type WorkItemCursor = WorkItemOrder & {
  v: 1;
  key: string | null;
  id: string;
};
export function encodeCursor(cursor: WorkItemCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}
export function decodeCursor(
  raw: string,
  order?: WorkItemOrder
): WorkItemCursor {
  try {
    if (!raw || raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw))
      throw new Error();
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      !value ||
      value.v !== 1 ||
      typeof value.id !== "string" ||
      !value.id ||
      value.id.length > 200 ||
      !(value.key === null || typeof value.key === "string") ||
      value.key?.length > 100
    )
      throw new Error();
    const normalized = normalizeWorkItemOrder(value);
    if (
      normalized.sortBy !== value.sortBy ||
      normalized.sortDirection !== value.sortDirection
    )
      throw new Error();
    if (
      order &&
      (order.sortBy !== value.sortBy ||
        order.sortDirection !== value.sortDirection)
    )
      throw new Error();
    if (value.key !== null) {
      if (value.sortBy === "createdAt" || value.sortBy === "updatedAt") {
        if (
          !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:\d{2})?)?$/.test(
            value.key
          ) ||
          !Number.isFinite(Date.parse(value.key))
        )
          throw new Error();
      } else if (
        !/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value.key) ||
        !Number.isFinite(Number(value.key))
      )
        throw new Error();
    }
    return { v: 1, ...normalized, key: value.key, id: value.id };
  } catch {
    throw new InvalidCursorError();
  }
}
