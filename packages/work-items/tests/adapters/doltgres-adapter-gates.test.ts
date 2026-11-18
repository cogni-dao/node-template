// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/adapters/doltgres-adapter-gates`
 * Purpose: Drives the move gate through DoltgresWorkItemAdapter (task.0122): the writer path refuses before it writes,
 *   every status change restamps `status_revision`, and a failed PR read is a 503 that takes no lock.
 * Scope: Fake `Sql` capturing emitted SQL. The predicate itself is in `tests/gates.test.ts`.
 * Invariants:
 *   - CREATE_IS_TRIAGE_ONLY: a create with any other status is refused before any SQL.
 *   - REFUSAL_WRITES_NOTHING: a refused move emits no branch, no UPDATE and no commit.
 *   - STATUS_REVISION: a status change sets `status_revision = revision + 1`; any other patch leaves it alone.
 *   - PR_READ_BEFORE_THE_LOCK: the PR read happens before the advisory lock; a failure is `WorkItemGateFactsUnavailableError`
 *     and nothing is locked or written; a second move within 60 s reuses the read; a failure is remembered 10 s.
 * Side-effects: none
 * @internal
 */

import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";

import {
  DoltgresWorkItemAdapter,
  type DoltgresWorkItemAdapterOptions,
} from "../../src/adapters/doltgres/adapter.js";
import {
  WorkItemGateFactsUnavailableError,
  WorkItemGateUnmetError,
} from "../../src/errors.js";
import type { PrFactsPort } from "../../src/gates.js";
import { toWorkItemId } from "../../src/types.js";
import { independentReadPool, makeFakeDoltgresSql } from "./fake-doltgres-sql.js";

const ID = "task.0001";
const PR = "https://github.com/cogni-dao/node-template/pull/9";
const OTHER = "https://github.com/cogni-dao/node-template/pull/10";
const OTHER_REPO_PR = "https://github.com/cogni-dao/levelup/pull/49";
const HEAD = "a".repeat(40);
const REVISION = 6;
const STATUS_REVISION = 3;

const SIX = {
  ease: { v: 3 },
  goal: { v: 4 },
  time: { v: 3 },
  agent: { v: 4 },
  unblocks: { v: 4 },
  confidence: { v: 4 },
};

const base = (status: string, extra: Record<string, unknown> = {}) => ({
  id: ID,
  type: "task",
  title: "gate me",
  status,
  node: "shared",
  actor: "either",
  assignees: [],
  external_refs: [],
  labels: ["goal:goal-ai-work-converges"],
  spec_refs: [],
  scores: SIX,
  moves: [{ metricId: "m-1", direction: "up", baselineObservationId: null }],
  revision: REVISION,
  status_revision: STATUS_REVISION,
  deploy_verified: false,
  created_by_principal_id: "creator",
  created_at: "2026-11-13T00:00:00.000Z",
  updated_at: "2026-11-13T00:00:00.000Z",
  ...extra,
});

const artifactRow = (
  kind: string,
  subject: string,
  verdict: string,
  extra: Record<string, unknown> = {}
) => ({
  id: `wia-${kind}-${verdict}`,
  item_id: ID,
  seq: 1,
  item_revision: STATUS_REVISION,
  kind,
  subject,
  verdict,
  rows: null,
  note: null,
  url: null,
  author: "reviewer",
  created_at: "2026-11-13T01:00:00.000Z",
  ...extra,
});

const PASS_ROWS = [
  { tweak: "GATES", human: "—", ai: "🟢", loki: "🟢", trace: "—", overall: "🟢 PASS" },
];

