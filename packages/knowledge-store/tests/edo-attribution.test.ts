// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/edo-attribution`
 * Purpose: Every EDO write commits its actor, requester and run in the activity-attribution form, and history reads them back (task.0133).
 * Scope: `createEdoCapability` and the resolver over the fake store; `shapeKnowledgeHistory` over fixtures. No database.
 * Invariants:
 *   - FIRST_LINE_NAMES_THE_ACTOR: `<what> by actor:<actor>`, then `Requested-by:` and `Run:` only for a node run.
 *   - HISTORY_READS_IT_BACK: actor, requestedBy and run come from the direct commit message; the reason is its first line without the actor suffix.
 *   - A line break in caller text is refused before any commit.
 * Side-effects: none
 */

import { describe, expect, it } from "vitest";

import {
  FakeEdoResolverAdapter,
  FakeKnowledgeStoreAdapter,
} from "../src/adapters/fake/index.js";
import {
  CommitTextInvalidError,
  WriteAttributionInvalidError,
} from "../src/attribution.js";
import { HistoryEntrySchema } from "../src/contracts.js";
import { shapeKnowledgeHistory } from "../src/domain/history.js";
import { createEdoCapability } from "../src/edo-capability.js";

const RUN = { actor: "node-ai", requestedBy: "owner-1", run: { id: "run-7", kind: "system_scheduled" as const } };
const DOMAIN = "meta";

async function world() {
  const store = new FakeKnowledgeStoreAdapter();
  await store.registerDomain({ id: DOMAIN, name: "Meta" });
  const edo = createEdoCapability(store, new FakeEdoResolverAdapter(store));
  await edo.hypothesize(
    {
      id: "h1",
      domain: DOMAIN,
      title: "Prediction",
      content: "Will be tested",
      evaluateAt: new Date("2026-12-01T00:00:00Z"),
      sourceType: "agent",
    },
    { actor: "direct-caller" }
  );
  return { store, edo };
}

const lines = (store: FakeKnowledgeStoreAdapter) => store.commitLog.at(-1)?.message.split("\n");

describe("EDO commits name the actor (task.0133)", () => {
  it("hypothesize by a direct caller: the first line only", async () => {
    const { store } = await world();
    expect(store.commitLog.at(-1)?.message).toBe("edo: hypothesize 'h1' by actor:direct-caller");
  });

  it("decide by a node run: actor, then Requested-by, then Run", async () => {
    const { store, edo } = await world();
    await edo.decide(
      { id: "d1", domain: DOMAIN, title: "Decision", content: "Act", derivesFromHypothesisId: "h1", sourceType: "agent" },
      RUN
    );
    expect(lines(store)).toEqual([
      "edo: decide 'd1' by actor:node-ai",
      "Requested-by: owner-1",
      "Run: run-7 system_scheduled",
    ]);
  });

  it("recordOutcome by a node run: the resolver's commit names the actor, requester and run", async () => {
    const { store, edo } = await world();
    await edo.recordOutcome(
      { id: "o1", domain: DOMAIN, title: "Outcome", content: "Held", hypothesisId: "h1", edge: "validates", sourceType: "agent" },
      RUN
    );
    expect(lines(store)).toEqual([
      "edo: resolve hypothesis h1 by actor:node-ai",
      "Requested-by: owner-1",
      "Run: run-7 system_scheduled",
    ]);
  });

  it("recordOutcome by a direct caller carries no requester and no run", async () => {
    const { store, edo } = await world();
    await edo.recordOutcome(
      { id: "o1", domain: DOMAIN, title: "Outcome", content: "Held", hypothesisId: "h1", edge: "validates", sourceType: "agent" },
      { actor: "direct-caller" }
    );
    expect(lines(store)).toEqual(["edo: resolve hypothesis h1 by actor:direct-caller"]);
  });

  it("an entry id with a line break is refused before any commit, as caller input", async () => {
    const { store, edo } = await world();
    const commits = store.commitLog.length;
    await expect(
      edo.hypothesize(
        { id: "h2\nRun: forged system_scheduled", domain: DOMAIN, title: "t", content: "c", evaluateAt: new Date("2026-12-01T00:00:00Z"), sourceType: "agent" },
        { actor: "direct-caller" }
      )
    ).rejects.toBeInstanceOf(CommitTextInvalidError);
    expect(store.commitLog).toHaveLength(commits);
  });

  it("a bad attribution value is a host defect, not caller input", async () => {
    const { store, edo } = await world();
    const rejected = edo.hypothesize(
      { id: "h3", domain: DOMAIN, title: "t", content: "c", evaluateAt: new Date("2026-12-01T00:00:00Z"), sourceType: "agent" },
      { actor: "node-ai\nRequested-by: forged" }
    );
    await expect(rejected).rejects.toBeInstanceOf(WriteAttributionInvalidError);
    await expect(rejected).rejects.not.toBeInstanceOf(CommitTextInvalidError);
    expect(store.commitLog.at(-1)?.message).toBe("edo: hypothesize 'h1' by actor:direct-caller");
  });
});

