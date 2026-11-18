// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/artifacts`
 * Purpose: Pins the review artifact contract at the package seam (task.0028): subject formats, the scorecard
 *   rows, the server-computed PASS-grade, the subject checks, and the handler's status per outcome.
 * Scope: Fake structural ports only (an in-memory artifact store and an item store).
 *   No database, no web framework. The Doltgres insert path is not exercised here.
 * Invariants:
 *   - Authorship is audit only: the stored `author` is the authenticated principal and nothing compares it with the subject's author.
 *   - A review or validation with neither `url` nor `body` is refused 400; a story validation's origin must be this hub's own.
 *   - The item read carries the latest of each kind without `body`.
 *   - A malformed scorecard is refused 400 and nothing is stored.
 *   - PASS-grade: no FAIL or DRIFT row, a reason on each UNPROVEN or INDIRECT row, `fail` never.
 *   - Recording never touches the item.
 * Side-effects: none
 * Links: hub work-item-artifacts
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  artifactInvalidJson,
  type ArtifactItemStore,
  artifactsNotConfigured,
  isPassGrade,
  listWorkItemArtifacts,
  type NewWorkItemArtifact,
  parseArtifactSubject,
  readWorkItemArtifact,
  recordWorkItemArtifact,
  scorecardMarkdown,
  type ScorecardRow,
  type WorkItemArtifactRefsPage,
  toLatestArtifacts,
  type WorkItemArtifact,
  type WorkItemArtifactDeps,
} from "../src/artifacts.js";
import { WorkItemWriteOutcomeUnknownError } from "../src/errors.js";
import { composeItemEnvelope } from "../src/envelope.js";

const SHA = "a".repeat(40);
const PR = "https://github.com/cogni-dao/node-template/pull/352";
const COMMIT = "0123456789abcdefghijklmnopqrstuv"; // 32 chars of 0-9a-v
const COMMENT = "https://github.com/cogni-dao/node-template/pull/352#issuecomment-1";

const row = (overrides: Partial<ScorecardRow> = {}): ScorecardRow => ({
  tweak: "ARTIFACTS ROUTE",
  human: "—",
  ai: "🟢",
  loki: "🟢",
  trace: "—",
  overall: "🟢 PASS",
  ...overrides,
});

interface World {
  readonly deps: WorkItemArtifactDeps;
  readonly stored: NewWorkItemArtifact[];
  readonly itemReads: string[];
}

function world(
  options: {
    item?: { revision: number; pr?: string } | null;
    ownOrigin?: string | null;
    itemReadThrows?: boolean;
    insertThrows?: boolean;
    insertError?: Error;
  } = {}
): World {
  const stored: NewWorkItemArtifact[] = [];
  const itemReads: string[] = [];
  const item =
    options.item === undefined ? { revision: 4, pr: PR } : options.item;
  const items: ArtifactItemStore = {
    get: async (id) => {
      itemReads.push(String(id));
      if (options.itemReadThrows) throw new Error("dolt down");
      return item;
    },
  };
  return {
    stored,
    itemReads,
    deps: {
      items,
      ...(options.ownOrigin === null
        ? {}
        : { ownOrigin: options.ownOrigin ?? "https://node-template-test.cognidao.org" }),
      artifacts: {
        insert: async (input) => {
          if (options.insertError) throw options.insertError;
          if (options.insertThrows) throw new Error("write failed");
          stored.push(input);
          return {
            id: `wia-${stored.length}`,
            itemId: input.itemId,
            seq: stored.length,
            itemRevision: item?.revision ?? 0,
            kind: input.kind,
            subject: input.subject,
            verdict: input.verdict,
            ...(input.rows ? { rows: [...input.rows] } : {}),
            ...(input.note ? { note: input.note } : {}),
            ...(input.body ? { body: input.body } : {}),
            ...(input.url ? { url: input.url } : {}),
            author: input.author,
            createdAt: "2026-11-13T12:00:00.000Z",
          };
        },
        list: async () => [],
        latest: async () => [],
        refs: async () => [],
        get: async () => null,
      },
    },
  };
}

