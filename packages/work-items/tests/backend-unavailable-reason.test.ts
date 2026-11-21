// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/backend-unavailable-reason`
 * Purpose: Proves every busy 503 can name its reason, matched by error name across bundled copies (task.0162).
 * Scope: Pure; real error classes, a same-named copy class, and name-only objects.
 * Invariants:
 *   - EVERY_REASON_ROUND_TRIPS: each member of `WorkItemsBusyReason` reads back through `backendUnavailableReason`; a member added to the union without a row here fails typecheck.
 *   - BY_NAME_NOT_INSTANCEOF: a facade's copy of a busy class keeps its reason.
 *   - NO_MESSAGE_PARSING: an error with no known reason reads `undefined`, never a guess from its text.
 * Side-effects: none
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  WorkItemsBusyError,
  type WorkItemsBusyReason,
  WorkItemsCapacityError,
} from "../src/errors.js";
import { backendUnavailableReason } from "../src/read-handlers.js";

const ALL_REASONS: Record<WorkItemsBusyReason, true> = {
  capacity_held: true,
  queue_timeout: true,
  writer_settling: true,
  connect_timeout: true,
  lock_contended: true,
  writer_admission: true,
  evidence_preserved: true,
  reconcile_unavailable: true,
  read_timeout: true,
  read_connection_lost: true,
  not_configured: true,
  outcome_unknown: true,
};

describe("backendUnavailableReason", () => {
  // Guards: a reason added to the union but dropped by the reader would 503 with no reason again.
  it.each(Object.keys(ALL_REASONS) as WorkItemsBusyReason[])(
    "reads %s from a WorkItemsBusyError and from a same-named copy class",
    (reason) => {
      expect(backendUnavailableReason(new WorkItemsBusyError("busy", reason))).toBe(
        reason
      );
      class WorkItemsBusyError_copy extends Error {
        constructor(readonly reason: string) {
          super("busy");
          this.name = "WorkItemsBusyError";
        }
      }
      expect(backendUnavailableReason(new WorkItemsBusyError_copy(reason))).toBe(
        reason
      );
    }
  );

  // Guards: held native capacity once classified as busy but carried no reason.
  it("reads capacity_held from WorkItemsCapacityError", () => {
    expect(backendUnavailableReason(new WorkItemsCapacityError("pending"))).toBe(
      "capacity_held"
    );
  });

  // Guards: the adapter's unprovable-transition error is a busy 503, not a 500, and keeps its reason.
  it("reads the reason of an UnprovableTransitionError by name", () => {
    const error = Object.assign(new Error("failed its operation proof"), {
      name: "UnprovableTransitionError",
      reason: "evidence_preserved",
    });
    expect(backendUnavailableReason(error)).toBe("evidence_preserved");
  });

  // Guards: the facade's own copy carries the reason through to the route.
  it("reads the reason of a WorkItemsBackendNotReadyError by name", () => {
    const error = Object.assign(new Error("x"), {
      name: "WorkItemsBackendNotReadyError",
      reason: "read_timeout",
    });
    expect(backendUnavailableReason(error)).toBe("read_timeout");
  });

  it("gives the unconfigured and merge-unknown errors their fixed reasons", () => {
    expect(
      backendUnavailableReason(
        Object.assign(new Error("x"), { name: "DoltgresNotConfiguredError" })
      )
    ).toBe("not_configured");
    expect(
      backendUnavailableReason(
        Object.assign(new Error("x"), { name: "DoltMergeOutcomeUnknownError" })
      )
    ).toBe("outcome_unknown");
  });

  // Guards: a reason outside the closed set, a non-busy error, or a message that sounds busy must not become a code.
  it("returns undefined for an unknown reason, a non-busy error or a bare message", () => {
    expect(
      backendUnavailableReason(
        Object.assign(new Error("x"), {
          name: "WorkItemsBusyError",
          reason: "made_up",
        })
      )
    ).toBeUndefined();
    expect(
      backendUnavailableReason(
        Object.assign(new Error("x"), {
          name: "SomethingElse",
          reason: "queue_timeout",
        })
      )
    ).toBeUndefined();
    expect(
      backendUnavailableReason(new Error("Work-item store queue wait timed out"))
    ).toBeUndefined();
    expect(backendUnavailableReason(undefined)).toBeUndefined();
  });
});
