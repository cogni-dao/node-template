// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/artifacts`
 * Purpose: Pins the review artifact contract at the package seam (task.0028): subject formats, the scorecard
 *   rows, the server-computed PASS-grade, the independence decision per subject, and the handler's status per outcome.
 * Scope: Fake structural ports only (an in-memory artifact store, an item store with history, an inbox author port).
 *   No database, no web framework. The Doltgres insert path is not exercised here.
 * Invariants:
 *   - An artifact from the subject's author is refused 409 `artifact_author_not_independent`; so is one whose author history cannot show.
 *   - A review or validation with neither `url` nor `body` is refused 400; a story validation's origin must be this hub's own.
 *   - Triage has no independence rule; the item read carries the latest of each kind without `body`.
 *   - A malformed scorecard is refused 400 and nothing is stored.
 *   - PASS-grade: no FAIL or DRIFT row, a reason on each UNPROVEN or INDIRECT row, `fail` never.
 *   - Recording never touches the item.
 * Side-effects: none
 * Links: hub work-cicd-gates-design (The artifact record, Independence)
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
  recordWorkItemArtifact,
  type ScorecardRow,
  toLatestArtifacts,
  type WorkItemArtifact,
  type WorkItemArtifactDeps,
} from "../src/artifacts.js";
import { WorkItemWriteOutcomeUnknownError } from "../src/errors.js";
import { composeItemEnvelope } from "../src/envelope.js";
import type { HistoryEntry } from "../src/history.js";

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