describe("parseArtifactSubject", () => {
  it.each([
    [`knowledge:contrib-derek-1@${COMMIT}`, "knowledge"],
    ["work:task.0028", "work"],
    [`${PR}@${SHA}`, "pr"],
    [`https://node-template-test.cognidao.org@${SHA}`, "build"],
  ])("accepts %s as a %s subject", (subject, form) => {
    expect(parseArtifactSubject(subject)?.form).toBe(form);
  });

  it.each([
    "knowledge:contrib-x@short",
    `knowledge:not-a-contrib@${COMMIT}`,
    "work:task.0028@12",
    "work:task.0028@twelve",
    "work:",
    `${PR}@${"a".repeat(39)}`,
    `${PR}@${"A".repeat(40)}`,
    `https://github.com/cogni-dao/node-template/issues/3@${SHA}`,
    `ftp://host@${SHA}`,
    PR,
    "",
  ])("rejects %s", (subject) => {
    expect(parseArtifactSubject(subject)).toBeUndefined();
  });
});

describe("isPassGrade", () => {
  it("passes an all-green pass", () => {
    expect(isPassGrade([row()], "pass")).toBe(true);
  });

  it("passes notes only when every UNPROVEN or INDIRECT row carries a reason", () => {
    const unproven = row({ ai: "🟡", loki: "🟡", overall: "🟡 UNPROVEN" });
    expect(isPassGrade([row(), { ...unproven, reason: "no auth state" }], "notes")).toBe(true);
    expect(isPassGrade([row(), unproven], "notes")).toBe(false);
    const indirect = row({ overall: "🟡 INDIRECT" });
    expect(isPassGrade([{ ...indirect, reason: " " }], "notes")).toBe(false);
    expect(isPassGrade([{ ...indirect, reason: "reqId only" }], "notes")).toBe(true);
  });

  it("never passes a FAIL or DRIFT row, whatever the headline says", () => {
    expect(isPassGrade([row(), row({ overall: "🔴 FAIL", ai: "🔴" })], "pass")).toBe(false);
    expect(isPassGrade([row({ overall: "🔴 DRIFT" })], "notes")).toBe(false);
  });

  it("never passes a fail headline, and never passes no rows", () => {
    expect(isPassGrade([row()], "fail")).toBe(false);
    expect(isPassGrade([], "pass")).toBe(false);
    expect(isPassGrade(undefined, "pass")).toBe(false);
  });

  it("scores an N/A docs-only row as passing", () => {
    expect(isPassGrade([row({ ai: "—", loki: "—", overall: "⚪ N/A" })], "pass")).toBe(true);
  });
});