function world(
  status: string,
  options: { pr?: string; artifacts?: Record<string, unknown>[]; type?: string } = {}
) {
  const queries: string[] = [];
  let row: Record<string, unknown> = base(status, {
    ...(options.pr ? { pr: options.pr } : {}),
    ...(options.type ? { type: options.type } : {}),
  });
  const respond = (q: string): Record<string, unknown>[] => {
    if (q.startsWith("UPDATE work_items")) {
      const next = /\bstatus = '([^']*)'/.exec(q)?.[1] ?? String(row.status);
      const pr = /\bpr = '([^']*)'/.exec(q)?.[1] ?? (row.pr as string | undefined);
      const after = {
        ...row,
        status: next,
        title: /\btitle = '([^']*)'/.exec(q)?.[1] ?? row.title,
        status_revision: q.includes("status_revision = revision + 1")
          ? Number(row.revision) + 1
          : row.status_revision,
        deploy_verified: q.includes("deploy_verified = TRUE"),
        ...(pr ? { pr } : {}),
      };
      // The next read sees this write: a second pass over the same item is a real second pass.
      row = { ...after, revision: Number(row.revision) + 1 };
      return [after];
    }
    if (q.startsWith("WITH latest AS")) return options.artifacts ?? [];
    if (q.includes("FROM work_items")) return [row];
    return [];
  };
  const sql: Sql = makeFakeDoltgresSql(respond, queries);
  const make = (extra: Partial<DoltgresWorkItemAdapterOptions> = {}) =>
    new DoltgresWorkItemAdapter(sql, {
      readClient: independentReadPool(sql),
      prRepos: ["cogni-dao/node-template"],
      ...extra,
    });
  /** A writer outside this adapter changes the row: what a race between a read and the lock looks like. */
  const change = (fields: Record<string, unknown>) => {
    row = { ...row, ...fields };
  };
  return { queries, make, change };
}

const patchStatus = (adapter: DoltgresWorkItemAdapter, status: string, principal = "mover") =>
  adapter.patch(
    { id: toWorkItemId(ID), reason: "move it", set: { status: status as never } },
    principal
  );

const wrote = (queries: string[]) =>
  queries.some(
    (q) =>
      q.startsWith("UPDATE work_items") ||
      q.startsWith("INSERT INTO") ||
      q.includes("dolt_checkout('-b'") ||
      q.startsWith("SELECT dolt_commit")
  );

describe("create is triage only", () => {
  it("refuses a create in needs_implement before any SQL", async () => {
    const { queries, make } = world("needs_triage");
    await expect(
      make().create(
        { type: "task", title: "skip triage", status: "needs_implement" } as never,
        "creator"
      )
    ).rejects.toMatchObject({ name: "WorkItemGateUnmetError", from: "create", to: "needs_implement" });
    expect(queries).toEqual([]);
  });
});

describe("a refused move writes nothing", () => {
  it.each([
    ["needs_triage", "needs_implementation_review", "path"],
    ["done", "needs_merge", "terminal"],
    ["cancelled", "needs_triage", "terminal"],
    ["needs_implement", "blocked", "path"],
    ["needs_implement", "needs_closeout", "path"],
    ["needs_triage", "needs_implement", "path"],
    ["needs_triage", "needs_design", "triage"],
    ["needs_implement", "needs_implementation_review", "pr"],
  ])("%s -> %s is gate_unmet (%s)", async (from, to, missing) => {
    const { queries, make } = world(from);
    await expect(patchStatus(make(), to)).rejects.toMatchObject({
      name: "WorkItemGateUnmetError",
      from,
      to,
      missing,
    });
    expect(wrote(queries)).toBe(false);
  });

  it("a forward move on an artifact written before the item entered the stage is refused", async () => {
    const stale = artifactRow("triage", `work:${ID}`, "design", {
      item_revision: STATUS_REVISION - 1,
    });
    const { queries, make } = world("needs_triage", { artifacts: [stale] });
    await expect(patchStatus(make(), "needs_design")).rejects.toMatchObject({
      name: "WorkItemGateUnmetError",
      missing: "triage",
    });
    expect(wrote(queries)).toBe(false);
  });
});

describe("a back move on the design route", () => {
  it("reads the latest triage, so a design-route item at needs_implement may return to needs_design", async () => {
    const design = artifactRow("triage", `work:${ID}`, "design");
    const { queries, make } = world("needs_implement", { artifacts: [design] });
    const patched = await patchStatus(make(), "needs_design");
    expect(patched.status).toBe("needs_design");
    expect(wrote(queries)).toBe(true);
  });

  it("an item with no design-route triage cannot enter a design stage by moving back", async () => {
    const { queries, make } = world("needs_implement");
    await expect(patchStatus(make(), "needs_design")).rejects.toMatchObject({
      name: "WorkItemGateUnmetError",
      from: "needs_implement",
      to: "needs_design",
      missing: "path",
    });
    expect(wrote(queries)).toBe(false);
  });
});

