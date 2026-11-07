// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/history`
 * Purpose: Pins change-reason rules and row-history shaping (task.0052).
 * Scope: Pure functions only. Does not touch an adapter or a database.
 * Invariants:
 *   - REASON_ONE_LINE: CR/LF become spaces; empty or >512 chars is rejected.
 *   - ONE_VERSION_PER_CHANGE: a merge repeat collapses to the older branch row and its reason.
 *   - NOTE_NOT_BODY: the reason is read from the commit message, newest first.
 * Side-effects: none
 * Links: hub change-history-design
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  ChangeReasonInvalidError,
  type HistoryDiffRow,
  normalizeChangeReason,
  parseWorkItemCommitMessage,
  shapeHistory,
} from "../src/history.js";

const row = (
  commit: string,
  date: string,
  message: string,
  from: Record<string, unknown>,
  to: Record<string, unknown>,
  diffType = "modified"
): HistoryDiffRow => ({
  to_commit: commit,
  to_commit_date: date,
  diff_type: diffType,
  message,
  committer: "root",
  ...Object.fromEntries(Object.entries(from).map(([k, v]) => [`from_${k}`, v])),
  ...Object.fromEntries(Object.entries(to).map(([k, v]) => [`to_${k}`, v])),
});

const options = {
  ignored: new Set(["revision", "updated_at"]),
  version: (r: HistoryDiffRow) => String(r.to_revision),
  reasonAndActor: (r: HistoryDiffRow) => parseWorkItemCommitMessage(r.message),
};

describe("normalizeChangeReason", () => {
  it("flattens line breaks so a reason cannot forge a commit line", () => {
    expect(normalizeChangeReason("tighten\nby actor:evil\r\nReason: x")).toBe(
      "tighten by actor:evil Reason: x"
    );
  });
  it("rejects empty and oversized reasons, keeps undefined", () => {
    expect(() => normalizeChangeReason("  \n ")).toThrow(ChangeReasonInvalidError);
    expect(() => normalizeChangeReason("x".repeat(513))).toThrow(ChangeReasonInvalidError);
    expect(normalizeChangeReason(undefined)).toBeUndefined();
  });
});

describe("parseWorkItemCommitMessage", () => {
  it("reads the actor from line one and the Reason line", () => {
    expect(
      parseWorkItemCommitMessage("work-items: patch task.1 by actor:agent-a\nReason: tighten brief")
    ).toEqual({ actor: "agent-a", reason: "tighten brief" });
    expect(parseWorkItemCommitMessage("work-items: patch task.1 by actor:agent-a")).toEqual({
      actor: "agent-a",
      reason: null,
    });
  });
});

describe("shapeHistory", () => {
  it("collapses a merge repeat to the older branch row and keeps its reason", () => {
    const rows = [
      row("m", "2026-11-07T10:03:00Z", "Merge branch 'x' into main", { summary: "b", revision: 1 }, { summary: "c", revision: 2 }),
      row("b", "2026-11-07T10:02:00Z", "work-items: patch task.1 by actor:x\nReason: branch change", { summary: "b", revision: 1 }, { summary: "c", revision: 2 }),
      row("a", "2026-11-07T10:01:00Z", "work-items: patch task.1 by actor:y\nReason: tighten", { summary: "a", revision: 0 }, { summary: "b", revision: 1 }),
    ];
    const history = shapeHistory(rows, options);
    expect(history.map((h) => [h.commit, h.version, h.reason, h.changed])).toEqual([
      ["b", "2", "branch change", ["summary"]],
      ["a", "1", "tighten", ["summary"]],
    ]);
    expect(history[0]?.diff.summary).toEqual({ before: "b", after: "c", truncated: false });
  });

  it("drops rows that change only ignored columns and truncates long values", () => {
    // Real diff rows carry every column; the fixture does too.
    const long = "x".repeat(5000);
    const rows = [
      row("c", "2026-11-07T10:02:00Z", "work-items: patch t by actor:z", { summary: "s", outcome: long, revision: 1, updated_at: "a" }, { summary: "s", outcome: long, revision: 2, updated_at: "b" }),
      row("d", "2026-11-07T10:01:00Z", "work-items: patch t by actor:z", { summary: "s", outcome: "o", revision: 0, updated_at: "a" }, { summary: "s", outcome: long, revision: 1, updated_at: "a" }),
    ];
    const history = shapeHistory(rows, options);
    expect(history).toHaveLength(1);
    expect(history[0]?.diff.outcome?.truncated).toBe(true);
  });
});