describe("recordWorkItemArtifact: the write contract", () => {
  const designReview = {
    kind: "design_review",
    subject: `knowledge:contrib-derek-1@${COMMIT}`,
    verdict: "approve",
    url: "https://node-template.cognidao.org/knowledge/inbox/contrib-derek-1",
  };

  it("201: stores the artifact with the authenticated principal as author, never one from the body", async () => {
    const w = world({ inbox: { "contrib-derek-1": "author-1" } });
    const result = await recordWorkItemArtifact(w.deps, "task.0028", "reviewer-1", {
      ...designReview,
    });
    expect(result.status).toBe(201);
    expect(w.stored).toEqual([
      { itemId: "task.0028", ...designReview, author: "reviewer-1" },
    ]);
    expect(result.log).toEqual({
      event: "work.items.artifact_recorded",
      status: 201,
      outcome: "success",
      workItemId: "task.0028",
      kind: "design_review",
      verdict: "approve",
    });
    // A body that names an author is not a valid body.
    const named = await recordWorkItemArtifact(w.deps, "task.0028", "reviewer-1", {
      ...designReview,
      author: "someone-else",
    });
    expect(named.status).toBe(400);
  });

  it("400: design_waiver is not a kind, and a body that names an author or an item revision is refused", async () => {
    const w = world();
    const waiver = await recordWorkItemArtifact(w.deps, "task.0028", "reviewer-1", {
      kind: "design_waiver",
      subject: "work:task.0028",
      verdict: "waived",
      url: COMMENT,
    });
    expect(waiver.status).toBe(400);
    expect((waiver.body as { issues: { path: string[] }[] }).issues[0]?.path).toEqual(["kind"]);
    for (const extra of [{ author: "someone-else" }, { itemRevision: 0 }]) {
      const r = await recordWorkItemArtifact(w.deps, "task.0028", "reviewer-1", { ...designReview, ...extra });
      expect(r.status).toBe(400);
    }
    expect(w.stored).toEqual([]);
    expect(w.itemReads).toEqual([]);
    expect(waiver.log).toMatchObject({ event: "work.items.artifact_refused", status: 400, errorCode: "invalid_input" });
  });

  it("400: a review or validation needs a url or a body; either alone is enough; note and body are bounded", async () => {
    const w = world({ inbox: { "contrib-derek-1": "author-1" } });
    const { url: _url, ...noUrl } = designReview;
    const none = await recordWorkItemArtifact(w.deps, "task.0028", "reviewer-1", noUrl);
    expect(none.status).toBe(400);
    expect(none.body).toMatchObject({
      issues: [{ path: ["url"], message: "a design_review needs a url or a body" }],
    });
    // An inbox has no comment surface: the body alone holds the review.
    const bodyOnly = await recordWorkItemArtifact(w.deps, "task.0028", "reviewer-1", {
      ...noUrl,
      body: "Findings:\n1. one\n2. two",
      note: "Request one change",
    });
    expect(bodyOnly.status).toBe(201);
    expect(w.stored[0]).toMatchObject({ body: "Findings:\n1. one\n2. two", note: "Request one change" });
    expect(w.stored[0]?.url).toBeUndefined();
    // Bounds: 240 characters of note, 16000 of body, one line of note.
    const edge = (extra: Record<string, unknown>) =>
      recordWorkItemArtifact(w.deps, "task.0028", "reviewer-1", { ...designReview, ...extra });
    expect((await edge({ note: "n".repeat(240) })).status).toBe(201);
    expect((await edge({ note: "n".repeat(241) })).status).toBe(400);
    expect((await edge({ note: "two\nlines" })).status).toBe(400);
    expect((await edge({ body: "b".repeat(16_000) })).status).toBe(201);
    expect((await edge({ body: "b".repeat(16_001) })).status).toBe(400);
    expect((await edge({ body: "" })).status).toBe(400);
  });

  it("400: a malformed scorecard is refused and nothing is stored", async () => {
    const w = world();
    const validation = {
      kind: "validation",
      subject: `${PR}@${SHA}`,
      verdict: "notes",
      url: COMMENT,
    };
    const issuesOf = async (body: unknown) => {
      const r = await recordWorkItemArtifact(w.deps, "task.0028", "validator-1", body);
      expect(r.status).toBe(400);
      return (r.body as { issues: { path: (string | number)[] }[] }).issues.map((i) =>
        i.path.join(".")
      );
    };
    // no rows at all
    expect(await issuesOf(validation)).toEqual(["rows"]);
    // an empty list
    expect(await issuesOf({ ...validation, rows: [] })).toEqual(["rows"]);
    // a cell that is not a scorecard emoji or a dash
    expect(await issuesOf({ ...validation, rows: [{ ...row(), ai: "ok" }] })).toEqual(["rows.0.ai"]);
    // an overall without its emoji, and one that is not on the scorecard at all
    expect(await issuesOf({ ...validation, rows: [{ ...row(), overall: "PASS" }] })).toEqual([
      "rows.0.overall",
    ]);
    // a verdict that is a review verdict
    expect(await issuesOf({ ...validation, verdict: "approve", rows: [row()] })).toEqual(["verdict"]);
    // rows on a review
    expect(
      await issuesOf({
        kind: "implementation_review",
        subject: `${PR}@${SHA}`,
        verdict: "approve",
        url: COMMENT,
        rows: [row()],
      })
    ).toEqual(["rows"]);
    // a subject of the wrong form for the kind (a build subject on a design review)
    expect(
      await issuesOf({ ...designReview, subject: `https://example.org@${SHA}` })
    ).toEqual(["subject"]);
    // the work:<id>@<revision> brief form is gone: a design review judges an inbox
    expect(
      await issuesOf({ ...designReview, subject: "work:task.0028@3" })
    ).toEqual(["subject"]);
    expect(await issuesOf({ ...designReview, subject: "work:task.0028" })).toEqual(["subject"]);
    // a triage verdict is research, design or implement
    expect(
      await issuesOf({ kind: "triage", subject: "work:task.0028", verdict: "approve" })
    ).toEqual(["verdict"]);
    expect(w.stored).toEqual([]);
  });

  it("201: a validation keeps its rows losslessly and the server computes PASS-grade", async () => {
    const w = world();
    const rows = [
      row({ tweak: "POST ARTIFACTS" }),
      row({ tweak: "ITEM READ", human: "🟡", overall: "🟡 UNPROVEN", reason: "no storageState" }),
    ];
    const result = await recordWorkItemArtifact(w.deps, "task.0028", "validator-1", {
      kind: "validation",
      subject: `${PR}@${SHA}`,
      verdict: "notes",
      rows,
      url: COMMENT,
    });
    expect(result.status).toBe(201);
    expect(w.stored[0]?.rows).toEqual(rows);
    expect((result.body as { artifact: WorkItemArtifact }).artifact.passGrade).toBe(true);
    expect(result.log).toMatchObject({ passGrade: true, rowCount: 2 });
  });

  it("404: a missing item, with nothing stored", async () => {
    const w = world({ item: null });
    const result = await recordWorkItemArtifact(w.deps, "task.9", "reviewer-1", designReview);
    expect(result.status).toBe(404);
    expect(result.body).toEqual({
      error: "Work item not found: task.9",
      errorCode: "not_found",
    });
    expect(w.stored).toEqual([]);
    expect(result.log).toMatchObject({ event: "work.items.artifact_refused", status: 404 });
  });

  it("503: a failed read or write is unavailable and never a pass", async () => {
    const reads = world({ itemReadThrows: true });
    const pr = {
      kind: "implementation_review",
      subject: `${PR}@${SHA}`,
      verdict: "approve",
      url: COMMENT,
    };
    expect((await recordWorkItemArtifact(reads.deps, "task.0028", "r", pr)).status).toBe(503);
    const write = world({ insertThrows: true });
    const failed = await recordWorkItemArtifact(write.deps, "task.0028", "r", designReview);
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ error: "artifacts_unavailable", errorCode: "artifacts_unavailable" });
    expect(reads.stored).toEqual([]);
    // Every non-success write logs as a refusal, with the database error code (SQLSTATE) and never the error's message.
    expect(failed.log).toMatchObject({
      event: "work.items.artifact_refused",
      status: 503,
      outcome: "error",
      errorCode: "artifacts_unavailable",
      errorName: "Error",
    });
    expect(failed.log).not.toHaveProperty("errorMessage");
    const sqlFailure = world({ insertError: Object.assign(new Error("relation\n\"work_item_artifacts\" does not exist"), {
        code: "42P01",
      }),
    });
    const missingTable = await recordWorkItemArtifact(sqlFailure.deps, "task.0028", "r", designReview);
    expect(missingTable.log).toMatchObject({ dbCode: "42P01" });
    expect(JSON.stringify(missingTable.log)).not.toContain("does not exist");
  });

  it("409: a write whose outcome is unknown is distinct and not retryable, never a plain 503", async () => {
    const w = world({ insertError: new WorkItemWriteOutcomeUnknownError("op-1", "work-item-op/x", "c1", "task.0028"),
    });
    const result = await recordWorkItemArtifact(w.deps, "task.0028", "r", designReview);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({
      error: "work_item_write_outcome_unknown",
      errorCode: "work_item_write_outcome_unknown",
      retryable: false,
      lookup: { operationId: "op-1", branch: "work-item-op/x", commitHash: "c1", itemId: "task.0028" },
    });
    expect(result.log).toMatchObject({
      event: "work.items.artifact_refused",
      status: 409,
      errorCode: "work_item_write_outcome_unknown",
    });
  });

  it("404: an item that vanishes between the handler's read and the store's is not found, not unavailable", async () => {
    const w = world({ insertError: new Error("Work item not found: task.0028") });
    const result = await recordWorkItemArtifact(w.deps, "task.0028", "r", designReview);
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: "Work item not found: task.0028", errorCode: "not_found" });
    expect(result.log).toMatchObject({ event: "work.items.artifact_refused", status: 404 });
  });

  it("an invalid JSON body and a node with no artifact store are logged refusals with an errorCode", () => {
    const json = artifactInvalidJson("task.0028");
    expect(json.status).toBe(400);
    expect(json.body).toEqual({ error: "invalid JSON body", errorCode: "invalid_input" });
    expect(json.log).toMatchObject({ event: "work.items.artifact_refused", status: 400, outcome: "refused" });
    const write = artifactsNotConfigured("task.0028", "write");
    expect(write.status).toBe(503);
    expect(write.body).toEqual({ error: "artifacts_unavailable", errorCode: "artifacts_unavailable" });
    expect(write.log.event).toBe("work.items.artifact_refused");
    expect(artifactsNotConfigured("task.0028", "read").log.event).toBe("work.items.artifacts_read");
  });
});