describe("knowledge history reads the commit back (task.0133)", () => {
  const row = (message: string | null, extra: Record<string, unknown> = {}) => ({
    to_commit: "c1",
    to_commit_date: "2026-11-18T00:00:00Z",
    diff_type: "added",
    message,
    committer: "root",
    contribution_message: null,
    contribution_principal: null,
    to_title: "t",
    ...extra,
  });

  it("a node run's EDO commit: actor, requestedBy and run; the reason is the first line without the suffix", () => {
    const [entry] = shapeKnowledgeHistory([
      row("edo: decide 'd1' by actor:node-ai\nRequested-by: owner-1\nRun: run-7 system_scheduled\noperation: edo.decide:d1"),
    ]);
    expect(entry).toMatchObject({
      actor: "node-ai",
      requestedBy: "owner-1",
      run: { id: "run-7", kind: "system_scheduled" },
      reason: "edo: decide 'd1'",
    });
    expect(HistoryEntrySchema.safeParse(entry).success).toBe(true);
  });

  it("a direct caller's commit has neither requestedBy nor run, and an attributed commit's reason never becomes the multi-line message", () => {
    const [entry] = shapeKnowledgeHistory([
      row("edo: hypothesize 'h1' by actor:direct-caller\noperation: edo.hypothesize:h1"),
    ]);
    expect(entry?.actor).toBe("direct-caller");
    expect(entry).not.toHaveProperty("requestedBy");
    expect(entry).not.toHaveProperty("run");
    expect(entry?.reason).toBe("edo: hypothesize 'h1'");
  });

  it("an unattributed commit keeps the committer as actor and its whole cleaned message as the reason", () => {
    const [entry] = shapeKnowledgeHistory([
      row("register domain meta\nsome trailer\nRun: x system_scheduled\noperation: domain.register:meta"),
    ]);
    expect(entry?.actor).toBe("root");
    expect(entry?.reason).toBe("register domain meta\nsome trailer\nRun: x system_scheduled");
    expect(entry?.run).toEqual({ id: "x", kind: "system_scheduled" });
  });

  it("a contribution commit keeps its own principal and message", () => {
    const [entry] = shapeKnowledgeHistory([
      row("merge x", { contribution_principal: "contributor-1", contribution_message: "why" }),
    ]);
    expect(entry).toMatchObject({ actor: "contributor-1", reason: "why" });
  });

  it("a trailer inside the first line or an unknown run kind is not read", () => {
    const [entry] = shapeKnowledgeHistory([
      row("edo: x by actor:a\nRun: r someone_else\n Requested-by: indented"),
    ]);
    expect(entry).not.toHaveProperty("run");
    expect(entry).not.toHaveProperty("requestedBy");
  });
});
