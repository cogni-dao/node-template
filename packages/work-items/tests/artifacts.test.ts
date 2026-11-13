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
 *   - `design_waiver` from a caller is refused 400 and nothing is stored.
 *   - A malformed scorecard is refused 400 and nothing is stored.
 *   - PASS-grade: no FAIL or DRIFT row, a reason on each UNPROVEN or INDIRECT row, `fail` never.
 *   - Recording never touches the item.
 * Side-effects: none
 * Links: hub work-cicd-gates-design (The artifact record, Independence)
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  type ArtifactItemStore,
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
    history?: readonly HistoryEntry[] | "absent" | "throws";
    inbox?: Record<string, string> | "absent" | "throws";
    insertThrows?: boolean;
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
      artifacts: {
        insert: async (input) => {
          if (options.insertThrows) throw new Error("write failed");
          stored.push(input);
          return {
            id: `wia-${stored.length}`,
            itemId: input.itemId,
            kind: input.kind,
            subject: input.subject,
            verdict: input.verdict,
            ...(input.rows ? { rows: [...input.rows] } : {}),
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
    ["work:task.0028@12", "work"],
    [`${PR}@${SHA}`, "pr"],
    [`https://node-template-test.cognidao.org@${SHA}`, "build"],
  ])("accepts %s as a %s subject", (subject, form) => {
    expect(parseArtifactSubject(subject)?.form).toBe(form);
  });

  it.each([
    "knowledge:contrib-x@short",
    `knowledge:not-a-contrib@${COMMIT}`,
    "work:task.0028@twelve",
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

  it("400: a design_waiver from a caller is refused, with the reason, and nothing is stored", async () => {
    const w = world();
    const result = await recordWorkItemArtifact(w.deps, "task.0028", "reviewer-1", {
      kind: "design_waiver",
      subject: "work:task.0028@4",
      verdict: "waived",
      url: COMMENT,
    });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: "invalid input",
      issues: [{ path: ["kind"], message: "design_waiver is written only by the server" }],
    });
    expect(w.stored).toEqual([]);
    expect(w.itemReads).toEqual([]);
    expect(result.log).toMatchObject({
      event: "work.items.artifact_refused",
      status: 400,
      errorCode: "invalid_input",
      kind: "design_waiver",
    });
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
    expect(result.body).toEqual({ error: "Work item not found: task.9" });
    expect(w.stored).toEqual([]);
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
      issues: [{ path: ["subject"], message: "subject is not this item's pr" }],
    });
    const unlinked = world({ item: { revision: 4 } });
    expect((await recordWorkItemArtifact(unlinked.deps, "task.0028", "reviewer-1", prReview)).status).toBe(400);
  });

  it("work-brief subject: the principal that last moved the item to needs_design_review may not review it", async () => {
    const history = [
      entry("editor-1", "status", "needs_design"),
      entry("designer-1", "status", "needs_design_review"),
    ];
    const w = world({ history });
    const brief = {
      kind: "design_review",
      subject: "work:task.0028@3",
      verdict: "request_changes",
      url: COMMENT,
    };
    expect((await recordWorkItemArtifact(w.deps, "task.0028", "designer-1", brief)).status).toBe(409);
    expect((await recordWorkItemArtifact(w.deps, "task.0028", "reviewer-1", brief)).status).toBe(201);
    // A brief of a different item, or a revision the item has not reached, is not this item's brief.
    expect(
      (await recordWorkItemArtifact(w.deps, "task.0028", "reviewer-1", { ...brief, subject: "work:task.0099@3" })).status
    ).toBe(400);
    expect(
      (await recordWorkItemArtifact(w.deps, "task.0028", "reviewer-1", { ...brief, subject: "work:task.0028@5" })).status
    ).toBe(400);
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
});

describe("reads", () => {
  const stored = (kind: WorkItemArtifact["kind"], id: string, verdict: string): WorkItemArtifact => ({
    id,
    itemId: "task.0028",
    kind,
    subject: "s",
    verdict,
    author: "a",
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

    // No port: the part is absent, not empty.
    expect((await composeItemEnvelope(item, {})).artifacts).toBeUndefined();
  });
});