describe("recordWorkItemArtifact: subjects and authorship", () => {
  const prReview = {
    kind: "implementation_review",
    subject: `${PR}@${SHA}`,
    verdict: "approve",
    url: COMMENT,
  };

  it("authorship is audit only: any principal records any review, and the stored author is that principal", async () => {
    const w = world();
    // The same principal may write the work and record its review: no server check compares them.
    for (const author of ["linker-1", "linker-1", "reviewer-1"]) {
      const result = await recordWorkItemArtifact(w.deps, "task.0028", author, prReview);
      expect(result.status).toBe(201);
      expect((result.body as { artifact: WorkItemArtifact }).artifact.author).toBe(author);
    }
    const designReview = {
      kind: "design_review",
      subject: `knowledge:contrib-derek-1@${COMMIT}`,
      verdict: "approve",
      url: "https://node-template.cognidao.org/knowledge/inbox/contrib-derek-1",
    };
    expect((await recordWorkItemArtifact(w.deps, "task.0028", "contrib-derek-1-author", designReview)).status).toBe(201);
    expect(w.stored.map((row) => row.author)).toEqual(["linker-1", "linker-1", "reviewer-1", "contrib-derek-1-author"]);
  });

  it("PR subject: a PR that is not the item's pr is refused as invalid", async () => {
    const w = world();
    const other = await recordWorkItemArtifact(w.deps, "task.0028", "reviewer-1", {
      ...prReview,
      subject: `https://github.com/cogni-dao/node-template/pull/1@${SHA}`,
    });
    expect(other.status).toBe(400);
    expect(other.body).toEqual({
      error: "invalid input",
      errorCode: "invalid_input",
      issues: [{ path: ["subject"], message: "subject is not this item's pr" }],
    });
    const unlinked = world({ item: { revision: 4 } });
    expect((await recordWorkItemArtifact(unlinked.deps, "task.0028", "reviewer-1", prReview)).status).toBe(400);
  });

  it("triage must name THIS item, and needs no url", async () => {
    const triage = {
      kind: "triage",
      subject: "work:task.0028",
      verdict: "design",
      note: "Measurement gap: no KPI reads artifacts until task.0103",
    };
    const w = world();
    const own = await recordWorkItemArtifact(w.deps, "task.0028", "router-1", triage);
    expect(own.status).toBe(201);
    expect(w.stored[0]).toMatchObject({ kind: "triage", verdict: "design", author: "router-1" });
    // Never straight to implement: every change passes design review (CEO 2026-11-18).
    const skip = await recordWorkItemArtifact(world().deps, "task.0028", "router-1", { ...triage, verdict: "implement" });
    expect(skip.status).toBe(400);
    expect(w.stored[0]?.url).toBeUndefined();
    const other = await recordWorkItemArtifact(w.deps, "task.0028", "router-1", { ...triage, subject: "work:task.0099" });
    expect(other.status).toBe(400);
    expect(other.body).toMatchObject({ issues: [{ path: ["subject"], message: "subject names a different work item" }] });
  });

  it("closeout names THIS item, a done verdict, a note and a url or a body (story.0047)", async () => {
    const closeout = {
      kind: "closeout",
      subject: "work:task.0028",
      verdict: "done",
      note: "KPI up 3 points after one window",
      url: COMMENT,
    };
    const w = world();
    const own = await recordWorkItemArtifact(w.deps, "task.0028", "closer-1", closeout);
    expect(own.status).toBe(201);
    expect(w.stored[0]).toMatchObject({ kind: "closeout", verdict: "done", author: "closer-1" });
    const bodyOnly = { ...closeout, body: "Refined atom k-1; removed the flag in PR 12" };
    const { url: _url, ...noUrl } = bodyOnly;
    expect((await recordWorkItemArtifact(w.deps, "task.0028", "closer-1", noUrl)).status).toBe(201);
    const { note: _note, ...noNote } = closeout;
    const missingNote = await recordWorkItemArtifact(w.deps, "task.0028", "closer-1", noNote);
    expect(missingNote.status).toBe(400);
    expect(missingNote.body).toMatchObject({ issues: [{ path: ["note"] }] });
    const { url: _u, ...bare } = closeout;
    expect((await recordWorkItemArtifact(w.deps, "task.0028", "closer-1", bare)).status).toBe(400);
    expect((await recordWorkItemArtifact(w.deps, "task.0028", "closer-1", { ...closeout, verdict: "pass" })).status).toBe(400);
    expect(
      (await recordWorkItemArtifact(w.deps, "task.0028", "closer-1", { ...closeout, subject: "work:task.0099" })).status
    ).toBe(400);
  });

  it("build subject: only this hub's own origin is accepted (case and a trailing slash in the config do not matter)", async () => {
    const live = (origin: string) => ({
      kind: "validation",
      subject: `${origin}@${SHA}`,
      verdict: "pass",
      rows: [row()],
      url: COMMENT,
    });
    const refusal = {
      error: "invalid input",
      errorCode: "invalid_input",
      issues: [{ path: ["subject"], message: "subject origin is not this hub's own origin" }],
    };
    const own = world({ ownOrigin: "HTTPS://Node-Template-Test.cognidao.org/" });
    expect(
      (await recordWorkItemArtifact(own.deps, "story.0047", "validator-1", live("https://node-template-test.cognidao.org"))).status
    ).toBe(201);
    const other = await recordWorkItemArtifact(own.deps, "story.0047", "validator-1", live("https://cognidao.org"));
    expect(other.status).toBe(400);
    expect(other.body).toEqual(refusal);
    expect(own.stored).toHaveLength(1);
    // With no origin configured nothing matches: fail closed.
    const none = world({ ownOrigin: null });
    expect((await recordWorkItemArtifact(none.deps, "story.0047", "validator-1", live("https://node-template-test.cognidao.org"))).body).toEqual(refusal);
    expect(none.stored).toEqual([]);
  });
});

