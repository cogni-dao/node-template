// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/adapters/doltgres-adapter-gates`
 * Purpose: Drives the move gate through DoltgresWorkItemAdapter (task.0122): the writer path refuses before it writes,
 *   every status change restamps `status_revision`, a failed PR read is a 503 that takes no lock, and the placement job is
 *   no general bypass.
 * Scope: Fake `Sql` capturing emitted SQL. The predicate itself is in `tests/gates.test.ts`.
 * Invariants:
 *   - CREATE_IS_TRIAGE_ONLY: a create with any other status is refused before any SQL.
 *   - REFUSAL_WRITES_NOTHING: a refused move emits no branch, no UPDATE and no commit.
 *   - STATUS_REVISION: a status change sets `status_revision = revision + 1`; any other patch leaves it alone.
 *   - PR_READ_BEFORE_THE_LOCK: the PR read happens before the advisory lock; a failure is `WorkItemGateFactsUnavailableError`
 *     and nothing is locked or written; a second move within 60 s reuses the read; a failure is remembered 10 s.
 *   - PLACEMENT_IS_NARROW: `place` moves only an item still in needs_merge, needs_closeout or blocked, only to a placement stage.
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
    ["needs_triage", "needs_implement", "triage"],
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
    const stale = artifactRow("triage", `work:${ID}`, "implement", {
      item_revision: STATUS_REVISION - 1,
    });
    const { queries, make } = world("needs_triage", { artifacts: [stale] });
    await expect(patchStatus(make(), "needs_implement")).rejects.toMatchObject({
      name: "WorkItemGateUnmetError",
      missing: "triage",
    });
    expect(wrote(queries)).toBe(false);
  });
});