const entry = (
  actor: string | null,
  field: string,
  after: unknown
): HistoryEntry => ({
  version: "1",
  commit: "c",
  at: "2026-11-13T00:00:00.000Z",
  actor,
  reason: "why",
  cites: [],
  changed: [field],
  diff: { [field]: { before: null, after, truncated: false } },
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
    history?: readonly HistoryEntry[] | "absent" | "throws";
    inbox?: Record<string, string> | "absent" | "throws";
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
      return item;
    },
    ...(options.history === "absent"
      ? {}
      : {
          history: async () => {
            if (options.history === "throws") throw new Error("dolt down");
            return options.history ?? [];
          },
        }),
  };
  const inbox = options.inbox;
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
      },
      ...(inbox === "absent"
        ? {}
        : {
            inboxes: {
              principalOf: async (id: string) => {
                if (inbox === "throws") throw new Error("knowledge down");
                return inbox?.[id] ?? null;
              },
            },
          }),
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
    const w = world({ history: [entry("linker-1", "pr", PR)] });
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
    const reads = world({ history: "throws" });
    const pr = {
      kind: "implementation_review",
      subject: `${PR}@${SHA}`,
      verdict: "approve",
      url: COMMENT,
    };
    expect((await recordWorkItemArtifact(reads.deps, "task.0028", "r", pr)).status).toBe(503);
    const inbox = world({ inbox: "throws" });
    expect((await recordWorkItemArtifact(inbox.deps, "task.0028", "r", designReview)).status).toBe(503);
    const write = world({ inbox: { "contrib-derek-1": "author-1" }, insertThrows: true });
    const failed = await recordWorkItemArtifact(write.deps, "task.0028", "r", designReview);
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ error: "artifacts_unavailable", errorCode: "artifacts_unavailable" });
    expect(reads.stored).toEqual([]);
    expect(inbox.stored).toEqual([]);
    // Every non-success write logs as a refusal, with the database error code and a one-line message.
    expect(failed.log).toMatchObject({
      event: "work.items.artifact_refused",
      status: 503,
      outcome: "error",
      errorCode: "artifacts_unavailable",
      errorName: "Error",
      errorMessage: "write failed",
    });
    const sqlFailure = world({
      inbox: { "contrib-derek-1": "author-1" },
      insertError: Object.assign(new Error("relation\n\"work_item_artifacts\" does not exist"), {
        code: "42P01",
      }),
    });
    const missingTable = await recordWorkItemArtifact(sqlFailure.deps, "task.0028", "r", designReview);
    expect(missingTable.log).toMatchObject({
      dbCode: "42P01",
      errorMessage: 'relation "work_item_artifacts" does not exist',
    });
  });

  it("409: a write whose outcome is unknown is distinct and not retryable, never a plain 503", async () => {
    const w = world({
      inbox: { "contrib-derek-1": "author-1" },
      insertError: new WorkItemWriteOutcomeUnknownError("op-1", "work-item-op/x", "c1", "task.0028"),
    });
    const result = await recordWorkItemArtifact(w.deps, "task.0028", "r", designReview);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({
      error: "work_item_write_outcome_unknown",
      retryable: false,
      lookup: { operationId: "op-1", branch: "work-item-op/x", commitHash: "c1", itemId: "task.0028" },
    });
    expect(result.log).toMatchObject({
      event: "work.items.artifact_refused",
      status: 409,
      errorCode: "work_item_write_outcome_unknown",
    });
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

describe("recordWorkItemArtifact: independence", () => {
  const inboxReview = {
    kind: "design_review",
    subject: `knowledge:contrib-derek-1@${COMMIT}`,
    verdict: "approve",
    url: "https://node-template.cognidao.org/knowledge/inbox/contrib-derek-1",
  };
  const prReview = {
    kind: "implementation_review",
    subject: `${PR}@${SHA}`,
    verdict: "approve",
    url: COMMENT,
  };
  const refused = (reason: string) => ({
    error: "artifact author is not independent of the subject's author",
    errorCode: "artifact_author_not_independent",
    reason,
  });

  it("inbox subject: the inbox principalId may not review its own inbox", async () => {
    const w = world({ inbox: { "contrib-derek-1": "author-1" } });
    const own = await recordWorkItemArtifact(w.deps, "task.0028", "author-1", inboxReview);
    expect(own.status).toBe(409);
    expect(own.body).toEqual(refused("same_principal"));
    expect(own.log).toMatchObject({
      event: "work.items.artifact_refused",
      status: 409,
      errorCode: "artifact_author_not_independent",
      reason: "same_principal",
    });
    expect(w.stored).toEqual([]);
    expect((await recordWorkItemArtifact(w.deps, "task.0028", "reviewer-1", inboxReview)).status).toBe(201);
  });

  it("inbox subject: an unknown inbox or no inbox reader shows no author, so the write is refused", async () => {
    const unknown = world({ inbox: {} });
    const a = await recordWorkItemArtifact(unknown.deps, "task.0028", "reviewer-1", inboxReview);
    expect(a.status).toBe(409);
    expect(a.body).toEqual(refused("author_unknown"));
    const none = world({ inbox: "absent" });
    expect((await recordWorkItemArtifact(none.deps, "task.0028", "reviewer-1", inboxReview)).status).toBe(409);
    expect([...unknown.stored, ...none.stored]).toEqual([]);
  });

  it("PR subject: the principal that last set the item's pr may not review or validate it", async () => {
    // newest first: someone retitled after linker-2 set the pr; linker-2 is the last to set it.
    const history = [
      entry("editor-1", "title", "new title"),
      entry("linker-2", "pr", PR),
      entry("linker-1", "pr", "https://github.com/cogni-dao/node-template/pull/351"),
    ];
    const w = world({ history });
    const own = await recordWorkItemArtifact(w.deps, "task.0028", "linker-2", prReview);
    expect(own.status).toBe(409);
    expect(own.body).toEqual(refused("same_principal"));
    // The earlier linker is not the author of THIS pr.
    expect((await recordWorkItemArtifact(w.deps, "task.0028", "linker-1", prReview)).status).toBe(201);
    const validation = {
      kind: "validation",
      subject: `${PR}@${SHA}`,
      verdict: "pass",
      rows: [row()],
      url: COMMENT,
    };
    expect((await recordWorkItemArtifact(w.deps, "task.0028", "linker-2", validation)).status).toBe(409);
    expect((await recordWorkItemArtifact(w.deps, "task.0028", "validator-1", validation)).status).toBe(201);
  });

  it("PR subject: history that shows no linker, or no history at all, refuses (fail closed)", async () => {
    const noEntry = world({ history: [entry("editor-1", "title", "t")] });
    const a = await recordWorkItemArtifact(noEntry.deps, "task.0028", "reviewer-1", prReview);
    expect(a.status).toBe(409);
    expect(a.body).toEqual(refused("author_unknown"));
    const noActor = world({ history: [entry(null, "pr", PR)] });
    expect((await recordWorkItemArtifact(noActor.deps, "task.0028", "reviewer-1", prReview)).status).toBe(409);
    const noHistory = world({ history: "absent" });
    expect((await recordWorkItemArtifact(noHistory.deps, "task.0028", "reviewer-1", prReview)).status).toBe(409);
    expect([...noEntry.stored, ...noActor.stored, ...noHistory.stored]).toEqual([]);
  });

  it("PR subject: a PR that is not the item's pr is refused as invalid, so the wrong author is never compared", async () => {
    const w = world({ history: [entry("linker-1", "pr", PR)] });
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

  it("triage has NO independence rule: the router may be the one who moved the item, and history may be absent", async () => {
    const triage = {
      kind: "triage",
      subject: "work:task.0028",
      verdict: "implement",
      note: "Measurement gap: no KPI reads artifacts until task.0103",
    };
    const moved = world({ history: [entry("router-1", "status", "needs_triage")] });
    const own = await recordWorkItemArtifact(moved.deps, "task.0028", "router-1", triage);
    expect(own.status).toBe(201);
    expect(moved.stored[0]).toMatchObject({ kind: "triage", verdict: "implement", author: "router-1" });
    expect(moved.stored[0]?.url).toBeUndefined();
    // No history reader, no inbox reader, a throwing history: none of them matters to triage.
    for (const w of [
      world({ history: "absent", inbox: "absent" }),
      world({ history: "throws", inbox: "throws" }),
    ]) {
      expect((await recordWorkItemArtifact(w.deps, "task.0028", "router-1", triage)).status).toBe(201);
    }
    // It still must name THIS item.
    const other = await recordWorkItemArtifact(moved.deps, "task.0028", "router-1", { ...triage, subject: "work:task.0099" });
    expect(other.status).toBe(400);
    expect(other.body).toMatchObject({ issues: [{ path: ["subject"], message: "subject names a different work item" }] });
  });

  it("build subject (a story): the principal that last moved it to needs_validation may not validate it", async () => {
    const w = world({ history: [entry("owner-1", "status", "needs_validation")] });
    const live = {
      kind: "validation",
      subject: `https://node-template-test.cognidao.org@${SHA}`,
      verdict: "pass",
      rows: [row()],
      url: COMMENT,
    };
    expect((await recordWorkItemArtifact(w.deps, "story.0047", "owner-1", live)).status).toBe(409);
    expect((await recordWorkItemArtifact(w.deps, "story.0047", "validator-1", live)).status).toBe(201);
  });

  it("build subject: only this hub's own origin is accepted (case and a trailing slash in the config do not matter)", async () => {
    const live = (origin: string) => ({
      kind: "validation",
      subject: `${origin}@${SHA}`,
      verdict: "pass",
      rows: [row()],
      url: COMMENT,
    });
    const history = [entry("owner-1", "status", "needs_validation")];
    const refusal = {
      error: "invalid input",
      errorCode: "invalid_input",
      issues: [{ path: ["subject"], message: "subject origin is not this hub's own origin" }],
    };
    const own = world({ history, ownOrigin: "HTTPS://Node-Template-Test.cognidao.org/" });
    expect(
      (await recordWorkItemArtifact(own.deps, "story.0047", "validator-1", live("https://node-template-test.cognidao.org"))).status
    ).toBe(201);
    const other = await recordWorkItemArtifact(own.deps, "story.0047", "validator-1", live("https://cognidao.org"));
    expect(other.status).toBe(400);
    expect(other.body).toEqual(refusal);
    expect(own.stored).toHaveLength(1);
    // With no origin configured nothing matches: fail closed.
    const none = world({ history, ownOrigin: null });
    expect((await recordWorkItemArtifact(none.deps, "story.0047", "validator-1", live("https://node-template-test.cognidao.org"))).body).toEqual(refusal);
    expect(none.stored).toEqual([]);
  });
});

describe("reads", () => {
  const stored = (kind: WorkItemArtifact["kind"], id: string, verdict: string): WorkItemArtifact => ({
    id,
    itemId: "task.0028",
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
