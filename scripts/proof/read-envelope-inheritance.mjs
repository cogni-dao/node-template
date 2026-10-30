// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** CI-only installed-artifact falsifier. Mutates only canonical sources and raw fixtures,
 * rebuilds the real pipeline, then restores those temporary edits even on failure.
 * Run after packages:build. This intentionally belongs in CI, not the local test budget. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const proofRoot = mkdtempSync(join(tmpdir(), "cogni-read-proof-"));
const artifacts = join(proofRoot, "artifacts");
const consumer = join(proofRoot, "consumer");
mkdirSync(artifacts); mkdirSync(consumer);
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, NODE_PATH: "" } });
const capture = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
const originals = new Map();
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceSha = capture("git", ["rev-parse", "HEAD"]);
const manifest = { sourceSha, sourceOnlyMutation: [], artifacts: [], assertions: [] };
const packageDirs = ["read-contracts", "work-items", "ai-tools", "knowledge-store", "langgraph-graphs"];
try {
  for (const [path, pattern] of [
    ["packages/read-contracts/src/work-items.ts", "export const WorkItemDtoSchema = z.object({"],
    ["packages/read-contracts/src/index.ts", "export const KnowledgeRowSchema = z.object({"],
  ]) {
    const full = join(root, path); const before = readFileSync(full, "utf8");
    if (!before.includes(pattern) || before.includes("futureContextProbe")) throw Error(`Unexpected canonical source: ${path}`);
    originals.set(full, before);
    const after = before.replace(pattern, `${pattern}\n  futureContextProbe: z.string().optional(),`);
    writeFileSync(full, after);
    manifest.sourceOnlyMutation.push({ path, before: sha256(before), after: sha256(after) });
  }
  const fixturePath = join(root, "scripts/proof/read-envelope-consumer.mjs");
  const fixtureBefore = readFileSync(fixturePath, "utf8"); originals.set(fixturePath, fixtureBefore);
  const fixtureAfter = fixtureBefore.replace(/export const (workRow|knowledgeRow) = \{/g, '$&\n  futureContextProbe: "canonical-only-probe",');
  writeFileSync(fixturePath, fixtureAfter);
  manifest.sourceOnlyMutation.push({ path: "scripts/proof/read-envelope-consumer.mjs", before: sha256(fixtureBefore), after: sha256(fixtureAfter) });
  // This is deliberately the real root sequence, including final declaration closure AFTER tsc.
  run("pnpm", ["packages:build"]);
  for (const dir of packageDirs) {
    const pkg = JSON.parse(readFileSync(join(root, "packages", dir, "package.json")));
    run("npm", ["pack", "--pack-destination", artifacts], join(root, "packages", dir));
    const filename = `${pkg.name.replace(/^@/, "").replaceAll("/", "-")}-${pkg.version}.tgz`;
    manifest.artifacts.push({ name: pkg.name, version: pkg.version, filename, sha256: sha256(readFileSync(join(artifacts, filename))) });
  }
  // Compile real node-owned seams as explicit test artifacts; public deps remain external.
  const { build } = createRequire(join(root, "packages/ai-tools/package.json"))("tsup");
  const external = ["@cogni/ai-tools", "@cogni-dao/ai-tools", "@cogni/work-items", "@cogni-dao/work-items", "@cogni/knowledge-store", "@cogni-dao/knowledge-store", "@cogni-dao/read-contracts", "@cogni-dao/read-contracts/work-items", "@cogni-dao/read-contracts/knowledge", "zod", "postgres", /^@langchain\//];
  const nodeEntries = {
    "proof-runner": 'export { createToolRunner } from "'+join(root, 'packages/ai-core/src/tooling/tool-runner.ts')+'";\nexport { createToolAllowlistPolicy } from "'+join(root, 'packages/ai-core/src/tooling/runtime/tool-policy.ts')+'";\n',
    "proof-node-binding": 'export { createWorkItemCapability } from "'+join(root, 'app/src/bootstrap/capabilities/work-item.ts')+'";\nexport { toHttpWorkItem, toHttpKnowledgeRow } from "'+join(root, 'app/src/app/_facades/read-envelopes.ts')+'";\nexport { workItemsListOperation } from "'+join(root, 'packages/node-contracts/src/work.items.list.v1.contract.ts')+'";\nexport { KnowledgeListResponseSchema } from "'+join(root, 'packages/node-contracts/src/knowledge.list.v1.contract.ts')+'";\nexport { makeLangChainTool } from "'+join(root, 'packages/langgraph-graphs/src/runtime/core/langchain-tools.ts')+'";\n',
  };
  for (const [name, declarations] of [["proof-runner", true], ["proof-node-binding", false], ["ai-core", true]]) {
    const entry = name === "ai-core" ? join(root, "packages/ai-core/src/index.ts") : join(proofRoot, `${name}.ts`);
    if (nodeEntries[name]) writeFileSync(entry, nodeEntries[name]);
    const dir = join(proofRoot, name); mkdirSync(dir);
    await build({ entry: { index: entry }, outDir: join(dir, "dist"), format: ["esm"], platform: "node", splitting: false, clean: true, config: false, tsconfig: join(root, "packages/ai-tools/tsconfig.json"), external, noExternal: ["@cogni/node-contracts"], dts: declarations ? { compilerOptions: { composite: false, incremental: false, rootDir: "/" }, resolve: ["@cogni/ai-core"] } : false });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@cogni/${name}`, version: "0.0.0", type: "module", exports: { ".": { ...(declarations ? { types: "./dist/index.d.ts" } : {}), import: "./dist/index.js" } }, files: ["dist"] }));
    run("npm", ["pack", "--pack-destination", artifacts], dir);
    const filename = `cogni-${name}-0.0.0.tgz`;
    manifest.artifacts.push({ name: `@cogni/${name}`, version: "0.0.0", filename, sha256: sha256(readFileSync(join(artifacts, filename))), testArtifact: true });
  }
  const dependencies = { zod: "4.4.3", typescript: "5.9.3", "@types/node": "22.19.19", "@types/json-schema": "7.0.15", "@langchain/core": "1.1.48" };
  for (const artifact of manifest.artifacts) {
    const alias = ({ "@cogni-dao/ai-tools": "@cogni/ai-tools", "@cogni-dao/work-items": "@cogni/work-items", "@cogni-dao/knowledge-store": "@cogni/knowledge-store" })[artifact.name] ?? artifact.name;
    if (artifact.name === "@cogni/ai-core" || artifact.name === "@cogni-dao/langgraph-graphs") continue;
    dependencies[alias] = `file:${join(artifacts, artifact.filename)}`;
  }
  // Dual public/import identities are explicit artifacts, never workspace aliases.
  dependencies["@cogni-dao/work-items"] = dependencies["@cogni/work-items"];
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ type: "module", dependencies }));
  run("npm", ["install", "--ignore-scripts", "--strict-peer-deps", "--no-audit", "--no-fund"], consumer);
  copyFileSync(join(root, "scripts/proof/read-envelope-consumer.mjs"), join(consumer, "proof.mjs"));
  // Structural compatibility compiles against the actual node-owned ToolRunner artifact.
  writeFileSync(join(consumer, "consumer.ts"), `import { contractToRuntime, workItemQueryContract, createWorkItemQueryImplementation, type WorkItemCapability } from '@cogni/ai-tools';\nimport { createToolRunner, createToolAllowlistPolicy } from '@cogni/proof-runner';\nimport * as reads from '@cogni-dao/read-contracts';\nimport * as work from '@cogni/work-items';\nimport * as markdown from '@cogni/work-items/markdown';\nimport * as dolt from '@cogni/work-items/adapters/doltgres';\nimport * as leases from '@cogni/work-items/adapters/postgres';\nimport * as knowledge from '@cogni/knowledge-store';\nimport * as kd from '@cogni/knowledge-store/adapters/doltgres';\nimport * as kf from '@cogni/knowledge-store/adapters/fake';\nimport * as kc from '@cogni/knowledge-store/contribution-schemas';\nimport * as km from '@cogni/knowledge-store/migrations';\ndeclare const capability: WorkItemCapability;\nconst runtime = contractToRuntime(workItemQueryContract, createWorkItemQueryImplementation({workItemCapability: capability}));\ncreateToolRunner({getBoundTool: () => runtime, listToolSpecs: () => [runtime.spec], hasToolId: () => true}, () => {}, {policy:createToolAllowlistPolicy([runtime.id])});\n`);
  for (const [module, moduleResolution] of [["NodeNext", "NodeNext"], ["ESNext", "Bundler"]]) {
    writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { module, moduleResolution, target: "ES2022", strict: true, noEmit: true, skipLibCheck: false, types: ["node"] }, files: ["consumer.ts"] }));
    run("node", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], consumer);
  }
  run("node", ["proof.mjs"], consumer);
  manifest.assertions.push("No ai-core installed: NodeNext + Bundler declaration closure and structural ToolRunner compatibility", "Actual HTTP/capability/tool/ToolRunner execution, redaction and emitted results", "Source-only futureContextProbe through work query and knowledge get/list/search", "Bounds, provenance, null/default/date/revision/assignee and real LangChain wrapper controls");
  // All public export JS, then full existing LangGraph peer closure with explicit node-owned core.
  const graph = manifest.artifacts.find(a => a.name === "@cogni-dao/langgraph-graphs");
  const core = manifest.artifacts.find(a => a.name === "@cogni/ai-core");
  dependencies["@cogni/ai-core"] = `file:${join(artifacts, core.filename)}`;
  dependencies["@cogni/langgraph-graphs"] = `file:${join(artifacts, graph.filename)}`;
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ type: "module", dependencies }));
  run("npm", ["install", "--ignore-scripts", "--strict-peer-deps", "--no-audit", "--no-fund"], consumer);
  writeFileSync(join(consumer, "imports.mjs"), `import { readFileSync } from 'node:fs';\nfor (const name of ${JSON.stringify(Object.keys(dependencies).filter(name => name.startsWith("@cogni")))}) { const pkg=JSON.parse(readFileSync('node_modules/'+name+'/package.json')); for(const sub of Object.keys(pkg.exports)) { const spec=sub==='.'?name:name+sub.slice(1); await import(spec); console.log('Imported '+spec); } }\n`);
  run("node", ["imports.mjs"], consumer);
  const typesBefore = readFileSync(join(consumer, "consumer.ts"), "utf8");
  writeFileSync(join(consumer, "consumer.ts"), typesBefore + "\nimport * as graphs from '@cogni/langgraph-graphs';\nimport * as graphRuntime from '@cogni/langgraph-graphs/runtime';\nimport * as factories from '@cogni/langgraph-graphs/graphs';\nimport * as inproc from '@cogni/langgraph-graphs/inproc';\n");
  for (const [module, moduleResolution] of [["NodeNext", "NodeNext"], ["ESNext", "Bundler"]]) {
    writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { module, moduleResolution, target: "ES2022", strict: true, noEmit: true, skipLibCheck: false, types: ["node"] }, files: ["consumer.ts"] }));
    run("node", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], consumer);
  }
  manifest.installedDependencies = dependencies;
  manifest.result = "PASS";
} finally {
  for (const [path, original] of originals) writeFileSync(path, original);
  manifest.restoredTemporarySourceProbe = [...originals].every(([path, original]) => readFileSync(path, "utf8") === original);
  const receipt = join(root, ".context/read-envelope-proof.json");
  mkdirSync(join(root, ".context"), { recursive: true });
  writeFileSync(receipt, JSON.stringify(manifest, null, 2));
  console.log(`Proof receipt: ${receipt}; isolated artifacts: ${proofRoot}`);
}