describe("status_revision", () => {
  it("is restamped by a forward move on its exit artifact", async () => {
    const triage = artifactRow("triage", `work:${ID}`, "design");
    const { queries, make } = world("needs_triage", { artifacts: [triage] });
    const patched = await patchStatus(make(), "needs_design");
    expect(patched.status).toBe("needs_design");
    const update = queries.find((q) => q.startsWith("UPDATE work_items"));
    expect(update).toContain("status = 'needs_design'");
    expect(update).toContain("status_revision = revision + 1");
    expect(queries.filter((q) => q.startsWith("SELECT dolt_add"))).toEqual([
      "SELECT dolt_add('work_items')",
    ]);
  });

  it("is restamped by a move back to triage, which needs no artifact", async () => {
    const { queries, make } = world("needs_validation", { pr: PR });
    const patched = await patchStatus(make(), "needs_triage");
    expect(patched.status).toBe("needs_triage");
    expect(queries.find((q) => q.startsWith("UPDATE work_items"))).toContain(
      "status_revision = revision + 1"
    );
  });

  it("is restamped by a move back to a design stage, which needs no fresh artifact", async () => {
    const stale = artifactRow("triage", `work:${ID}`, "design", { item_revision: 1 });
    const { queries, make } = world("needs_implement", { artifacts: [stale] });
    const patched = await patchStatus(make(), "needs_design");
    expect(patched.status).toBe("needs_design");
    expect(queries.find((q) => q.startsWith("UPDATE work_items"))).toContain(
      "status_revision = revision + 1"
    );
  });

  it("is left alone by a patch that does not change the status", async () => {
    const { queries, make } = world("needs_validation", { pr: PR });
    await make().patch(
      { id: toWorkItemId(ID), reason: "rename", set: { title: "renamed" } },
      "editor"
    );
    expect(queries.find((q) => q.startsWith("UPDATE work_items"))).not.toContain("status_revision");
  });

  it("a status written to the status it already has is not a move and does not restamp", async () => {
    const { queries, make } = world("needs_implement", { pr: PR });
    await patchStatus(make(), "needs_implement");
    expect(queries.find((q) => q.startsWith("UPDATE work_items"))).not.toContain("status_revision");
  });
});

describe("PR facts", () => {
  const artifacts = [
    artifactRow("implementation_review", `${PR}@${HEAD}`, "approve", { item_revision: 1 }),
    artifactRow("validation", `${PR}@${HEAD}`, "pass", { rows: PASS_ROWS }),
  ];

  it("a failed PR read is a 503 before the lock; nothing is locked or written", async () => {
    const { queries, make } = world("needs_validation", { pr: PR, artifacts });
    const prFacts: PrFactsPort = {
      read: vi.fn(async () => {
        throw new Error("github 403");
      }),
    };
    await expect(patchStatus(make({ prFacts }), "needs_merge")).rejects.toBeInstanceOf(
      WorkItemGateFactsUnavailableError
    );
    expect(prFacts.read).toHaveBeenCalledTimes(1);
    expect(wrote(queries)).toBe(false);
    expect(queries.some((q) => q.startsWith("SELECT pg_try_advisory_lock"))).toBe(false);
  });

  it("no PR port wired is the same 503", async () => {
    const { queries, make } = world("needs_validation", { pr: PR, artifacts });
    await expect(patchStatus(make(), "needs_merge")).rejects.toBeInstanceOf(
      WorkItemGateFactsUnavailableError
    );
    expect(wrote(queries)).toBe(false);
  });

  it("reads the PR once per URL inside the 60 s cache and lets a met gate through", async () => {
    const { queries, make } = world("needs_validation", { pr: PR, artifacts });
    const prFacts: PrFactsPort = { read: vi.fn(async () => ({ head: HEAD, merged: false })) };
    const adapter = make({ prFacts });
    const first = await patchStatus(adapter, "needs_merge");
    expect(first.status).toBe("needs_merge");
    await patchStatus(adapter, "needs_merge");
    expect(prFacts.read).toHaveBeenCalledTimes(1);
    expect(queries.filter((q) => q.startsWith("UPDATE work_items"))).toHaveLength(2);
  });

  it("remembers a failed PR read for 10 s so a down GitHub is not hammered", async () => {
    const { make } = world("needs_validation", { pr: PR, artifacts });
    const prFacts: PrFactsPort = {
      read: vi.fn(async () => {
        throw new Error("rate limited");
      }),
    };
    const adapter = make({ prFacts });
    await expect(patchStatus(adapter, "needs_merge")).rejects.toBeInstanceOf(
      WorkItemGateFactsUnavailableError
    );
    await expect(patchStatus(adapter, "needs_merge")).rejects.toBeInstanceOf(
      WorkItemGateFactsUnavailableError
    );
    expect(prFacts.read).toHaveBeenCalledTimes(1);
  });

  it("a PR head that moved after the approval is refused, with nothing written", async () => {
    const { queries, make } = world("needs_validation", { pr: PR, artifacts });
    const prFacts: PrFactsPort = { read: async () => ({ head: "b".repeat(40), merged: false }) };
    await expect(patchStatus(make({ prFacts }), "needs_merge")).rejects.toMatchObject({
      name: "WorkItemGateUnmetError",
      missing: "validation",
    });
    expect(wrote(queries)).toBe(false);
  });

  it("a back move never reads the inbox: an inbox that times out cannot 503 it", async () => {
    const stateOf = vi.fn(async () => {
      throw new Error("inbox down");
    });
    const { make } = world("needs_implementation_review", { pr: "https://node-template.cognidao.org/knowledge/inbox/contrib-code-work-0001" });
    const patched = await patchStatus(make({ inboxes: { stateOf } }), "needs_implement");
    expect(patched.status).toBe("needs_implement");
    expect(stateOf).not.toHaveBeenCalled();
  });

  it("a back move never reads the PR", async () => {
    const { make } = world("needs_validation", { pr: PR, artifacts });
    const prFacts: PrFactsPort = { read: vi.fn(async () => ({ head: HEAD, merged: false })) };
    await patchStatus(make({ prFacts }), "needs_implementation_review");
    expect(prFacts.read).not.toHaveBeenCalled();
  });
});

