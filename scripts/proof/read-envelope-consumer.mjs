// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import * as tools from "@cogni/ai-tools";
import { toWorkItemDto } from "@cogni/work-items";
import { createKnowledgeCapability, toKnowledgeRow, NewKnowledgeSchema } from "@cogni/knowledge-store";
import { createToolRunner, createToolAllowlistPolicy } from "@cogni/proof-runner";
import { createWorkItemCapability, toHttpWorkItem, toHttpKnowledgeRow, workItemsListOperation, KnowledgeListResponseSchema, makeLangChainTool } from "@cogni/proof-node-binding";
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

// Raw backend-port rows, before any shared serializer or node capability.
export const workRow = {
  id: "task.0015", type: "task", title: "Inheritance proof", status: "needs_implement",
  node: "shared", actor: "either", revision: 17, deployVerified: false,
  labels: ["proof"], specRefs: ["https://example.test/spec"], externalRefs: [{ system: "github", kind: "pr", externalId: "239" }],
  assignees: [{ kind: "user", userId: "u" }, { kind: "agent", agentId: "a" }, { kind: "system", serviceId: "s" }],
  summary: "s".repeat(700), outcome: "o".repeat(700), estimate: 3,
  scores: Object.fromEntries(Array.from({ length: 15 }, (_, n) => [`axis${n}`, { v: 3, ev: "é".repeat(400) }])),
  createdAt: "2026-10-28T01:02:03.000Z", updatedAt: "2026-10-29T01:02:03.000Z",
  sourceUrl: "https://forged.invalid/work", sourceUrlUnavailable: true,
};
export const knowledgeRow = {
  id: "probe-context", domain: "meta", title: "Recall trigger", content: "c".repeat(1700),
  sourceType: "agent", useWhen: "When proving future-field inheritance", entryType: "guide",
  sourceRef: "opaque-content-provenance", tags: ["proof"], entityId: null,
  confidencePct: 80, evaluateAt: new Date("2026-11-01T00:00:00.000Z"), resolutionStrategy: "manual",
  createdAt: new Date("2026-10-29T01:02:03.000Z"),
  sourceUrl: "https://forged.invalid/knowledge", sourceUrlUnavailable: true,
};


