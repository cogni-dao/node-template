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
  OPERATOR_LANGGRAPH_CATALOG,
  PRIORITIZER_PRINCIPAL,
} from "../src/catalog";
import { createDevToolExecFn } from "../src/runtime/core/dev-tool-exec";

const WRITE_ARGS = { action: "patch", id: "task.1", priority: 3 };

describe("catalog principals (N4)", () => {
  it("names prioritizer for work-prioritizer and node-ai for brain", () => {
    expect(LANGGRAPH_CATALOG["work-prioritizer"]?.principal).toBe("prioritizer");
    expect(LANGGRAPH_CATALOG.brain?.principal).toBe("node-ai");
    expect(PRIORITIZER_PRINCIPAL).toBe("prioritizer");
    expect(NODE_AI_PRINCIPAL).toBe("node-ai");
  });

  it("gives cogni-decide the same write tool and no principal", () => {
    const decide = LANGGRAPH_CATALOG["cogni-decide"];
    const prioritizer = LANGGRAPH_CATALOG["work-prioritizer"];
    expect(decide?.principal).toBeUndefined();
    expect(decide?.toolIds).toEqual(prioritizer?.toolIds);
    expect(decide?.toolIds).toContain("core__work_item_transition");
  });

  it("keeps principals limited to the two named graphs", () => {
    const named = Object.entries(OPERATOR_LANGGRAPH_CATALOG)
      .filter(([, entry]) => "principal" in entry && entry.principal)
      .map(([name]) => name)
      .sort();
    expect(named).toEqual(["brain", "work-prioritizer"]);
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