describe("the PR read is a dependency with its own failure signal", () => {
  const failing = (read: PrFactsPort["read"]) => ({ read });
  const warned = async (port: PrFactsPort | undefined) => {
    const warn = vi.fn();
    const { queries, make } = world("needs_implementation_review", { pr: PR });
    await expect(
      patchStatus(make({ prFacts: port, logger: { info: vi.fn(), warn, error: vi.fn() } }), "needs_validation")
    ).rejects.toMatchObject({ name: "WorkItemGateFactsUnavailableError", missing: "pr" });
    expect(wrote(queries)).toBe(false);
    return warn.mock.calls.map(([fields]) => fields as Record<string, unknown>);
  };

  it.each([
    ["a rejected read is upstream", failing(async () => { throw new Error("GitHub 502"); }), "upstream"],
    ["an aborted read is a timeout", failing(async () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); }), "timeout"],
    ["a head that is not a sha is unreadable", failing(async () => ({ head: "zz", merged: false })), "unreadable"],
    ["no port wired", undefined, "not_wired"],
  ])("%s: one warn with dep, reasonCode and durationMs, and never the message", async (_name, port, reasonCode) => {
    const calls = await warned(port);
    expect(calls).toEqual([
      {
        event: "adapter.work_items.gate_pr_read_failed",
        dep: "github_pr",
        reasonCode,
        workItemId: ID,
        durationMs: expect.any(Number),
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain("GitHub 502");
  });
});

describe("stage lines are not events", () => {
  it("a fast write emits no stage line at info; the same lines go to debug when the logger has one", async () => {
    const info = vi.fn();
    const debug = vi.fn();
    const { make } = world("needs_triage", { artifacts: [artifactRow("triage", `work:${ID}`, "design")] });
    await patchStatus(make({ logger: { info, warn: vi.fn(), error: vi.fn(), debug } }), "needs_design");
    const stage = (calls: unknown[][]) =>
      calls.filter(([fields]) => String((fields as { event?: string }).event).startsWith("adapter.work_items.stage_"));
    expect(stage(info.mock.calls)).toEqual([]);
    expect(stage(debug.mock.calls).length).toBeGreaterThan(0);
  });

  it("a logger with no debug drops the fast lines and does not throw", async () => {
    const info = vi.fn();
    const { make } = world("needs_triage", { artifacts: [artifactRow("triage", `work:${ID}`, "design")] });
    await patchStatus(make({ logger: { info, warn: vi.fn(), error: vi.fn() } }), "needs_design");
    expect(info).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "adapter.work_items.stage_complete" }),
      expect.anything()
    );
  });
});

