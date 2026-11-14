// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/langgraph-graphs/tests/agent-authority`
 * Purpose: The catalog names each graph's principal, and the dev runner guard denies scoped tools with the
 *   fixed message and a receipt through the real ai-core tool runner.
 * Scope: Catalog data + dev runner; no database.
 * Invariants: SCOPED_TOOL_NEEDS_PRINCIPAL, GUARD_COVERS_EVERY_RUNNER_SITE
 * Side-effects: none
 */

import {
  type AiEvent,
  createStaticToolSourceFromRecord,
  createToolAllowlistPolicy,
  createToolRunner,
} from "@cogni/ai-core";
import {
  type CatalogBoundTool,
  getCurrentTimeBoundTool,
  workItemTransitionBoundTool,
} from "@cogni/ai-tools";
import { guardTools } from "@cogni/agent-grants";
import { toBoundToolRuntime } from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";

import {
  LANGGRAPH_CATALOG,
  NODE_AI_PRINCIPAL,
  PRIORITIZER_PRINCIPAL,
} from "../src/catalog";
import { createDevToolExecFn } from "../src/runtime/core/dev-tool-exec";

const WRITE_ARGS = { action: "patch", id: "task.1", reason: "test change", priority: 3 };

describe("catalog principals (N4)", () => {
  it("names prioritizer for work-prioritizer and node-ai for cogni", () => {
    expect(LANGGRAPH_CATALOG["work-prioritizer"]?.principal).toBe("prioritizer");
    expect(LANGGRAPH_CATALOG.cogni?.principal).toBe("node-ai");
    expect(PRIORITIZER_PRINCIPAL).toBe("prioritizer");
    expect(NODE_AI_PRINCIPAL).toBe("node-ai");
  });

  it("gives work-prioritizer the guarded triage writer", () => {
    const ids = LANGGRAPH_CATALOG["work-prioritizer"]?.toolIds ?? [];
    expect(ids).toContain("core__work_item_update");
    expect(ids).not.toContain("core__work_item_transition");
  });

  it("gives work-closeout the guarded update writer and PR reads, as the prioritizer principal", () => {
    const entry = LANGGRAPH_CATALOG["work-closeout"];
    expect(entry?.principal).toBe(PRIORITIZER_PRINCIPAL);
    expect(entry?.toolIds).toContain("core__work_item_update");
    expect(entry?.toolIds).toContain("core__vcs_pr_read");
    expect(entry?.toolIds).toContain("core__vcs_commit_contains");
    expect(entry?.toolIds).not.toContain("core__vcs_merge_pr");
  });

  it("gives cogni no domain writer: its only write tool arranges schedules", () => {
    const ids = LANGGRAPH_CATALOG.cogni?.toolIds ?? [];
    expect(ids).toContain("core__schedule_manage");
    expect(ids).not.toContain("core__work_item_transition");
    expect(ids).not.toContain("core__work_item_update");
    expect(ids).not.toContain("core__metric_compute");
    expect(ids).not.toContain("core__knowledge_write");
  });

  it("gives cogni the account credit read, which opens only after an account owner's yes (an account-kind grant on the run's account)", () => {
    const ids = LANGGRAPH_CATALOG.cogni?.toolIds ?? [];
    expect(ids).toContain("core__account_credits_read");
    // No other catalog graph lists it: the node's AI is the only internal AI an owner can turn On for their account today.
    for (const [name, entry] of Object.entries(LANGGRAPH_CATALOG))
      if (name !== "cogni") expect(entry.toolIds, name).not.toContain("core__account_credits_read");
  });

  it("names only seeded principal slugs", () => {
    for (const entry of Object.values(LANGGRAPH_CATALOG))
      if ("principal" in entry && entry.principal)
        expect([NODE_AI_PRINCIPAL, PRIORITIZER_PRINCIPAL]).toContain(entry.principal);
  });
});

describe("dev runner guard (N6)", () => {
  const tools: Record<string, CatalogBoundTool> = {
    core__get_current_time: getCurrentTimeBoundTool as CatalogBoundTool,
    core__work_item_transition: workItemTransitionBoundTool as CatalogBoundTool,
  };

  it("runs a read_only tool and denies a scoped tool with no run scope", async () => {
    const exec = createDevToolExecFn(tools);
    const read = await exec("core__get_current_time", {}, "t1");
    expect(read.ok).toBe(true);
    const write = await exec(
      "core__work_item_transition",
      WRITE_ARGS,
      "t2"
    );
    expect(write.ok).toBe(false);
  });
});

describe("denial receipt through the real ai-core runner (V1)", () => {
  it("returns the fixed message with {code, retryable:false, lookup}", async () => {
    const runtime = toBoundToolRuntime(workItemTransitionBoundTool as CatalogBoundTool);
    const guarded = guardTools(
      { [runtime.id]: runtime },
      { [runtime.id]: workItemTransitionBoundTool.contract.requires! },
      {},
      {
        withStore: async () => {
          throw new Error("unused");
        },
        adminCheck: async () => "unavailable",
      }
    );
    const events: AiEvent[] = [];
    const runner = createToolRunner(
      createStaticToolSourceFromRecord(guarded),
      (e) => events.push(e),
      { policy: createToolAllowlistPolicy([runtime.id]), ctx: { runId: "r" } }
    );
    const result = await runner.exec(
      runtime.id,
      WRITE_ARGS,
      { modelToolCallId: "c1" }
    );
    expect(result).toMatchObject({
      ok: false,
      safeMessage: "Tool call denied by policy",
      retryable: false,
      receipt: {
        code: "policy_denied",
        retryable: false,
        lookup: { tool: runtime.id, scope: "work_item:transition" },
      },
    });
  });

  it("returns authz_unavailable on an outage", async () => {
    const runtime = toBoundToolRuntime(workItemTransitionBoundTool as CatalogBoundTool);
    const guarded = guardTools(
      { [runtime.id]: runtime },
      { [runtime.id]: workItemTransitionBoundTool.contract.requires! },
      { principalId: "p1" },
      {
        withStore: async () => {
          throw new Error("db down");
        },
        adminCheck: async () => "unavailable",
      }
    );
    const runner = createToolRunner(
      createStaticToolSourceFromRecord(guarded),
      () => {},
      { policy: createToolAllowlistPolicy([runtime.id]), ctx: { runId: "r" } }
    );
    const result = await runner.exec(runtime.id, WRITE_ARGS);
    expect(result).toMatchObject({ ok: false, receipt: { code: "authz_unavailable", retryable: false } });
  });
});
