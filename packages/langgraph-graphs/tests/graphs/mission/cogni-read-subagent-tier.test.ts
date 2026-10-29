// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/tests/graphs/mission/cogni-read-subagent-tier`
 * Purpose: Proves the READ-mode subagent tier is configurable and survives a gateway reject of the tier id.
 * Scope: Real in-proc runner + real CogniCompletionAdapter with a scripted fake CompletionFn. No network.
 * Invariants:
 *   - SUBAGENT_TIER_FALLBACK: a gateway reject of the tiered model retries ONCE on the parent model, the run still answers, and a distinct fallback event is recorded
 *   - SUBAGENT_MODEL_CONFIGURABLE: configurable.subagentModel overrides the default tier id
 *   - READ_MODE_FILES_NOTHING: telemetry writes stays 0 and no write tool is bound on any path
 * Side-effects: none
 * Links: src/graphs/mission/cogni-read.ts · https://cognidao.org/work/items/task.5377
 * @internal
 */

import type { AiEvent } from "@cogni/ai-core";
import {
  EDO_DECIDE_NAME,
  edoDecideContract,
  GOAL_LIST_NAME,
  goalListContract,
  WORK_ITEM_QUERY_NAME,
  workItemQueryContract,
} from "@cogni/ai-tools";
import { describe, expect, it } from "vitest";
import {
  COGNI_READ_TOOL_IDS,
  FLASH_SUBAGENT_MODEL,
  SUBAGENT_FALLBACK_EVENT,
} from "../../../src/graphs/mission/cogni-read";
import { createMissionGraph } from "../../../src/graphs/mission/graph";
import { createInProcGraphRunner } from "../../../src/inproc/runner";
import type { CompletionFn, ToolExecFn } from "../../../src/inproc/types";

const PARENT_MODEL = "parent-model";
const CUSTOM_TIER = "custom-tier-model";

type Seen = { model: string; tools: string[] };

/** Scripted gateway: `rejectModel` fails with a provider error; every other model serves normally. */
function script(seen: Seen[], rejectModel?: string): CompletionFn {
  return (req) => {
    const tools = (req.tools ?? []).map(
      (t) => (t as { function: { name: string } }).function.name
    );
    seen.push({ model: req.model, tools });
    const done = (r: Record<string, unknown>) => ({
      stream: (async function* () {})(),
      final: Promise.resolve({ ok: true as const, finishReason: "stop", ...r }),
    });
    if (req.model === rejectModel)
      return {
        stream: (async function* () {})(),
        final: Promise.resolve({
          ok: false as const,
          error: "provider_unavailable",
        }),
      };
    const call = (id: string, name: string, args: unknown) => ({
      id,
      type: "function" as const,
      function: { name, arguments: JSON.stringify(args) },
    });
    if (tools.includes("write_todos"))
      return done({
        toolCalls: [
          call("p1", "write_todos", {
            todos: [{ content: "Delegate read", status: "in_progress" }],
          }),
        ],
      });
    // Subagent turn (any model that has the read tools bound).
    if (tools.includes(GOAL_LIST_NAME)) {
      if (!req.messages.some((m) => m.role === "tool"))
        return done({ toolCalls: [call("s1", GOAL_LIST_NAME, {})] });
      return done({
        content: "GOALS: goal-a. ITEMS: bug.9001 p0 serves goal-a.",
      });
    }
    return done({ content: "Top priority: bug.9001, serves goal-a." });
  };
}

async function run(opts: { rejectModel?: string; subagentModel?: string }) {
  const seen: Seen[] = [];
  const executed: string[] = [];
  const createToolExecFn =
    (_emit: (e: AiEvent) => void): ToolExecFn =>
    async (name) => {
      executed.push(name);
      return { ok: true, value: { goals: [] } };
    };
  const { stream, final } = createInProcGraphRunner({
    program: "cogni-chat",
    sourceContext: {
      nodeId: "test-node",
      origin: "https://test.example",
      mission: {
        content: "Test mission.",
        sourceRef: "test:mission",
        buildSha: null,
      },
    },
    createGraph: createMissionGraph,
    completionFn: script(seen, opts.rejectModel),
    createToolExecFn,
    toolContracts: [goalListContract, workItemQueryContract, edoDecideContract],
    request: {
      runId: "tier-1",
      messages: [{ role: "user", content: "what's our top priority?" }],
      configurable: {
        model: PARENT_MODEL,
        toolIds: [...COGNI_READ_TOOL_IDS],
        ...(opts.subagentModel ? { subagentModel: opts.subagentModel } : {}),
      },
    },
  });
  for await (const _ of stream) {
    /* drain */
  }
  const result = await final;
  return { seen, executed, result };
}

const telemetry = (r: Awaited<ReturnType<typeof run>>["result"]) =>
  (r.ok
    ? (r.structuredOutput as { telemetry: Record<string, unknown> })
    : undefined
  )?.telemetry ?? {};

describe("cogni READ-mode subagent tier (task.5377 review findings)", () => {
  it("falls back ONCE to the parent model when the gateway rejects the Flash tier, still answers, and records the fallback event", async () => {
    const { seen, executed, result } = await run({
      rejectModel: FLASH_SUBAGENT_MODEL,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.content).toContain("bug.9001");

    // Flash attempted exactly once (rejected), then the parent model ran the subagent read.
    expect(seen.filter((s) => s.model === FLASH_SUBAGENT_MODEL)).toHaveLength(
      1
    );
    const parentSubagentTurns = seen.filter(
      (s) => s.model === PARENT_MODEL && s.tools.includes(GOAL_LIST_NAME)
    );
    expect(parentSubagentTurns.length).toBeGreaterThanOrEqual(2);
    expect(executed).toContain(GOAL_LIST_NAME);

    const t = telemetry(result);
    expect(t.subagentFallback).toEqual({
      event: SUBAGENT_FALLBACK_EVENT,
      from: FLASH_SUBAGENT_MODEL,
      code: "provider_unavailable",
    });
    expect(t.subagentModel).toBeNull(); // ran on the parent, not the tier
    expect(t.writes).toBe(0);
    expect(seen.flatMap((s) => s.tools)).not.toContain(EDO_DECIDE_NAME);
    expect(executed).not.toContain(EDO_DECIDE_NAME);
  });

  it("does not record a fallback when the Flash tier is served", async () => {
    const { seen, result } = await run({});
    expect(result.ok).toBe(true);
    expect(seen.some((s) => s.model === FLASH_SUBAGENT_MODEL)).toBe(true);
    const t = telemetry(result);
    expect(t.subagentFallback).toBeUndefined();
    expect(t.subagentModel).toBe(FLASH_SUBAGENT_MODEL);
    expect(t.writes).toBe(0);
  });

  it("configurable.subagentModel overrides the default tier id", async () => {
    const { seen, result } = await run({ subagentModel: CUSTOM_TIER });
    expect(result.ok).toBe(true);
    expect(seen.some((s) => s.model === CUSTOM_TIER)).toBe(true);
    expect(seen.some((s) => s.model === FLASH_SUBAGENT_MODEL)).toBe(false);
    expect(telemetry(result).subagentModel).toBe(CUSTOM_TIER);
  });
});
