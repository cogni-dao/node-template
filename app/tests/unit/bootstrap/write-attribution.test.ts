// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/write-attribution`
 * Purpose: Every writer records the acting principal as its actor and the run's subject as its requester (hub activity-attribution, task.0133).
 * Scope: One case per writer kind with principal P and subject S: a work-item patch by tool and by route, an artifact by tool and by route,
 *   an EDO write by tool and by route. Each runs the host's real builders over the real launcher scope, with the write port stubbed. A static
 *   check fails when a write module imports `scopeUserId`. A new writer kind adds its case here.
 * Invariants:
 *   - ACTOR_IS_THE_PRINCIPAL: a run write's actor is P, never S, and a run with no principal writes nothing.
 *   - REQUESTER_IS_THE_SUBJECT: a run write records S as the requester and the run's id and kind; a route write has neither.
 *   - NO_SCOPE_USER_ID: no write module imports `scopeUserId`.
 * Side-effects: IO (reads source files for the static check)
 * Links: src/bootstrap/run-attribution.ts, packages/work-items/src/attribution.ts, hub activity-attribution
 * @internal
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import {
  FakeEdoResolverAdapter,
  FakeKnowledgeStoreAdapter,
} from "@cogni/knowledge-store/adapters/fake";
import { bindEdoToolCapability, createEdoCapability } from "@cogni/knowledge-store";
import type {
  WorkItemCommandPort,
  WorkItemQueryPort,
} from "@cogni/work-items";
import { beforeEach, describe, expect, it, vi } from "vitest";

const attributionLog = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("@/shared/observability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/observability")>()),
  makeLogger: () => attributionLog,
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging: (_options: unknown, handler: unknown) => handler,
}));
vi.mock("@/app/_lib/auth/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/bootstrap/container", () => ({ getContainer: vi.fn() }));

import { handleHypothesize } from "@/app/api/v1/edo/_handlers";
import { POST as artifactPOST } from "@/app/api/v1/work/items/[id]/artifacts/route";
import { PATCH as itemPATCH } from "@/app/api/v1/work/items/[id]/route";
import {
  getExecutionScope,
  runInScope,
} from "@/adapters/server/ai/execution-scope";
import { createWorkItemCapability } from "@/bootstrap/capabilities/work-item";
import { getContainer } from "@/bootstrap/container";
import { runGraphWithScope } from "@/bootstrap/graph-executor.factory";
import { runAttribution } from "@/bootstrap/run-attribution";

const P = "node-ai-principal";
const S = "schedule-owner";
const RUN = { id: "run-42", kind: "system_scheduled" } as const;

/**
 * Runs `fn` the way a graph tool call does: the real launcher builds the scope (subject S, the run), and the tool guard
 * binds the catalog principal around the call (`runAs`).
 */
function inRun<T>(
  options: { principal?: string; subject?: string; runKind?: typeof RUN.kind },
  fn: () => Promise<T>
): Promise<T> {
  let result: Promise<T> | undefined;
  runGraphWithScope({
    executor: {
      runGraph: () => {
        result = runInScope(
          {
            ...getExecutionScope(),
            ...(options.principal ? { principalId: options.principal } : {}),
          },
          fn
        );
        return {
          stream: (async function* () {})(),
          final: Promise.resolve({ ok: true }),
        } as never;
      },
    } as never,
    req: {
      runId: RUN.id,
      graphId: "langgraph:work-prioritizer",
      messages: [],
      modelRef: { providerKey: "platform", modelId: "m" },
    } as never,
    ctx: options.subject ? { actorUserId: options.subject } : {},
    billing: { billingAccountId: "b", virtualKeyId: "v" },
    llmService: {} as never,
    usageSource: "litellm",
    ...(options.runKind ? { runKind: options.runKind } : {}),
  });
  return result as Promise<T>;
}

const RUN_ATTRIBUTION = { actor: P, requestedBy: S, run: RUN };
const ROUTE_ATTRIBUTION = { actor: P };

const item = {
  id: "task.0001",
  type: "task",
  title: "t",
  status: "needs_implement",
  priority: 2,
  rank: 0,
  estimate: 1,
  summary: "s",
  outcome: "",
  assignees: [],
  externalRefs: [],
  labels: [],
  specRefs: [],
  revision: 8,
  deployVerified: false,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-02",
};
const artifactBody = {
  kind: "triage",
  subject: "work:task.0001",
  verdict: "design",
  note: "no KPI measures this yet",
};
const ports = {
  workItemQuery: { list: vi.fn(), get: vi.fn() } as unknown as WorkItemQueryPort,
  workItemCommand: {} as unknown as WorkItemCommandPort,
};
const routeCtx = { log: { info: vi.fn(), warn: vi.fn() }, reqId: "req-1", routeId: "t" };