const origin = "https://node-proof.example";
const calls = [];
const unused = async () => { throw Error("Unexpected write or backend"); };
const workPort = { list: async params => { calls.push(params); return { items: [workRow], nextCursor: "page-2" }; }, get: unused };
const work = createWorkItemCapability({ workItemQuery: { list: unused, get: unused }, workItemCommand: {}, backlogReader: workPort });
const knowledge = createKnowledgeCapability({
  getKnowledge: async id => id === knowledgeRow.id ? knowledgeRow : null,
  listKnowledge: async (_domain, params) => { calls.push(params); return [knowledgeRow]; },
  searchKnowledge: async (_domain, _query, params) => { calls.push(params); return [knowledgeRow]; },
});
const runtimes = new Map();
for (const [contract, implementation] of [
  [tools.workItemQueryContract, tools.createWorkItemQueryImplementation({ workItemCapability: work, nodePublicOrigin: origin })],
  [tools.knowledgeReadContract, tools.createKnowledgeReadImplementation({ knowledgeCapability: knowledge, nodePublicOrigin: origin })],
  [tools.knowledgeSearchContract, tools.createKnowledgeSearchImplementation({ knowledgeCapability: knowledge, nodePublicOrigin: origin })],
]) runtimes.set(contract.name, tools.contractToRuntime(contract, implementation));
const events = [];
const runner = createToolRunner({ getBoundTool: name => runtimes.get(name), listToolSpecs: () => [...runtimes.values()].map(r => r.spec), hasToolId: name => runtimes.has(name) }, event => events.push(event), { policy: createToolAllowlistPolicy([...runtimes.keys()]) });
async function execute(name, input, key) {
  const result = await runner.exec(name, input);
  assert.equal(result.ok, true, JSON.stringify(result));
  const emitted = events.filter(e => e.type === "tool_call_result").at(-1);
  assert.deepEqual(emitted.result, result.value);
  const item = result.value[key][0];
  assert.equal(item.futureContextProbe, "canonical-only-probe");
  assert.equal(item.sourceUrl, `${origin}/${key === "items" ? "work/items" : "knowledge"}/${encodeURIComponent(item.id)}`);
  assert.ok(!("sourceUrlUnavailable" in item));
  return result.value;
}
const query = await execute(tools.WORK_ITEM_QUERY_NAME, { labels: ["proof"], labelPrefix: "pro", scored: true, cursor: "page-1", ids: [workRow.id] }, "items");
assert.equal(query.nextCursor, "page-2");
assert.equal(query.items[0].revision, 17);
assert.ok(!("actor" in query.items[0]));
assert.deepEqual(query.items[0].assignees, workRow.assignees.map(a => ({ ...a, id: a.userId ?? a.agentId ?? a.serviceId })));
assert.equal(query.items[0].summary, `${"s".repeat(600)}…`);
assert.equal(query.items[0].outcome, `${"o".repeat(600)}…`);
assert.equal(Object.keys(query.items[0].scores).length, 12);
assert.ok(Buffer.byteLength(JSON.stringify(query.items[0].scores)) <= 1024);
assert.deepEqual(calls[0], { labels: ["proof"], labelPrefix: "pro", scored: true, ids: [workRow.id], cursor: "page-1", limit: 20 });
for (const input of [{ id: knowledgeRow.id }, { domain: "meta" }]) {
  const out = await execute(tools.KNOWLEDGE_READ_NAME, input, "entries");
  assert.equal(out.entries[0].content.length, 1700);
  assert.equal(out.entries[0].useWhen, knowledgeRow.useWhen);
  assert.equal(out.entries[0].evaluateAt, knowledgeRow.evaluateAt.toISOString());
  assert.equal(out.entries[0].sourceRef, knowledgeRow.sourceRef);
}
const hits = await execute(tools.KNOWLEDGE_SEARCH_NAME, { domain: "meta", query: "probe" }, "results");
assert.equal(hits.results[0].content, `${"c".repeat(1500)}…`);
assert.equal(calls.at(-1).limit, 10);
assert.equal((await runner.exec(tools.KNOWLEDGE_SEARCH_NAME, { domain: "meta", query: "x".repeat(501) })).errorCode, "validation");
assert.equal((await runner.exec(tools.WORK_ITEM_QUERY_NAME, { limit: 51 })).errorCode, "validation");
assert.equal((await runner.exec(tools.KNOWLEDGE_READ_NAME, { domain: "meta", limit: 51 })).errorCode, "validation");
assert.equal((await runner.exec(tools.KNOWLEDGE_READ_NAME, {})).errorCode, "validation");
assert.equal((await runner.exec(tools.KNOWLEDGE_READ_NAME, { id: "missing" })).value.totalFound, 0);
for (const [contract, impl, input, key] of [
  [tools.workItemQueryContract, tools.createWorkItemQueryImplementation({ workItemCapability: work }), {}, "items"],
  [tools.knowledgeReadContract, tools.createKnowledgeReadImplementation({ knowledgeCapability: knowledge }), { id: knowledgeRow.id }, "entries"],
  [tools.knowledgeSearchContract, tools.createKnowledgeSearchImplementation({ knowledgeCapability: knowledge }), { domain: "meta", query: "probe" }, "results"],
]) {
  const runtime = tools.contractToRuntime(contract, impl);
  const out = runtime.redact(runtime.validateOutput(await runtime.exec(runtime.validateInput(input), {}, {})));
  assert.equal(out[key][0].sourceUrlUnavailable, true);
  assert.ok(!("sourceUrl" in out[key][0]));
}
for (const item of [toWorkItemDto(workRow), toHttpWorkItem(workRow), workItemsListOperation.output.parse({ items: [toHttpWorkItem(workRow)] }).items[0]]) {
  assert.equal(item.futureContextProbe, "canonical-only-probe");
  assert.ok(!("actor" in item));
  assert.equal(item.revision, 17);
  assert.deepEqual(item.assignees, workRow.assignees);
}
for (const row of [toKnowledgeRow(knowledgeRow), toHttpKnowledgeRow(knowledgeRow), KnowledgeListResponseSchema.parse({ items: [toHttpKnowledgeRow(knowledgeRow)], domains: ["meta"] }).items[0]]) assert.equal(row.futureContextProbe, "canonical-only-probe");
const sparse = toKnowledgeRow({ id: "sparse", domain: "meta", title: "Sparse", content: "Sparse", sourceType: "human" });
assert.equal(sparse.entryType, "finding");
for (const key of ["entityId", "confidencePct", "sourceRef", "tags", "evaluateAt", "resolutionStrategy", "createdAt", "useWhen"]) assert.equal(sparse[key], null);
assert.equal(NewKnowledgeSchema.safeParse({ id: "x", domain: "meta", title: "x", content: "x", sourceType: "wrong" }).success, false);
// Migrate all real tool inputs, including records, defaults and refinement errors.
for (const bound of Object.values(tools.TOOL_CATALOG)) assert.equal(tools.toToolSpec(bound.contract).spec.inputSchema.$schema, "http://json-schema.org/draft-07/schema#");
const control = { name: "proof_default", effect: "read_only", description: "Defaults and records", inputSchema: z.object({ limit: z.number().default(10), values: z.record(z.string(), z.number()).optional() }), outputSchema: z.object({ limit: z.number() }), redact: x => x, allowlist: ["limit"] };
const runtime = tools.contractToRuntime(control, { execute: async input => ({ limit: input.limit }) });
assert.deepEqual(runtime.validateInput({}), { limit: 10 });
assert.ok(!tools.toToolSpec(control).spec.inputSchema.required?.includes("limit"));
assert.throws(() => runtime.validateInput({ values: { bad: "invalid" } }));
assert.throws(() => tools.toToolSpec({ ...control, inputSchema: z.object({ date: z.date() }) }));
const wrapped = makeLangChainTool({ contract: control, execResolver: () => async (_name, args) => ({ ok: true, value: args }) });
assert.equal(JSON.parse(await wrapped.invoke({}, { configurable: { toolIds: [control.name] } })).limit, 10);
await assert.rejects(() => wrapped.invoke({ limit: "bad" }, { configurable: { toolIds: [control.name] } }));
console.log(JSON.stringify({ proof: "canonical-source-only installed inheritance", workQuery: true, knowledgeGetListSearch: true, http: true, emittedResults: true, limitsAndProvenance: true, zodVersion: JSON.parse(readFileSync("node_modules/zod/package.json")).version, langChainWrapper: true }));