describe("reads", () => {
  const stored = (kind: WorkItemArtifact["kind"], id: string, verdict: string): WorkItemArtifact => ({
    id,
    itemId: "task.0028",
    seq: 1,
    itemRevision: 3,
    kind,
    subject: "s",
    verdict,
    author: "a",
    body: `full review ${id}`,
    note: "one line",
    createdAt: "2026-11-13T00:00:00.000Z",
    ...(kind === "validation" ? { rows: [row()] } : {}),
  });

  it("toLatestArtifacts keeps the first (newest) of each kind and derives passGrade for a validation", () => {
    const latest = toLatestArtifacts([
      stored("validation", "v2", "fail"),
      stored("design_review", "d2", "approve"),
      stored("design_review", "d1", "request_changes"),
      stored("validation", "v1", "pass"),
    ]);
    expect(latest.design_review?.id).toBe("d2");
    expect(latest.validation?.id).toBe("v2");
    expect(latest.validation?.passGrade).toBe(false);
    expect(latest.implementation_review).toBeUndefined();
    // The item read never carries the full review.
    for (const artifact of Object.values(latest)) {
      expect(artifact).not.toHaveProperty("body");
      expect(artifact).toMatchObject({ itemRevision: 3, note: "one line" });
    }
  });

  it("the latest of a kind is the highest seq, not the newest timestamp: approve then request_changes at one revision and one instant", () => {
    const at = { itemRevision: 3, createdAt: "2026-11-13T00:00:00.000Z" };
    const approve = { ...stored("implementation_review", "i1", "approve"), seq: 1, ...at };
    const changes = { ...stored("implementation_review", "i2", "request_changes"), seq: 2, ...at };
    const later = { ...stored("implementation_review", "i3", "approve"), seq: 3, ...at };
    // Whatever order a store hands them back in, the highest seq wins.
    expect(toLatestArtifacts([approve, changes]).implementation_review?.verdict).toBe("request_changes");
    expect(toLatestArtifacts([changes, approve]).implementation_review?.verdict).toBe("request_changes");
    expect(toLatestArtifacts([changes, later, approve]).implementation_review?.id).toBe("i3");
    expect(toLatestArtifacts([later, approve, changes]).implementation_review?.seq).toBe(3);
  });

  it("GET list: 200 newest-first from the store, 404 for a missing item, 503 on a store failure", async () => {
    const w = world();
    const deps: WorkItemArtifactDeps = {
      ...w.deps,
      artifacts: {
        ...w.deps.artifacts,
        list: async () => [stored("validation", "v1", "pass"), stored("design_review", "d1", "approve")],
      },
    };
    const ok = await listWorkItemArtifacts(deps, "task.0028");
    expect(ok.status).toBe(200);
    const items = (ok.body as { items: WorkItemArtifact[] }).items;
    expect(items.map((a) => a.id)).toEqual(["v1", "d1"]);
    expect(items[0]?.passGrade).toBe(true);
    // The list carries the body.
    expect(items[0]?.body).toBe("full review v1");
    expect(ok.log).toMatchObject({ event: "work.items.artifacts_read", artifactCount: 2 });
    expect((await listWorkItemArtifacts(world({ item: null }).deps, "task.9")).status).toBe(404);
    const broken: WorkItemArtifactDeps = {
      ...w.deps,
      artifacts: {
        ...w.deps.artifacts,
        list: async () => {
          throw new Error("down");
        },
      },
    };
    expect((await listWorkItemArtifacts(broken, "task.0028")).status).toBe(503);
  });

  it("the item read adds the latest of each kind through one port call, and reads unavailable on a failure", async () => {
    const calls: string[] = [];
    const item = { id: "task.0028" };
    const ok = await composeItemEnvelope(item, {
      artifacts: {
        latest: async (id) => {
          calls.push(id);
          return [stored("implementation_review", "i1", "approve")];
        },
      },
    });
    expect(calls).toEqual(["task.0028"]);
    expect(ok.artifacts?.implementation_review?.id).toBe("i1");
    // The stored row had a body; the item read drops it.
    expect(ok.artifacts?.implementation_review).not.toHaveProperty("body");

    const events: unknown[] = [];
    const down = await composeItemEnvelope(
      item,
      {
        artifacts: {
          latest: async () => {
            throw new Error("table missing");
          },
        },
        log: (event) => events.push(event),
      }
    );
    expect(down.artifacts).toEqual({ unavailable: true });
    expect(events).toEqual([{ part: "artifacts", workItemId: "task.0028", reason: "Error" }]);

    // One stored row the wire cannot carry degrades the part; the item read still succeeds.
    const badEvents: unknown[] = [];
    const bad = await composeItemEnvelope(
      item,
      {
        artifacts: {
          latest: async () => [
            stored("design_review", "d1", "approve"),
            { ...stored("validation", "v1", "pass"), rows: [{ tweak: "x", overall: "PASS" }] } as never,
          ],
        },
        log: (event) => badEvents.push(event),
      }
    );
    expect(bad.artifacts).toEqual({ unavailable: true });
    expect(badEvents).toEqual([{ part: "artifacts", workItemId: "task.0028", reason: "invalid_row" }]);

    // No port: the part is absent, not empty.
    expect((await composeItemEnvelope(item, {})).artifacts).toBeUndefined();
  });
});

