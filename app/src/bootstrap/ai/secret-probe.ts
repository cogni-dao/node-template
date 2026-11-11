// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/ai/secret-probe`
 * Purpose: Node-local probe tool and graph that prove secret tool arguments never reach logs, traces or history (task.0093).
 * Scope: One read_only tool that declares `secretArgs`, and one graph that offers only it. Not published, not advertised
 *   by agent discovery: it is executable by graph id (`langgraph:secret-probe`) for candidate validation only.
 * Invariants:
 *   - PROBE_IS_READ_ONLY: no principal, no scope, no write; the graph lock is the only lock
 *   - PROBE_OUTPUT_IS_NOT_THE_SECRET: output is `{ ok, length }`; the value never leaves exec
 *   - NODE_LOCAL: lives beside the composition root; a node that does not copy it has no probe
 * Side-effects: none
 * Links: packages/ai-tools/src/runtime-adapter.ts (scrub), inproc.provider.ts (run-scoped model-call mask)
 */

import {
  type CatalogBoundTool,
  type ToolContract,
  type ToolImplementation,
} from "@cogni/ai-tools";
import {
  type LangGraphCatalog,
  NODE_LANGGRAPH_CATALOG,
} from "@cogni/langgraph-graphs";
import { z } from "zod";

export const SECRET_PROBE_NAME = "node__secret_probe" as const;
export const SECRET_PROBE_GRAPH_NAME = "secret-probe" as const;

const InputSchema = z.object({
  secret: z.string().min(1).describe("The test string to send. It is never shown back."),
});
const OutputSchema = z.object({
  ok: z.boolean(),
  length: z.number(),
});
type ProbeInput = z.infer<typeof InputSchema>;
type ProbeOutput = z.infer<typeof OutputSchema>;

export const secretProbeContract: ToolContract<
  typeof SECRET_PROBE_NAME,
  ProbeInput,
  ProbeOutput,
  ProbeOutput
> = {
  name: SECRET_PROBE_NAME,
  description:
    "Probe tool for secret-argument handling. Send the test string you were given in `secret`; the tool reports only that it arrived and how long it was.",
  effect: "read_only",
  secretArgs: ["secret"],
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  redact: (output) => ({ ok: output.ok, length: output.length }),
  allowlist: ["ok", "length"],
};

export const secretProbeImplementation: ToolImplementation<ProbeInput, ProbeOutput> = {
  execute: async ({ secret }) => ({ ok: true, length: secret.length }),
};

export const secretProbeBoundTool: CatalogBoundTool = {
  contract: secretProbeContract as unknown as CatalogBoundTool["contract"],
  implementation: secretProbeImplementation as unknown as CatalogBoundTool["implementation"],
};

/** Tools this node adds to the shared bundle. */
export const NODE_LOCAL_TOOL_BUNDLE: readonly CatalogBoundTool[] = [secretProbeBoundTool];

/** Bindings the tool source needs for `NODE_LOCAL_TOOL_BUNDLE`. */
export const NODE_LOCAL_TOOL_BINDINGS = {
  [SECRET_PROBE_NAME]: secretProbeImplementation as ToolImplementation<unknown, unknown>,
} as const;

/**
 * Delivery of the canary: the user message lists the canary in numbered parts, never whole. The model joins the parts in
 * order with a hyphen and passes the joined string as `secret`, so the literal canary is never in user text, the saved
 * user message or the app's root trace input. Only the model's own tool call (scrubbed by the adapter, masked at the
 * gateway) ever holds it.
 */
export const SECRET_PROBE_JOIN = "-";
export function secretProbeUserMessage(parts: readonly string[]): string {
  return `Parts of the test string, in order:\n${parts.map((p, i) => `${i + 1}. ${p}`).join("\n")}`;
}

const PROBE_PROMPT = `You are a test harness. The user lists numbered parts of a test string. Join the parts in order, separated by a single hyphen "${SECRET_PROBE_JOIN}", into one string. Call the probe tool exactly once with that joined string as \`secret\`, then reply with one short sentence saying whether it arrived and its length. Never write the joined string in your reply. Do not call the tool again.`;

/**
 * Graphs this node adds to the shared catalog. The mission factory is the plain prompt-driven agent when no `program` is
 * declared, so this entry uses it without one.
 */
export const NODE_LOCAL_CATALOG: LangGraphCatalog = {
  [SECRET_PROBE_GRAPH_NAME]: {
    displayName: "Secret probe",
    description: "Candidate-validation harness for secret tool arguments. Not advertised.",
    toolIds: [SECRET_PROBE_NAME],
    graphFactory: NODE_LANGGRAPH_CATALOG["work-prioritizer"].graphFactory,
    systemPrompt: PROBE_PROMPT,
  },
};
