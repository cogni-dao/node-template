// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import {
  type AiEvent,
  type BoundToolRuntime,
  createStaticToolSource,
  createToolRunner,
  type ToolSpec,
} from "@cogni/ai-core";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CompletionFn, CreateGraphFn } from "../../src/inproc";
import { createInProcGraphRunner } from "../../src/inproc";

const schema: ToolSpec["inputSchema"] = {
  type: "object",
  description: "Create a product",
  properties: {
    product: {
      type: "object",
      description: "Product details",
      properties: {
        name: {
          type: "string",
          description: "Product name",
          minLength: 2,
          maxLength: 40,
        },
        tags: {
          type: "array",
          description: "Product tags",
          minItems: 1,
          maxItems: 3,
          items: { type: "string", minLength: 2, maxLength: 12 },
        },
      },
      required: ["name", "tags"],
      additionalProperties: false,
    },
  },
  required: ["product"],
  additionalProperties: false,
};

const spec: ToolSpec = {
  name: "product__create",
  description: "Create a product",
  inputSchema: schema,
  effect: "external_side_effect",
  redaction: { mode: "top_level_only", allowlist: [] },
};

const validArgs = { product: { name: "Widget", tags: ["sale"] } };
const invalidArgs = { product: { name: "W", tags: [] } };
const productInput = z
  .object({
    product: z
      .object({
        name: z.string().min(2).max(40),
        tags: z.array(z.string().min(2).max(12)).min(1).max(3),
      })
      .strict(),
  })
  .strict();
const nativeContract = {
  name: "native__echo",
  description: "Native echo",
  effect: "read_only" as const,
  inputSchema: z.object({ message: z.string().describe("Echo message") }),
  outputSchema: z.object({ id: z.string() }),
  allowlist: ["id"],
  redact: (output: { id: string }) => output,
};