type RouteHandler = (
  ctx: unknown,
  request: Request,
  user: unknown,
  route: unknown
) => Promise<Response>;

const patchWrite = vi.fn();
const artifactInsert = vi.fn();
const artifactDeps = {
  items: { get: async () => ({ revision: 3 }) },
  artifacts: { insert: artifactInsert, list: vi.fn(), latest: vi.fn() },
};

beforeEach(() => {
  vi.clearAllMocks();
  patchWrite.mockResolvedValue(item);
  artifactInsert.mockImplementation(async (row: { itemId: string }) => ({
    id: "wia-1",
    seq: 1,
    itemRevision: 3,
    createdAt: "2026-11-18T00:00:00.000Z",
    ...row,
    author: "stamped",
  }));
});

describe("a work-item patch records the acting principal (task.0133)", () => {
  const capability = () =>
    createWorkItemCapability({
      ...ports,
      backlogWriter: {
        store: { patch: patchWrite },
        attribution: runAttribution,
      },
    });
  const patchInput = { id: "task.0001", reason: "scheduled triage", set: { summary: "s" } };

  it("by tool: the actor is P, the requester is S, and the run is recorded", async () => {
    await inRun({ principal: P, subject: S, runKind: RUN.kind }, () =>
      capability().patch(patchInput)
    );
    expect(patchWrite).toHaveBeenCalledOnce();
    expect(patchWrite.mock.calls[0]?.[1]).toEqual(RUN_ATTRIBUTION);
  });

  it("by route: the actor is the caller; there is no requester and no run", async () => {
    vi.mocked(getContainer).mockReturnValue({
      doltgresWorkItems: { patch: patchWrite },
    } as never);
    const response = await (itemPATCH as unknown as RouteHandler)(
      routeCtx,
      new Request("http://localhost/api/v1/work/items/task.0001", {
        method: "PATCH",
        body: JSON.stringify(patchInput),
      }),
      { id: P },
      { params: Promise.resolve({ id: "task.0001" }) }
    );
    expect(response.status).toBe(200);
    expect(patchWrite.mock.calls[0]?.[1]).toEqual(ROUTE_ATTRIBUTION);
  });

  it("fails closed: a run with a subject and no principal writes nothing, and the subject is never the actor", async () => {
    await expect(
      inRun({ subject: S, runKind: RUN.kind }, () => capability().patch(patchInput))
    ).rejects.toThrow("no acting principal");
    expect(patchWrite).not.toHaveBeenCalled();
  });

  it("an unknown run never blocks the write: the actor and requester are recorded, the Run is omitted, and one event says so", async () => {
    // The host named no kind: the run record was missing, null or unreadable.
    await inRun({ principal: P, subject: S }, () => capability().patch(patchInput));
    expect(patchWrite).toHaveBeenCalledOnce();
    expect(patchWrite.mock.calls[0]?.[1]).toEqual({ actor: P, requestedBy: S });
    expect(attributionLog.warn).toHaveBeenCalledOnce();
    expect(attributionLog.warn.mock.calls[0]?.[0]).toMatchObject({
      event: "work.items.attribution_run_missing",
      runId: RUN.id,
      hasRunKind: false,
    });
  });

  it("a known run emits no run-missing event", async () => {
    await inRun({ principal: P, subject: S, runKind: RUN.kind }, () => capability().patch(patchInput));
    expect(attributionLog.warn).not.toHaveBeenCalled();
  });

  it("a refused attribution ends in the same refused event a patch always uses, and writes nothing", async () => {
    const attributionDenied = vi.fn();
    const cap = createWorkItemCapability({
      ...ports,
      backlogWriter: { store: { patch: patchWrite }, attribution: runAttribution, attributionDenied },
    });
    await expect(
      inRun({ subject: S, runKind: RUN.kind }, () => cap.patch(patchInput))
    ).rejects.toThrow("no acting principal");
    expect(attributionDenied).toHaveBeenCalledWith({ workItemId: "task.0001", error: expect.any(Error) });
    expect(patchWrite).not.toHaveBeenCalled();
  });

  it("a run with a principal and no subject records no requester", async () => {
    await inRun({ principal: P, runKind: RUN.kind }, () => capability().patch(patchInput));
    expect(patchWrite.mock.calls[0]?.[1]).toEqual({ actor: P, run: RUN });
  });
});