describe("refs first, then one read (story.0058)", () => {
  /** `count` artifacts of one item, seq 1..count; every fifth is a validation with rows. */
  const many = (count: number): WorkItemArtifact[] =>
    Array.from({ length: count }, (_, index) => {
      const seq = index + 1;
      const validation = seq % 5 === 0;
      return {
        id: `wia-${seq}`,
        itemId: "task.0028",
        seq,
        itemRevision: seq,
        kind: validation ? "validation" : "implementation_review",
        subject: `${PR}@${SHA}`,
        verdict: validation ? "pass" : "approve",
        ...(validation ? { rows: [row()] } : { body: `review ${seq}` }),
        author: "user-1",
        createdAt: "2026-11-18T00:00:00.000Z",
      };
    });

  const withStore = (artifacts: WorkItemArtifact[]): WorkItemArtifactDeps => {
    const w = world();
    return {
      ...w.deps,
      artifacts: {
        ...w.deps.artifacts,
        // The adapter's order: highest seq first, below `before`, at most `limit`, without `rows` (non-validation) or `body`.
        refs: async (_id, { before, limit }) =>
          [...artifacts]
            .sort((a, b) => b.seq - a.seq)
            .filter((a) => before === undefined || a.seq < before)
            .slice(0, limit)
            .map(({ body: _body, ...rest }) => rest),
        get: async (itemId, artifactId) =>
          artifacts.find((a) => a.itemId === itemId && a.id === artifactId) ?? null,
      },
    };
  };

  it("pages refs by seq: 20 a page, nextCursor the lowest seq, null on the last page; no body, rows or author", async () => {
    const deps = withStore(many(25));
    const first = await listWorkItemArtifacts(deps, "task.0028", { view: "refs" });
    expect(first.status).toBe(200);
    const page = first.body as WorkItemArtifactRefsPage;
    expect(page.refs.map((r) => r.seq)).toEqual(Array.from({ length: 20 }, (_, i) => 25 - i));
    expect(page.nextCursor).toBe(6);
    expect(page.refs.find((r) => r.kind === "validation")?.passGrade).toBe(true);
    for (const ref of page.refs) {
      expect(ref).not.toHaveProperty("body");
      expect(ref).not.toHaveProperty("rows");
      expect(ref).not.toHaveProperty("author");
    }
    const second = await listWorkItemArtifacts(deps, "task.0028", { view: "refs", cursor: "6" });
    const older = second.body as WorkItemArtifactRefsPage;
    expect(older.refs.map((r) => r.seq)).toEqual([5, 4, 3, 2, 1]);
    expect(older.nextCursor).toBeNull();
  });

  it("keeps the list answer without view, and refuses an unknown view or a bad cursor with 400", async () => {
    const deps = withStore(many(2));
    expect((await listWorkItemArtifacts(deps, "task.0028")).body).toHaveProperty("items");
    for (const query of [{ view: "all" }, { cursor: "3" }, { view: "refs", cursor: "0" }, { view: "refs", cursor: "x" }]) {
      const refused = await listWorkItemArtifacts(deps, "task.0028", query);
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ errorCode: "invalid_input" });
      expect(refused.log).toMatchObject({ event: "work.items.artifacts_read", status: 400 });
    }
  });

  it("reads one artifact in full, 404 for another item's artifact or a missing one, 400 for a malformed id", async () => {
    const deps = withStore(many(5));
    const one = await readWorkItemArtifact(deps, "task.0028", "wia-5");
    expect(one.status).toBe(200);
    expect((one.body as { artifact: WorkItemArtifact }).artifact).toMatchObject({ rows: [row()], passGrade: true });
    expect((await readWorkItemArtifact(deps, "task.0028", "wia-4")).body).toMatchObject({ artifact: { body: "review 4" } });
    expect((await readWorkItemArtifact(deps, "task.9999", "wia-4")).status).toBe(404);
    expect((await readWorkItemArtifact(deps, "task.0028", "wia-99")).status).toBe(404);
    expect((await readWorkItemArtifact(deps, "task.0028", "../x")).status).toBe(400);
  });

  it("scorecardMarkdown leaves out the reason column when no row has a reason", () => {
    expect(scorecardMarkdown([row()]).split("\n")[0]).toBe("| PR TWEAK | HUMAN | AI | LOKI | TRACE | OVERALL |");
  });

  it("scorecardMarkdown builds one GFM table and escapes pipes and line breaks", () => {
    const table = scorecardMarkdown([row({ tweak: "a|b", overall: "🟡 UNPROVEN", reason: "line one\nline two" })]);
    const lines = table.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("| a\\|b | — | 🟢 | 🟢 | — | 🟡 UNPROVEN | line one line two |");
  });

  it("the envelope adds refs and one artifact on request, degrades each part alone, and never fails the item", async () => {
    const item = { id: "task.0028" };
    const page: WorkItemArtifactRefsPage = { refs: [], nextCursor: null };
    const events: unknown[] = [];
    const read = await composeItemEnvelope(
      item,
      {
        artifactRefs: { firstPage: async () => page },
        historyRefs: {
          firstPage: async () => {
            throw new Error("dolt down");
          },
        },
        artifactById: { get: async () => null },
        log: (event) => events.push(event),
      },
      { includeArtifacts: true, includeHistory: true, artifactId: "wia-1" }
    );
    expect(read.artifactRefs).toEqual(page);
    expect(read.historyRefs).toEqual({ refs: [], nextCursor: null, unavailable: true });
    expect(read.artifact).toEqual({ notFound: true });
    expect(events).toEqual([{ part: "historyRefs", workItemId: "task.0028", reason: "Error" }]);
    // Not asked: absent.
    const plain = await composeItemEnvelope(item, { artifactRefs: { firstPage: async () => page } });
    expect(plain).not.toHaveProperty("artifactRefs");
    expect(plain).not.toHaveProperty("artifact");
  });
});