describe("product ToolSpec through the public runner", () => {
  it.each([
    { mode: "allowed", args: validArgs },
    { mode: "denied", args: validArgs },
    { mode: "denied", args: {} },
    { mode: "denied", args: invalidArgs },
    { mode: "invalid", args: {} },
    { mode: "invalid", args: invalidArgs },
    { mode: "policy", args: {} },
    { mode: "native", args: { message: "hello" } },
  ])(
    "advertises exact schema and preserves host $mode for $args",
    async ({ mode, args }) => {
      const name = mode === "native" ? nativeContract.name : spec.name;
      const receipt = {
        code: "policy_denied",
        retryable: false as const,
        lookup: { scope: "product:create" },
      };
      const validateInput = vi.fn((raw: unknown) =>
        // Raw MCP runtimes accept records; capability denial must still be reached.
        mode === "denied"
          ? z.record(z.unknown()).parse(raw)
          : productInput.parse(raw),
      );
      const execute = vi.fn(async () => {
        if (mode === "denied")
          throw Object.assign(new Error("Denied"), { receipt });
        return { id: "p1" };
      });
      const runtime: BoundToolRuntime = {
        id: spec.name,
        spec,
        effect: spec.effect,
        requiresConnection: false,
        capabilities: [],
        validateInput,
        exec: execute,
        validateOutput: (raw) => raw,
        redact: (raw) => raw,
      };
      const source = createStaticToolSource([
        runtime,
        {
          ...runtime,
          id: nativeContract.name,
          spec: {
            ...spec,
            name: nativeContract.name,
            description: nativeContract.description,
            effect: nativeContract.effect,
            inputSchema: {
              type: "object",
              properties: {
                message: { type: "string", description: "Echo message" },
              },
              required: ["message"],
            },
          },
          effect: nativeContract.effect,
          validateInput: (raw) => nativeContract.inputSchema.parse(raw),
        },
      ]);
      const completions: Parameters<CompletionFn>[0][] = [];
      const completionFn: CompletionFn = (params) => {
        completions.push(params);
        const first = completions.length === 1;
        return {
          stream: (async function* () {})(),
          final: Promise.resolve(
            first
              ? {
                  ok: true,
                  content: "",
                  toolCalls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: { name, arguments: JSON.stringify(args) },
                    },
                  ],
                  finishReason: "tool_calls",
                }
              : { ok: true, content: "done", finishReason: "stop" },
          ),
        };
      };
      const observeTool = vi.fn();
      const dispatch = vi.fn();
      const run = createInProcGraphRunner({
        createGraph: Object.assign(
          ({ llm, tools }: Parameters<CreateGraphFn>[0]) =>
            createReactAgent({ llm, tools }),
          { createRunHooks: () => ({ observeTool }) },
        ),
        completionFn,
        createToolExecFn: (emit) => {
          const host = createToolRunner(source, emit, {
            policy: { decide: () => (mode === "policy" ? "deny" : "allow") },
            ctx: { runId: "schema-run" },
          });
          dispatch.mockImplementation((toolName, raw, toolCallId) =>
            host.exec(toolName, raw, { modelToolCallId: toolCallId }),
          );
          return dispatch;
        },
        toolContracts: [nativeContract],
        mcpToolSpecs: [spec],
        request: {
          runId: "schema-run",
          messages: [{ role: "user", content: "Create product" }],
          configurable: {
            model: "test-model",
            toolIds: [spec.name, nativeContract.name],
            actorId: "actor-1",
          },
        },
      });
      const events: AiEvent[] = [];
      for await (const event of run.stream) events.push(event);
      expect((await run.final).ok).toBe(true);
      expect(completions).toHaveLength(2);
      expect(completions[0]?.model).toBe("test-model");
      const advertisedProduct = {
        type: "function",
        function: {
          name: spec.name,
          description: spec.description,
          parameters: schema,
        },
      };
      for (const completion of completions) {
        expect(completion.tools).toContainEqual(advertisedProduct);
        expect(completion.tools).toContainEqual({
          type: "function",
          function: {
            name: nativeContract.name,
            description: nativeContract.description,
            parameters: expect.objectContaining({
              properties: {
                message: { type: "string", description: "Echo message" },
              },
              required: ["message"],
            }),
          },
        });
      }
      expect(dispatch).toHaveBeenCalledExactlyOnceWith(name, args, undefined);
      expect(observeTool).toHaveBeenCalledOnce();
      const toolMessage = completions[1]?.messages.find(
        (message) => message.role === "tool",
      );
      const results = events.filter(
        (event) => event.type === "tool_call_result",
      );
      expect(results).toHaveLength(1);
      if (mode === "denied") {
        expect(validateInput).toHaveBeenCalledExactlyOnceWith(args);
        expect(execute).toHaveBeenCalledOnce();
        expect(toolMessage?.content).toBe(
          JSON.stringify({
            error: "policy_denied",
            message: "Denied",
            retryable: false,
            lookup: receipt.lookup,
          }),
        );
        expect(results[0]).toMatchObject({
          isError: true,
          result: {
            error: "Denied",
            errorCode: "policy_denied",
            retryable: false,
            lookup: receipt.lookup,
          },
        });
      } else if (mode === "invalid") {
        expect(validateInput).toHaveBeenCalledExactlyOnceWith(args);
        expect(execute).not.toHaveBeenCalled();
        expect(JSON.parse(toolMessage?.content ?? "{}")).toMatchObject({
          error: "validation",
        });
        expect(results[0]).toMatchObject({
          isError: true,
          result: { error: expect.stringContaining("product") },
        });
        expect(events.some((event) => event.type === "tool_call_start")).toBe(
          false,
        );
      } else if (mode === "policy") {
        expect(validateInput).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        expect(JSON.parse(toolMessage?.content ?? "{}")).toMatchObject({
          error: "policy_denied",
        });
        expect(results[0]).toMatchObject({
          isError: true,
          result: { error: expect.stringContaining("policy") },
        });
      } else {
        expect(execute).toHaveBeenCalledOnce();
        expect(toolMessage?.content).toBe(JSON.stringify({ id: "p1" }));
        expect(results[0]).toMatchObject({ result: { id: "p1" } });
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "tool_call_start",
            toolName: name,
            args,
          }),
        );
      }
    },
  );
});