describe("status_revision", () => {
  it("is restamped by a forward move on its exit artifact", async () => {
    const triage = artifactRow("triage", `work:${ID}`, "implement");
    const { queries, make } = world("needs_triage", { artifacts: [triage] });
    const patched = await patchStatus(make(), "needs_implement");
    expect(patched.status).toBe("needs_implement");
    const update = queries.find((q) => q.startsWith("UPDATE work_items"));
    expect(update).toContain("status = 'needs_implement'");
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

  it("a back move never reads the PR", async () => {
    const { make } = world("needs_validation", { pr: PR, artifacts });
    const prFacts: PrFactsPort = { read: vi.fn(async () => ({ head: HEAD, merged: false })) };
    await patchStatus(make({ prFacts }), "needs_implementation_review");
    expect(prFacts.read).not.toHaveBeenCalled();
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

describe("placement (the one-shot cutover)", () => {
  const INBOX = "contrib-code-work-0001";
  const INBOX_URL = `https://node-template.cognidao.org/knowledge/inbox/${INBOX}`;
  const merged: PrFactsPort = { read: async () => ({ head: HEAD, merged: true }) };
  const open: PrFactsPort = { read: async () => ({ head: HEAD, merged: false, open: true }) };
  const closed: PrFactsPort = { read: async () => ({ head: HEAD, merged: false, open: false }) };
  const inboxState = (state: { merged: boolean; open: boolean }) => ({
    stateOf: async () => ({ head: "c".repeat(32), ...state }),
  });
  const place = (adapter: DoltgresWorkItemAdapter, to: string) =>
    adapter.place({ id: toWorkItemId(ID), to: to as never }, "system:placement");
  const stamped = (queries: string[]) =>
    queries.find((q) => q.startsWith("UPDATE work_items"))?.includes("status_revision = revision + 1");

  it("places a needs_closeout item whose PR this store read merged in done, and restamps status_revision", async () => {
    const { queries, make } = world("needs_closeout", { pr: PR });
    const placed = await place(make({ prFacts: merged }), "done");
    expect(placed.status).toBe("done");
    expect(stamped(queries)).toBe(true);
  });

  it("plans from the facts it reads: merged, open, and closed without merging are three different placements", async () => {
    const planFor = async (pr: string, opts: Parameters<typeof world>[1], ports: Partial<DoltgresWorkItemAdapterOptions>) => {
      const { queries, make } = world("needs_closeout", { pr, ...opts });
      const plan = await make(ports).planPlacement(toWorkItemId(ID));
      expect(wrote(queries)).toBe(false);
      return plan?.to;
    };
    expect(await planFor(PR, {}, { prFacts: merged })).toBe("done");
    expect(await planFor(PR, {}, { prFacts: open })).toBe("needs_implementation_review");
    expect(await planFor(PR, {}, { prFacts: closed })).toBe("needs_implement");
    expect(await planFor(INBOX_URL, {}, { inboxes: inboxState({ merged: true, open: false }) })).toBe("done");
    expect(await planFor(INBOX_URL, {}, { inboxes: inboxState({ merged: false, open: true }) })).toBe("needs_implementation_review");
    expect(await planFor(INBOX_URL, {}, { inboxes: inboxState({ merged: false, open: false }) })).toBe("needs_implement");
    // A port that does not say reads as open.
    expect(await planFor(PR, {}, { prFacts: { read: async () => ({ head: HEAD, merged: false }) } })).toBe("needs_implementation_review");
  });

  it("a closed PR or closed inbox is placed in needs_implement; the open and done claims are refused", async () => {
    for (const [pr, ports] of [
      [PR, { prFacts: closed }],
      [INBOX_URL, { inboxes: inboxState({ merged: false, open: false }) }],
    ] as const) {
      const { queries, make } = world("needs_closeout", { pr });
      const adapter = make(ports);
      for (const wrong of ["needs_implementation_review", "done"]) {
        await expect(place(adapter, wrong)).rejects.toBeInstanceOf(WorkItemGateUnmetError);
      }
      expect(wrote(queries)).toBe(false);
      expect((await place(adapter, "needs_implement")).status).toBe("needs_implement");
    }
  });

  it("places an inbox the inbox port read merged in done, and an open one in implementation review", async () => {
    const mergedInbox = world("needs_closeout", { pr: INBOX_URL });
    expect(
      (await place(mergedInbox.make({ inboxes: { stateOf: async () => ({ head: "c".repeat(32), merged: true }) } }), "done")).status
    ).toBe("done");
    const openInbox = world("needs_closeout", { pr: INBOX_URL });
    expect(
      (await place(openInbox.make({ inboxes: { stateOf: async () => ({ head: "c".repeat(32), merged: false }) } }), "needs_implementation_review")).status
    ).toBe("needs_implementation_review");
  });

  it.each([
    ["an open PR", "needs_closeout", { pr: PR }, open, "needs_implementation_review"],
    ["a closeout item with no pr", "needs_closeout", {}, undefined, "needs_implement"],
    ["a blocked item", "blocked", { pr: PR }, undefined, "needs_triage"],
    ["a spike with no pr", "needs_closeout", { type: "spike" }, undefined, "needs_research"],
  ] as const)("%s goes to %s and nowhere else", async (_name, from, opts, prFacts, to) => {
    const { queries, make } = world(from, opts);
    const adapter = make(prFacts ? { prFacts } : {});
    for (const wrong of ["done", "needs_implement", "needs_research", "needs_triage", "needs_implementation_review", "needs_merge", "needs_validation", "blocked"]) {
      if (wrong === to) continue;
      await expect(place(adapter, wrong)).rejects.toBeInstanceOf(WorkItemGateUnmetError);
    }
    expect(wrote(queries)).toBe(false);
    expect((await place(adapter, to)).status).toBe(to);
  });

  it("does not trust the caller: done on an open PR is refused even though done is a placement stage", async () => {
    const { queries, make } = world("needs_closeout", { pr: PR });
    await expect(place(make({ prFacts: open }), "done")).rejects.toMatchObject({
      name: "WorkItemGateUnmetError",
      to: "done",
      missing: "path",
    });
    expect(wrote(queries)).toBe(false);
  });

  it("needs_research is for a spike only", async () => {
    const { queries, make } = world("needs_closeout", { type: "task" });
    await expect(place(make(), "needs_research")).rejects.toBeInstanceOf(WorkItemGateUnmetError);
    expect(wrote(queries)).toBe(false);
  });

  it.each(["done", "needs_implementation_review", "needs_implement", "needs_research", "needs_triage"])(
    "needs_merge is not a source: place(needs_merge -> %s) is refused and nothing is written",
    async (to) => {
      const { queries, make } = world("needs_merge", { pr: PR });
      await expect(place(make({ prFacts: merged }), to)).rejects.toBeInstanceOf(WorkItemGateUnmetError);
      expect(wrote(queries)).toBe(false);
      expect(await make({ prFacts: merged }).planPlacement(toWorkItemId(ID))).toBeUndefined();
    }
  );

  it("refuses every ladder stage as a source", async () => {
    for (const from of ["needs_implement", "needs_validation", "needs_implementation_review", "done", "needs_triage"]) {
      const { queries, make } = world(from, { pr: PR });
      await expect(place(make({ prFacts: merged }), "done")).rejects.toBeInstanceOf(WorkItemGateUnmetError);
      expect(wrote(queries)).toBe(false);
    }
  });

  it("an unreadable PR is a 503 and writes nothing; no ports wired is the same", async () => {
    const down: PrFactsPort = { read: async () => { throw new Error("github 403"); } };
    const a = world("needs_closeout", { pr: PR });
    await expect(place(a.make({ prFacts: down }), "done")).rejects.toBeInstanceOf(WorkItemGateFactsUnavailableError);
    expect(wrote(a.queries)).toBe(false);
    const b = world("needs_closeout", { pr: PR });
    await expect(place(b.make(), "done")).rejects.toBeInstanceOf(WorkItemGateFactsUnavailableError);
    expect(wrote(b.queries)).toBe(false);
  });

  it("a second run is a no-op: the placed item is no longer a source", async () => {
    const { queries, make } = world("needs_closeout", { pr: PR });
    const adapter = make({ prFacts: merged });
    expect((await place(adapter, "done")).status).toBe("done");
    const updates = () => queries.filter((q) => q.startsWith("UPDATE work_items")).length;
    expect(updates()).toBe(1);
    expect(await adapter.planPlacement(toWorkItemId(ID))).toBeUndefined();
    await expect(place(adapter, "done")).rejects.toBeInstanceOf(WorkItemGateUnmetError);
    expect(updates()).toBe(1);
  });

  it("a pr that changes between the plan and the lock is refused with nothing written", async () => {
    const { queries, make, change } = world("needs_closeout", { pr: PR });
    // The plan reads the PR merged; before the lock a writer points the item at another (unmerged) PR.
    const racing: PrFactsPort = {
      read: async () => {
        change({ pr: OTHER });
        return { head: HEAD, merged: true, open: true };
      },
    };
    await expect(place(make({ prFacts: racing }), "done")).rejects.toMatchObject({
      name: "WorkItemGateUnmetError",
      from: "needs_closeout",
      to: "done",
      missing: "path",
    });
    expect(wrote(queries)).toBe(false);
  });

  it("a status that changes between the plan and the lock is refused with nothing written", async () => {
    const { queries, make, change } = world("needs_closeout", { pr: PR });
    const racing: PrFactsPort = {
      read: async () => {
        change({ status: "blocked" });
        return { head: HEAD, merged: true, open: false };
      },
    };
    await expect(place(make({ prFacts: racing }), "done")).rejects.toMatchObject({
      name: "WorkItemGateUnmetError",
      missing: "path",
    });
    expect(wrote(queries)).toBe(false);
  });

  it("an ordinary patch of the same move is still refused", async () => {
    const { queries, make } = world("needs_closeout", { pr: PR });
    await expect(patchStatus(make({ prFacts: merged }), "done")).rejects.toMatchObject({
      name: "WorkItemGateUnmetError",
      missing: "path",
    });
    expect(wrote(queries)).toBe(false);
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