describe("an expected gate refusal is not a stage error", () => {
  it("emits no stage_error line at any level, and still throws gate_unmet", async () => {
    const lines: Record<string, unknown>[] = [];
    const record = (fields: Record<string, unknown>) => void lines.push(fields);
    const { queries, make } = world("needs_triage");
    const adapter = make({ logger: { debug: record, info: record, warn: record, error: record } });
    await expect(patchStatus(adapter, "needs_implementation_review")).rejects.toMatchObject({
      name: "WorkItemGateUnmetError",
      missing: "path",
    });
    expect(wrote(queries)).toBe(false);
    expect(lines.filter((fields) => fields.event === "adapter.work_items.stage_error")).toEqual([]);
    expect(lines).toContainEqual(
      expect.objectContaining({ event: "adapter.work_items.stage_complete", stage: "operation", refused: "gate_unmet" })
    );
  });
});

describe("the repository pin (prRepos)", () => {
  const triage = artifactRow("triage", `work:${ID}`, "implement");
  const move = (adapter: DoltgresWorkItemAdapter) => patchStatus(adapter, "needs_implementation_review");

  it("pinned, a pull request of another repository is not a deliverable", async () => {
    const { queries, make } = world("needs_implement", { pr: OTHER_REPO_PR, artifacts: [triage] });
    await expect(move(make())).rejects.toMatchObject({ name: "WorkItemGateUnmetError", missing: "pr" });
    expect(wrote(queries)).toBe(false);
  });

  it("pinned to several repositories, a pull request of any of them is", async () => {
    const { make } = world("needs_implement", { pr: OTHER_REPO_PR, artifacts: [triage] });
    const patched = await move(make({ prRepos: ["cogni-dao/node-template", "Cogni-DAO/levelup"] }));
    expect(patched.status).toBe("needs_implementation_review");
  });

  it("unpinned, a pull request of any github.com repository is", async () => {
    const { make } = world("needs_implement", { pr: OTHER_REPO_PR, artifacts: [triage] });
    const patched = await move(make({ prRepos: undefined } as Partial<DoltgresWorkItemAdapterOptions>));
    expect(patched.status).toBe("needs_implementation_review");
  });
});

describe("deploy_verified is retired", () => {
  it("a write is logged, never dropped", async () => {
    const { make } = world("needs_implement");
    const warn = vi.fn();
    const adapter = make({ logger: { info: vi.fn(), warn, error: vi.fn() } });
    await adapter.patch(
      { id: toWorkItemId(ID), reason: "flag", set: { deployVerified: true } },
      "closer"
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "adapter.work_items.deploy_verified_write", workItemId: ID }),
      expect.any(String)
    );
  });
});

describe("the deliverable kind of pr changes only via triage", () => {
  const INBOX_URL = "https://node-template.cognidao.org/knowledge/inbox/contrib-code-work-0001";
  const setPr = (adapter: DoltgresWorkItemAdapter, pr: string, status?: string) =>
    adapter.patch(
      { id: toWorkItemId(ID), reason: "switch it", set: { pr, ...(status ? { status: status as never } : {}) } },
      "implementer"
    );

  it.each(["needs_implementation_review", "needs_validation", "needs_merge"])(
    "refuses a PR to an inbox at %s, with nothing written",
    async (status) => {
      const { queries, make } = world(status, { pr: PR });
      await expect(setPr(make(), INBOX_URL)).rejects.toMatchObject({
        name: "WorkItemGateUnmetError",
        from: status,
        missing: "path",
      });
      expect(wrote(queries)).toBe(false);
    }
  );

  it("refuses an inbox to a PR at needs_merge", async () => {
    const { queries, make } = world("needs_merge", { pr: INBOX_URL });
    await expect(setPr(make(), PR)).rejects.toMatchObject({ name: "WorkItemGateUnmetError", missing: "path" });
    expect(wrote(queries)).toBe(false);
  });

  it("allows the change in the patch that moves the item back to needs_implement", async () => {
    const { make } = world("needs_implementation_review", { pr: PR });
    const patched = await setPr(make(), INBOX_URL, "needs_implement");
    expect(patched.status).toBe("needs_implement");
  });

  it("does not touch a pr of the same kind, a first pr, or an item not yet in review", async () => {
    const same = world("needs_merge", { pr: PR });
    await expect(setPr(same.make(), OTHER)).resolves.toBeDefined();
    const early = world("needs_implement", { pr: PR });
    await expect(setPr(early.make(), INBOX_URL)).resolves.toBeDefined();
  });
});