describe("an artifact records the acting principal (task.0133)", () => {
  it("by tool: the actor is P, the requester is S, and the run is recorded", async () => {
    const cap = createWorkItemCapability({
      ...ports,
      artifacts: { attribution: runAttribution, deps: () => artifactDeps as never },
    });
    const result = await inRun({ principal: P, subject: S, runKind: RUN.kind }, async () =>
      cap.recordArtifact?.({ id: "task.0001", body: artifactBody })
    );
    expect(result?.status).toBe(201);
    expect(artifactInsert.mock.calls[0]?.[0]).toMatchObject({
      itemId: "task.0001",
      attribution: RUN_ATTRIBUTION,
    });
  });

  it("a refused attribution logs the artifact refusal with its code, writes nothing, and the success log carries actor, requester and run", async () => {
    const log = vi.fn();
    const cap = createWorkItemCapability({
      ...ports,
      artifacts: { attribution: runAttribution, deps: () => artifactDeps as never, log },
    });
    await expect(
      inRun({ subject: S, runKind: RUN.kind }, async () => cap.recordArtifact?.({ id: "task.0001", body: artifactBody }))
    ).rejects.toThrow("no acting principal");
    expect(artifactInsert).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toMatchObject({
      event: "work.items.artifact_refused",
      status: 403,
      outcome: "refused",
      errorCode: "attribution_denied",
      workItemId: "task.0001",
    });
    log.mockClear();
    await inRun({ principal: P, subject: S, runKind: RUN.kind }, async () =>
      cap.recordArtifact?.({ id: "task.0001", body: artifactBody })
    );
    expect(log.mock.calls[0]?.[0]).toMatchObject({ event: "work.items.artifact_recorded", status: 201 });
    expect(log.mock.calls[0]?.[1]).toEqual(RUN_ATTRIBUTION);
  });

  it("by route: the actor is the caller; there is no requester and no run", async () => {
    vi.mocked(getContainer).mockReturnValue({
      workItemArtifacts: artifactDeps,
    } as never);
    const response = await (artifactPOST as unknown as RouteHandler)(
      routeCtx,
      new Request("http://localhost/api/v1/work/items/task.0001/artifacts", {
        method: "POST",
        body: JSON.stringify(artifactBody),
      }),
      { id: P },
      { params: Promise.resolve({ id: "task.0001" }) }
    );
    expect(response.status).toBe(201);
    expect(artifactInsert.mock.calls[0]?.[0]).toMatchObject({ attribution: ROUTE_ATTRIBUTION });
    expect(artifactInsert.mock.calls[0]?.[0].attribution).not.toHaveProperty("run");
  });
});

