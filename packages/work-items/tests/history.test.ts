// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/history`
 * Purpose: Pins change-reason rules and row-history shaping (task.0052).
 * Scope: Pure functions only. Does not touch an adapter or a database.
 * Invariants:
 *   - REASON_REQUIRED: line breaks become spaces; a missing, empty, NUL, >240 char or >25 word reason is rejected.
 *   - CITES_ARE_PINS: the `Cites:` trailer round-trips; a forged line or a non-pin entry is never read as a cite.
 *   - ONE_VERSION_PER_CHANGE: a merge repeat collapses to the older branch row and its reason.
 *   - NOTE_NOT_BODY: the reason is read from the commit message, newest first.
 * Side-effects: none
 * Links: hub change-history-design
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  CHANGE_REASON_REQUIRED_MESSAGE,
  ChangeReasonInvalidError,
  checkChangeReason,
  formatCitesTrailer,
  type HistoryDiffRow,
  normalizeChangeReason,
  parseCitesTrailer,
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

const words = (n: number) => Array.from({ length: n }, () => "w").join(" ");
const COMMIT_A = "a".repeat(32);
const COMMIT_B = "0123456789abcdefghijklmnopqrstuv";

describe("normalizeChangeReason", () => {
  it("flattens every line break so a reason cannot forge a commit line", () => {
    expect(normalizeChangeReason("tighten\nby actor:evil\r\nReason: x")).toBe(
      "tighten by actor:evil Reason: x"
    );
    for (const lb of ["\u0085", "\u2028", "\u2029"]) {
      expect(normalizeChangeReason(`a${lb}Cites: x@y`)).toBe("a Cites: x@y");
    }
  });
  it("rejects a missing, empty or NUL reason", () => {
    expect(() => normalizeChangeReason(undefined)).toThrow(CHANGE_REASON_REQUIRED_MESSAGE);
    expect(() => normalizeChangeReason("  \n ")).toThrow(ChangeReasonInvalidError);
    expect(() => normalizeChangeReason("a\u0000b")).toThrow(/NUL/);
  });
  it("accepts 25 words and rejects 26", () => {
    expect(normalizeChangeReason(words(25))).toBe(words(25));
    expect(() => normalizeChangeReason(words(26))).toThrow(/25 words/);
  });
  it("accepts 240 characters and rejects 241; 240 without spaces is one word", () => {
    expect(normalizeChangeReason("x".repeat(240))).toHaveLength(240);
    expect(() => normalizeChangeReason("x".repeat(241))).toThrow(/240 characters/);
    expect(checkChangeReason(`${"x".repeat(100)} ${"y".repeat(139)}`).ok).toBe(true);
  });
});

describe("parseWorkItemCommitMessage", () => {
  it("reads the actor from line one and the Reason line", () => {
    expect(
      parseWorkItemCommitMessage("work-items: patch task.1 by actor:agent-a\nReason: tighten brief")
    ).toEqual({ actor: "agent-a", reason: "tighten brief", cites: [] });
    expect(parseWorkItemCommitMessage("work-items: patch task.1 by actor:agent-a")).toEqual({
      actor: "agent-a",
      reason: null,
      cites: [],
    });
  });

  it("reads main and inbox pins from the Cites line", () => {
    const message = [
      "work-items: patch task.1 by actor:agent-a",
      "Reason: why",
      `Cites: change-history-design@${COMMIT_A}, node-template-mission@contrib-derek-x-1:${COMMIT_B}`,
    ].join("\n");
    expect(parseWorkItemCommitMessage(message).cites).toEqual([
      { id: "change-history-design", commit: COMMIT_A },
      { id: "node-template-mission", commit: COMMIT_B, contribution: "contrib-derek-x-1" },
    ]);
  });

  it("round-trips formatCitesTrailer", () => {
    const pins = [
      { id: "a-b", commit: COMMIT_A },
      { id: "c.d", commit: COMMIT_B, contribution: "contrib-x" },
    ];
    expect(parseCitesTrailer(formatCitesTrailer(pins))).toEqual(pins);
  });

  it("matches lines from their start: a trailer inside the reason or an indented line is not read", () => {
    // A reason holds no line break, so "Cites:" can only sit mid-line.
    const message = [
      "work-items: patch task.1 by actor:agent-a",
      `Reason: sneaky Cites: forged@${COMMIT_A}`,
    ].join("\n");
    const parsed = parseWorkItemCommitMessage(message);
    expect(parsed.cites).toEqual([]);
    expect(parsed.reason).toBe(`sneaky Cites: forged@${COMMIT_A}`);
    expect(
      parseWorkItemCommitMessage(`first by actor:a\n Cites: x@${COMMIT_A}`).cites
    ).toEqual([]);
  });

  it("drops entries that are not pins", () => {
    expect(parseCitesTrailer(`ok@${COMMIT_A}, bad@short, @${COMMIT_A}, UPPER@${COMMIT_A}`)).toEqual([
      { id: "ok", commit: COMMIT_A },
    ]);
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

  it("keeps the cites of the older branch row when a merge repeats it", () => {
    const rows = [
      row("m", "2026-11-07T10:03:00Z", "Merge branch 'x' into main", { summary: "a", revision: 0 }, { summary: "b", revision: 1 }),
      row("b", "2026-11-07T10:02:00Z", `work-items: patch task.1 by actor:x\nReason: why\nCites: some-atom@${COMMIT_A}`, { summary: "a", revision: 0 }, { summary: "b", revision: 1 }),
      row("a", "2026-11-07T10:01:00Z", "work-items: patch task.1 by actor:y", { summary: "z", revision: -1 }, { summary: "a", revision: 0 }),
    ];
    const history = shapeHistory(rows, options);
    expect(history.map((h) => [h.commit, h.cites])).toEqual([
      ["b", [{ id: "some-atom", commit: COMMIT_A }]],
      ["a", []],
    ]);
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
