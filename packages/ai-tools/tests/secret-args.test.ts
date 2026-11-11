// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/secret-args`
 * Purpose: A tool that declares `secretArgs` never shows the value in any record the runner writes (task.0093).
 * Scope: Real ai-core tool runner + real runtime adapter. No network, no LLM.
 * Invariants: SECRET_ARGS_SCRUBBED_AT_ADAPTER, FAIL_CLOSED_ON_CLONE, CONTROL_TOOL_UNCHANGED.
 * Side-effects: none
 * Links: src/runtime-adapter.ts, src/secret-args.ts
 */

import {
  type AiEvent,
  createStaticToolSourceFromRecord,
  createToolAllowlistPolicy,
  createToolRunner,
} from "@cogni/ai-core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { toBoundToolRuntime } from "../src/runtime-adapter";
import { REDACTION_MARKER, scrubValue } from "../src/secret-args";
import type { BoundTool, ToolContract } from "../src/types";

/** Matches no regex backstop (`sk-`, `key-`, `token-`, `api-`, `cogni_ag_sk_`), so only the scrub can hide it. */
const CANARY = "zq9-canary-7f3k-banana-plum";
const CANARY_2 = "mx4-canary-8h2j-cherry-pear";

const OutputSchema = z.object({
  ok: z.boolean(),
  length: z.number(),
  echo: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

function makeTool(opts: {
  secretArgs?: readonly string[];
  execute: (input: { secret: string; label: string }) => Promise<Output>;
  redact?: (o: Output) => Record<string, unknown>;
}): BoundTool<
  "test__secret_tool",
  { secret: string; label: string },
  Output,
  Record<string, unknown>
> {
  const contract: ToolContract<
    "test__secret_tool",
    { secret: string; label: string },
    Output,
    Record<string, unknown>
  > = {
    name: "test__secret_tool",
    description: "test tool that takes a credential",
    effect: "read_only",
    ...(opts.secretArgs ? { secretArgs: opts.secretArgs } : {}),
    inputSchema: z.object({ secret: z.string(), label: z.string() }),
    outputSchema: OutputSchema,
    redact: opts.redact ?? ((o) => ({ ...o })),
    allowlist: ["ok", "length", "echo"],
  };
  return { contract, implementation: { execute: opts.execute } };
}

function run(
  tool: BoundTool<
    "test__secret_tool",
    { secret: string; label: string },
    Output,
    Record<string, unknown>
  >,
  args: unknown,
  wrap?: (r: ReturnType<typeof toBoundToolRuntime>) => ReturnType<typeof toBoundToolRuntime>
) {
  const events: AiEvent[] = [];
  const runtime = toBoundToolRuntime(tool);
  const source = createStaticToolSourceFromRecord({
    test__secret_tool: wrap ? wrap(runtime) : runtime,
  });
  const runner = createToolRunner(source, (e) => events.push(e), {
    policy: createToolAllowlistPolicy(["test__secret_tool"]),
    ctx: { runId: "run-1" },
  });
  return runner.exec("test__secret_tool", args).then((result) => ({
    result,
    events,
    everything: JSON.stringify({ result, events }),
  }));
}

describe("secretArgs: the value never reaches a runner record", () => {
  it("emits the marker in tool_call_start and hands exec the real value", async () => {
    const execute = vi.fn(async (input: { secret: string; label: string }) => ({
      ok: true,
      length: input.secret.length,
    }));
    const { result, events, everything } = await run(
      makeTool({ secretArgs: ["secret"], execute }),
      { secret: CANARY, label: "visible-label" }
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toEqual({
      secret: CANARY,
      label: "visible-label",
    });
    const start = events.find((e) => e.type === "tool_call_start");
    expect(start).toMatchObject({
      args: { secret: REDACTION_MARKER, label: "visible-label" },
    });
    expect(Object.isFrozen((start as { args: object }).args)).toBe(true);
    expect(result).toEqual({
      ok: true,
      value: { ok: true, length: CANARY.length },
    });
    expect(everything).not.toContain(CANARY);
  });

  it("scrubs an exec error message and its receipt lookup", async () => {
    const err = Object.assign(new Error(`upstream rejected ${CANARY} today`), {
      receipt: {
        code: "upstream_rejected",
        retryable: false as const,
        lookup: { sent: CANARY, other: null, label: "kept" },
      },
    });
    const { result, events, everything } = await run(
      makeTool({
        secretArgs: ["secret"],
        execute: async () => {
          throw err;
        },
      }),
      { secret: CANARY, label: "l" }
    );

    expect(result).toMatchObject({
      ok: false,
      errorCode: "execution",
      safeMessage: `upstream rejected ${REDACTION_MARKER} today`,
      receipt: {
        code: "upstream_rejected",
        retryable: false,
        lookup: { sent: REDACTION_MARKER, other: null, label: "kept" },
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: "tool_call_result",
      isError: true,
    });
    expect(everything).not.toContain(CANARY);
  });

  it("scrubs the JSON-escaped form of the value", async () => {
    const tricky = 'quote"back\\slash-secret-value';
    const { everything, result } = await run(
      makeTool({
        secretArgs: ["secret"],
        execute: async () => {
          throw new Error(`bad body ${JSON.stringify({ k: tricky })}`);
        },
      }),
      { secret: tricky, label: "l" }
    );
    expect(result.ok).toBe(false);
    expect(everything).not.toContain(tricky);
    expect(everything).not.toContain(JSON.stringify(tricky).slice(1, -1));
  });

  it("scrubs the value from output before validateOutput and after redact", async () => {
    const { result, everything } = await run(
      makeTool({
        secretArgs: ["secret"],
        execute: async (input) => ({
          ok: true,
          length: input.secret.length,
          echo: `you sent ${input.secret}`,
        }),
        // a contract redact that re-introduces the value from a field it computes
        redact: (o) => ({
          ok: o.ok,
          length: o.length,
          note: `again ${CANARY}`,
        }),
      }),
      { secret: CANARY, label: "l" }
    );
    expect(result).toMatchObject({ ok: true });
    expect(everything).not.toContain(CANARY);
    expect(everything).toContain(`again ${REDACTION_MARKER}`);
  });

  it("does not scrub a value shorter than 8 characters by substring", async () => {
    const { result } = await run(
      makeTool({
        secretArgs: ["secret"],
        execute: async () => ({ ok: true, length: 3, echo: "abc-abcdef" }),
      }),
      { secret: "abc", label: "l" }
    );
    expect(result).toMatchObject({ ok: true, value: { echo: "abc-abcdef" } });
  });

  it("returns a fixed validation message that carries no input", async () => {
    const { result, events, everything } = await run(
      makeTool({
        secretArgs: ["secret"],
        execute: async () => ({ ok: true, length: 1 }),
      }),
      { secret: CANARY, label: 42 }
    );
    expect(result).toEqual({
      ok: false,
      errorCode: "validation",
      safeMessage: "Invalid tool arguments",
    });
    expect(events.some((e) => e.type === "tool_call_start")).toBe(false);
    expect(everything).not.toContain(CANARY);
  });

  it("fails closed when a layer clones the validated object", async () => {
    const execute = vi.fn(async () => ({ ok: true, length: 1 }));
    const { result, everything } = await run(
      makeTool({ secretArgs: ["secret"], execute }),
      { secret: CANARY, label: "l" },
      (rt) => ({
        ...rt,
        validateInput: (raw: unknown) => structuredClone(rt.validateInput(raw)),
      })
    );
    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      errorCode: "execution",
      receipt: { code: "secret_args_unavailable", retryable: false },
    });
    expect(everything).not.toContain(CANARY);
  });

  it("ends the call with redaction_failed when the output object is swapped before redact", async () => {
    const { result, everything } = await run(
      makeTool({
        secretArgs: ["secret"],
        execute: async (i) => ({ ok: true, length: i.secret.length }),
      }),
      { secret: CANARY, label: "l" },
      (rt) => ({
        ...rt,
        validateOutput: (raw: unknown) => ({
          ...(rt.validateOutput(raw) as object),
        }),
      })
    );
    expect(result).toMatchObject({ ok: false, errorCode: "redaction_failed" });
    expect(everything).not.toContain(CANARY);
  });

  it("scrubs every item of an array path and a nested path", async () => {
    const contract: ToolContract<"test__nested", unknown, unknown, Record<string, unknown>> = {
      name: "test__nested",
      description: "nested secrets",
      effect: "read_only",
      secretArgs: ["auth.tokens[]", "rows[].pass"],
      inputSchema: z.object({
        auth: z.object({ tokens: z.array(z.string()), user: z.string() }),
        rows: z.array(z.object({ pass: z.string(), n: z.number() })),
      }),
      outputSchema: z.object({ ok: z.boolean() }),
      redact: (o) => ({ ...(o as object) }),
      allowlist: ["ok"] as never,
    };
    const execute = vi.fn(async () => ({ ok: true }));
    const events: AiEvent[] = [];
    const rt = toBoundToolRuntime({ contract, implementation: { execute } });
    const runner = createToolRunner(
      createStaticToolSourceFromRecord({ test__nested: rt }),
      (e) => events.push(e),
      { policy: createToolAllowlistPolicy(["test__nested"]), ctx: { runId: "r" } }
    );
    await runner.exec("test__nested", {
      auth: { tokens: [CANARY, CANARY_2], user: "alice" },
      rows: [{ pass: CANARY, n: 1 }, { pass: CANARY_2, n: 2 }],
    });
    const start = events.find((e) => e.type === "tool_call_start") as {
      args: unknown;
    };
    expect(start.args).toEqual({
      auth: { tokens: [REDACTION_MARKER, REDACTION_MARKER], user: "alice" },
      rows: [
        { pass: REDACTION_MARKER, n: 1 },
        { pass: REDACTION_MARKER, n: 2 },
      ],
    });
    expect(JSON.stringify(events)).not.toContain(CANARY);
    expect(JSON.stringify(events)).not.toContain(CANARY_2);
    expect(execute).toHaveBeenCalledWith({
      auth: { tokens: [CANARY, CANARY_2], user: "alice" },
      rows: [{ pass: CANARY, n: 1 }, { pass: CANARY_2, n: 2 }],
    });
  });
});

describe("scrubValue", () => {
  it("copies a shared, non-cyclic object or array each time it appears", () => {
    const row = { n: 1 };
    const list = [1, 2];
    expect(scrubValue({ a: row, b: row, c: list, d: list }, [CANARY])).toEqual({
      a: { n: 1 },
      b: { n: 1 },
      c: [1, 2],
      d: [1, 2],
    });
  });

  it("marks only a true cycle", () => {
    const loop: Record<string, unknown> = { n: 1 };
    loop.self = loop;
    expect(scrubValue(loop, [CANARY])).toEqual({ n: 1, self: REDACTION_MARKER });
  });

  it("lets a secret tool return the same object twice", async () => {
    const item = { n: 1 };
    const { result } = await run(
      makeTool({
        secretArgs: ["secret"],
        execute: async () => ({ ok: true, length: 1, echo: "e", a: item, b: item }) as never,
      }),
      { secret: CANARY, label: "l" }
    );
    expect(result).toMatchObject({ ok: true });
  });
});

describe("a scrubbed copy works once, and a bad path fails at bind", () => {
  it("fails closed when the same copy is replayed into exec", async () => {
    const execute = vi.fn(async () => ({ ok: true, length: 1 }));
    const rt = toBoundToolRuntime(makeTool({ secretArgs: ["secret"], execute }));
    const copy = rt.validateInput({ secret: CANARY, label: "l" });
    await rt.exec(copy, { runId: "r", toolCallId: "t" }, {});
    await expect(rt.exec(copy, { runId: "r", toolCallId: "t" }, {})).rejects.toMatchObject({
      receipt: { code: "secret_args_unavailable" },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("throws when the runtime is built with a malformed path", () => {
    expect(() =>
      toBoundToolRuntime(makeTool({ secretArgs: ["a..b["], execute: async () => ({ ok: true, length: 1 }) })),
    ).toThrow(/bad path segment/);
  });
});

describe("a tool with no secretArgs is unchanged", () => {
  it("emits the real args, passes them to exec, and keeps the zod message", async () => {
    const execute = vi.fn(async (i: { secret: string; label: string }) => ({
      ok: true,
      length: i.secret.length,
    }));
    const tool = makeTool({ execute });
    const ok = await run(tool, { secret: CANARY, label: "l" });
    expect(execute).toHaveBeenCalledWith({ secret: CANARY, label: "l" });
    expect(ok.events.find((e) => e.type === "tool_call_start")).toMatchObject({
      args: { secret: CANARY, label: "l" },
    });

    const bad = await run(tool, { secret: CANARY, label: 42 });
    expect(bad.result).toMatchObject({ ok: false, errorCode: "validation" });
    expect((bad.result as { safeMessage: string }).safeMessage).not.toBe(
      "Invalid tool arguments"
    );
  });
});