describe("an EDO write records the acting principal (task.0133)", () => {
  const hypothesis = {
    id: "edo-hypothesis",
    domain: "meta",
    title: "Prediction",
    content: "Will be tested",
    evaluateAt: new Date("2026-12-01T00:00:00Z"),
    sourceType: "agent" as const,
  };
  async function edoStore() {
    const store = new FakeKnowledgeStoreAdapter();
    await store.registerDomain({ id: "meta", name: "Meta" });
    return store;
  }
  const lastMessage = (store: FakeKnowledgeStoreAdapter) =>
    store.commitLog.at(-1)?.message.split("\n");

  it("by tool: the commit names P first, then S as requester and the run", async () => {
    const store = await edoStore();
    const tool = bindEdoToolCapability(
      createEdoCapability(store, new FakeEdoResolverAdapter(store)),
      runAttribution
    );
    await inRun({ principal: P, subject: S, runKind: RUN.kind }, () =>
      tool.hypothesize(hypothesis)
    );
    expect(lastMessage(store)).toEqual([
      `edo: hypothesize 'edo-hypothesis' by actor:${P}`,
      `Requested-by: ${S}`,
      `Run: ${RUN.id} ${RUN.kind}`,
    ]);
  });

  it("by tool: a run with no principal writes nothing", async () => {
    const store = await edoStore();
    const tool = bindEdoToolCapability(
      createEdoCapability(store, new FakeEdoResolverAdapter(store)),
      runAttribution
    );
    const commits = store.commitLog.length;
    await expect(
      inRun({ subject: S, runKind: RUN.kind }, () => tool.hypothesize(hypothesis))
    ).rejects.toThrow("no acting principal");
    expect(store.commitLog).toHaveLength(commits);
  });

  it("by route: the commit names the caller and carries no requester and no run", async () => {
    const store = await edoStore();
    vi.mocked(getContainer).mockReturnValue({
      edoCapability: createEdoCapability(store, new FakeEdoResolverAdapter(store)),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as never);
    const response = await handleHypothesize(
      new Request("http://localhost/api/v1/edo/hypothesize", {
        method: "POST",
        body: JSON.stringify({
          id: "edo-hypothesis",
          domain: "meta",
          title: "Prediction",
          content: "Will be tested",
          evaluateAt: "2026-12-01T00:00:00.000Z",
        }),
      }),
      { id: P, walletAddress: null, displayName: null, avatarColor: null } as never
    );
    expect(response.status).toBe(201);
    expect(lastMessage(store)).toEqual([`edo: hypothesize 'edo-hypothesis' by actor:${P}`]);
  });
});

/** An actor chosen between the subject and the principal, in either order. */
const SUBJECT_OR_PRINCIPAL =
  /subjectUserId\s*\?\?\s*[\w.]*[Pp]rincipal|[Pp]rincipal\w*\s*\?\?\s*[\w.]*subjectUserId/;

/** Code lines only: module headers may name `scopeUserId` in prose. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The files under `dir` ending `.ts` or `.tsx`, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" || name === "dist" ? [] : sources(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("no write path picks its actor from the subject or scopeUserId (task.0133)", () => {
  const app = path.resolve(__dirname, "../../../src");
  const packages = path.resolve(__dirname, "../../../../packages");
  const repoRoot = path.resolve(__dirname, "../../../..");
  // Discovered by directory, never by a hand list: every app source and every package source is read.
  const everything = [
    ...sources(app),
    ...readdirSync(packages).flatMap((name) => {
      const src = path.join(packages, name, "src");
      return existsSync(src) ? sources(src) : [];
    }),
  ];
  const rel = (file: string) => path.relative(repoRoot, file);
  const offenders = (pattern: RegExp) =>
    everything.filter((file) => pattern.test(code(readFileSync(file, "utf8")))).map(rel).sort();

  // The identity RLS and ownership use (`scopeUserId`): its definition, its re-export, and the schedule capability's owner scope.
  // A write module is never on this list; adding a file here is a reviewed decision.
  const OWNER_AND_RLS_USES = [
    "app/src/adapters/server/ai/execution-scope.ts",
    "app/src/adapters/server/index.ts",
    "app/src/bootstrap/capabilities/schedule.ts",
  ];
  // `subjectUserId ?? principal...`: the definition of `scopeUserId`, and the admin check's candidate (a permission, never a recorded actor).
  const SUBJECT_OR_PRINCIPAL_PICKS = [
    "app/src/adapters/server/ai/execution-scope.ts",
    "packages/agent-grants/src/authorize.ts",
  ];

  it("the scan reads the writers and detects both patterns", () => {
    expect(everything.length).toBeGreaterThan(500);
    expect(everything.map(rel)).toEqual(
      expect.arrayContaining([
        "app/src/bootstrap/container.ts",
        "app/src/bootstrap/capabilities/work-item.ts",
        "app/src/app/api/v1/edo/_handlers.ts",
        "packages/work-items/src/adapters/doltgres/adapter.ts",
        "packages/knowledge-store/src/edo-capability.ts",
      ])
    );
    expect(/\bscopeUserId\b/.test(code("const a = scopeUserId(scope);"))).toBe(true);
    expect(/\bscopeUserId\b/.test(code("// scopeUserId is the owner identity"))).toBe(false);
    expect(SUBJECT_OR_PRINCIPAL.test(code("const actor = scope.subjectUserId ?? scope.principalId;"))).toBe(true);
    expect(SUBJECT_OR_PRINCIPAL.test(code("const actor = principal.principalId ?? subjectUserId;"))).toBe(true);
    expect(SUBJECT_OR_PRINCIPAL.test(code("subject: scope.subjectUserId ?? null"))).toBe(false);
  });

  it("scopeUserId appears only where owner and RLS identity is meant", () => {
    expect(offenders(/\bscopeUserId\b/)).toEqual(OWNER_AND_RLS_USES);
  });

  it("no module picks `subjectUserId ?? principal` (or the reverse) outside the listed definitions", () => {
    expect(offenders(SUBJECT_OR_PRINCIPAL)).toEqual(SUBJECT_OR_PRINCIPAL_PICKS);
  });
});
