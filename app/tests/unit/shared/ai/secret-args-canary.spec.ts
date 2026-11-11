// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/shared/ai/secret-args-canary`
 * Purpose: The node-local probe tool's secret never reaches a runner event, the assembled persisted message or the
 *   exec error path, and no `createToolRunner` call wires a span hook (task.0093).
 * Scope: Real ai-core runner + real ai-tools adapter + real message assembler over the probe contract. No LLM, no I/O.
 * Invariants: SECRET_ARGS_SCRUBBED_AT_ADAPTER, NO_SPAN_HOOKS_ON_RUNNER, CANARY_MATCHES_NO_BACKSTOP.
 * Side-effects: none (reads source files)
 * Links: src/bootstrap/ai/secret-probe.ts, packages/ai-tools/src/runtime-adapter.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  type AiEvent,
  createStaticToolSourceFromRecord,
  createToolAllowlistPolicy,
  createToolRunner,
} from "@cogni/ai-core";
import { toBoundToolRuntime } from "@cogni/ai-tools";
import { scrubStringContent } from "@cogni/node-shared";
import { describe, expect, it, vi } from "vitest";

import {
  SECRET_PROBE_NAME,
  secretProbeBoundTool,
  secretProbeImplementation,
} from "@/bootstrap/ai/secret-probe";
import { assembleAssistantMessage } from "@/features/ai/services/assemble-assistant-message";
import { redactSecretsInMessages } from "@/features/ai/public.server";

/** Matches no regex backstop, so only the scrub can hide it. */
const CANARY = "zq9-canary-7f3k-banana-plum";

function runProbe(execute = secretProbeImplementation.execute) {
  const events: AiEvent[] = [];
  const spy = vi.fn(execute);
  const runtime = toBoundToolRuntime({
    contract: secretProbeBoundTool.contract,
    implementation: { execute: spy },
  });
  const runner = createToolRunner(
    createStaticToolSourceFromRecord({ [SECRET_PROBE_NAME]: runtime }),
    (e) => events.push(e),
    { policy: createToolAllowlistPolicy([SECRET_PROBE_NAME]), ctx: { runId: "run-probe" } }
  );
  return { events, spy, exec: (args: unknown) => runner.exec(SECRET_PROBE_NAME, args, { modelToolCallId: "call1" }) };
}

describe("secret probe canary", () => {
  it("matches no regex backstop", () => {
    expect(scrubStringContent(CANARY)).toBe(CANARY);
    const [masked] = redactSecretsInMessages([
      { id: "m", role: "user", parts: [{ type: "text", text: CANARY }] },
    ]);
    expect(masked?.parts[0]).toEqual({ type: "text", text: CANARY });
  });

  it("both regex backstops now cover the cogni_ag_sk_v<n>_ agent key format", () => {
    const key = "cogni_ag_sk_v2_AbCd0123456789_-xyz";
    expect(scrubStringContent(`bearer ${key}`)).toBe("bearer [REDACTED_AGENT_KEY]");
    const part = redactSecretsInMessages([
      { id: "m", role: "user", parts: [{ type: "text", text: `use ${key} now` }] },
    ])[0]?.parts[0];
    expect(part).toEqual({ type: "text", text: "use [REDACTED_AGENT_KEY] now" });
  });

  it("is absent from events, the assembled message and JSON of both; exec saw it", async () => {
    const { events, spy, exec } = runProbe();
    const result = await exec({ secret: CANARY });

    expect(result).toEqual({ ok: true, value: { ok: true, length: CANARY.length } });
    expect(spy).toHaveBeenCalledWith({ secret: CANARY });
    events.push({ type: "assistant_final", content: "done" });
    const message = assembleAssistantMessage("run-probe", events);
    expect(message).not.toBeNull();
    expect(JSON.stringify(message)).not.toContain(CANARY);
    expect(JSON.stringify(message)).toContain("[REDACTED]");
    expect(JSON.stringify(events)).not.toContain(CANARY);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("is absent from the exec error path", async () => {
    const { events, exec } = runProbe(async (input) => {
      throw new Error(`downstream said no to ${input.secret}`);
    });
    const result = await exec({ secret: CANARY });
    expect(result).toMatchObject({ ok: false, errorCode: "execution" });
    expect(JSON.stringify({ result, events })).not.toContain(CANARY);
  });
});

describe("no createToolRunner call wires a span hook", () => {
  const ROOT = resolve(__dirname, "../../../../..");
  const SCAN = ["app/src", "packages/agent-grants/src", "packages/langgraph-graphs/src"];

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (name === "node_modules" || name === "dist") return [];
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
    });
  }

  /** Source text of each `createToolRunner(` call, through its balanced closing paren. */
  function calls(source: string): string[] {
    const out: string[] = [];
    for (const m of source.matchAll(/\bcreateToolRunner\s*\(/g)) {
      const start = (m.index ?? 0) + m[0].length;
      let depth = 1;
      let i = start;
      for (; i < source.length && depth > 0; i++) {
        if (source[i] === "(") depth++;
        else if (source[i] === ")") depth--;
      }
      out.push(source.slice(start, i - 1));
    }
    return out;
  }

  it("finds the real call sites and none passes spanInput or spanPort", () => {
    const sites: Array<{ file: string; text: string }> = [];
    for (const dir of SCAN) {
      for (const file of files(join(ROOT, dir))) {
        const src = readFileSync(file, "utf8");
        for (const text of calls(src)) sites.push({ file, text });
      }
    }
    // the provider and the dev tool exec; the guard against an empty scan
    expect(sites.length).toBeGreaterThanOrEqual(2);
    const wired = sites.filter((s) => /\bspan(Input|Port)\b/.test(s.text));
    expect(wired.map((s) => s.file)).toEqual([]);
  });
});
