// Outcome tests for the node-ci scripts (classifier, unit runner). Each case names the defect it catches: a wrong
// scope either skips tests a PR can break (false green) or runs everything for nothing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyFiles, decide, parseTestChain, selectUnitFilters } from "./classify-ci-scope.mjs";
import { parseShard, planShard, pureChain, selectUnitRun, vitestCommand } from "./run-unit-tests.mjs";
import { findUndeclaredWorkspaceEdges } from "./workspace-edges.mjs";

const DIRS = ["app", "graphs", "packages/ids", "packages/metrics"];
const scopeOf = (files) => classifyFiles(files, DIRS).scope;

const CASES = [
  // Defect: docs-only PRs keep paying for install + build + tests.
  ["docs and markdown only is docs-only", () => assert.equal(scopeOf(["docs/spec/overview.png", "packages/ids/README.md"]), "docs-only")],
  // Defect: a unit test reads root CLAUDE.md/AGENTS.md, so skipping unit on their edit is a false green.
  ["root CLAUDE.md is not docs-only", () => assert.notEqual(scopeOf(["CLAUDE.md"]), "docs-only")],
  // Defect: a workflow, script or lockfile change scoped down hides breakage in every package.
  ...[".github/workflows/ci.yaml", "scripts/ci/x.mjs", "pnpm-lock.yaml", "package.json", "tsconfig.base.json", "packages/ids/tsconfig.json"].map((file) => [
    `${file} runs full`,
    () => assert.equal(scopeOf([file, "packages/ids/src/a.ts"]), "full"),
  ]),
  // Defect: a file no package owns (config, infra) can be read by path from a test.
  ["a file outside every workspace package runs full", () => assert.equal(scopeOf(["infra/x.yaml"]), "full")],
  // Defect: fail-open on an empty or unreadable diff.
  ["an empty diff runs full", () => assert.equal(scopeOf([]), "full")],
  // Defect: a doc riding along with code must not hide the code change.
  ["docs plus a package change is affected, naming the package", () => {
    const result = classifyFiles(["docs/diagram.png","packages/ids/src/a.ts"], DIRS);
    assert.equal(result.scope, "affected");
    assert.deepEqual(result.packages, ["packages/ids"]);
  }],
  // Defect: the curated chain stops owning what runs, or selection reorders/invents packages.
  ["unit selection is the curated chain intersected with the affected set, in chain order", () => {
    const chain = parseTestChain('node a && pnpm --filter @x/b test && pnpm --filter @x/a test && pnpm --filter "@x/c" test');
    assert.deepEqual(chain, ["@x/b", "@x/a", "@x/c"]);
    assert.deepEqual(selectUnitFilters(chain, ["@x/c", "@x/b", "@x/not-in-chain"]), ["@x/b", "@x/c"]);
  }],
  // Defect: a package test importing another package's source by path is invisible to pnpm's
  // graph, so an app-only change would skip that test (false green). Declared (even aliased) is fine.
  ["an undeclared cross-package relative import is found; a declared or aliased one is not", () => {
    const pkgs = [
      { name: "@x/app", dir: "app" },
      { name: "@x/lib", dir: "packages/lib" },
      { name: "@x/ui", dir: "packages/ui" },
    ];
    const manifests = {
      "app/package.json": { dependencies: { "@x/ui-alias": "workspace:@x/ui@*" } },
      "packages/lib/package.json": {},
      "packages/ui/package.json": {},
    };
    const sources = {
      "packages/ui/tests/a.test.ts": 'import { f } from "../../../app/src/f";',
      "app/tests/b.test.ts": 'import { g } from "../../packages/ui/src/g";\nimport { h } from "../../packages/lib/src/h";',
    };
    const read = (file) => (manifests[file] ? JSON.stringify(manifests[file]) : sources[file]);
    const edges = findUndeclaredWorkspaceEdges(pkgs, Object.keys(sources), read);
    assert.equal(edges.length, 2);
    assert.ok(edges.some((e) => e.startsWith("packages/ui/tests/a.test.ts") && e.includes("@x/app")));
    assert.ok(edges.some((e) => e.startsWith("app/tests/b.test.ts") && e.includes("@x/lib")));
  }],
  // Defect: any path through main() that is not a clean PR classification must be `full`:
  // the merge queue, main, a throwing classifier, an unresolvable base. A smaller scope there is a false green.
  ["merge_group, push, a thrown error and an unresolvable base all decide full", () => {
    const boom = () => {
      throw new Error("boom");
    };
    assert.equal(decide({ CI_EVENT: "merge_group" }, () => ({ scope: "docs-only" })).scope, "full");
    assert.equal(decide({ CI_EVENT: "push" }, () => ({ scope: "docs-only" })).scope, "full");
    assert.equal(decide({ CI_EVENT: "pull_request" }, boom).scope, "full");
    const out = join(mkdtempSync(join(tmpdir(), "ci-scope-")), "out");
    spawnSync(process.execPath, [fileURLToPath(new URL("./classify-ci-scope.mjs", import.meta.url))], {
      env: { ...process.env, CI_EVENT: "pull_request", BASE_REF: "no-such-branch-for-test", GITHUB_OUTPUT: out },
    });
    assert.match(readFileSync(out, "utf8"), /^scope=full$/m);
  }],
  // Defect: the runner re-implements a root `test` script that also does something else (a build, a
  // lint), so that step silently stops running. Anything but plain package steps runs as `pnpm test`.
  ["only a plain package chain is interpreted", () => {
    const guard = "node scripts/check-test-filters.mjs";
    assert.deepEqual(pureChain(`${guard} && pnpm --filter @x/a test && pnpm --filter "@x/b" test`), ["@x/a", "@x/b"]);
    assert.equal(pureChain("pnpm --filter @x/a test && pnpm lint"), null);
    assert.equal(pureChain("pnpm --filter @x/a test:ci"), null);
    assert.equal(pureChain(undefined), null);
  }],
  // Defect: a crashed or missing classifier (empty scope) runs a subset, so the merge queue and any
  // unscoped run would pass without the full chain. Only an explicit `affected` scope narrows.
  ["only an explicit affected scope runs a subset of the chain", () => {
    const chain = ["@x/a", "@x/b", "@x/c"];
    for (const scope of [undefined, "", "full", "docs-only"]) {
      assert.equal(selectUnitRun({ CI_SCOPE: scope, UNIT_FILTERS: "@x/b" }, chain).mode, "full", `scope ${scope}`);
    }
    const affected = selectUnitRun({ CI_SCOPE: "affected", UNIT_FILTERS: "@x/c @x/a @x/zzz" }, chain);
    assert.equal(affected.mode, "affected");
    assert.deepEqual(affected.names, ["@x/a", "@x/c"]);
    // A chain the runner cannot read is never narrowed: it runs the node's own `pnpm test:ci`.
    assert.equal(selectUnitRun({ CI_SCOPE: "affected", UNIT_FILTERS: "@x/a" }, null).mode, "full");
  }],
  // task.0138. Defect: a shard plan that drops a package, or runs one twice, makes the required `unit` gate
  // green over a suite that never ran in full (or pay twice for it). Between the shards, every package of the
  // set runs exactly once and the split package's vitest files are divided by vitest's own --shard.
  ["shards run every package exactly once, and the split package on every shard as --shard=i/N", () => {
    const names = Array.from({ length: 14 }, (_, at) => `@x/p${at}`);
    const chain = [...names.slice(0, 9), "@x/app", ...names.slice(9)];
    for (const total of [2, 3, 4, 5, 7, 14, 20]) {
      const seen = new Map();
      for (let index = 1; index <= total; index += 1) {
        const steps = planShard(chain, { index, total }, "@x/app");
        assert.deepEqual(steps.filter((step) => step.name === "@x/app").map((step) => step.args), [[`--shard=${index}/${total}`]], `split package on ${index}/${total}`);
        for (const step of steps) if (step.name !== "@x/app") seen.set(step.name, (seen.get(step.name) ?? 0) + 1);
        // Chain order is kept inside a shard, so a package that must run before another still does.
        assert.deepEqual(steps.map((step) => step.name), chain.filter((name) => steps.some((step) => step.name === name)), `order on ${index}/${total}`);
      }
      assert.deepEqual([...seen.keys()].sort(), [...names].sort(), `every package seen at ${total} shards`);
      assert.ok([...seen.values()].every((count) => count === 1), `no package twice at ${total} shards`);
    }
  }],
  // Defect: with no split package named, a shard silently runs nothing of the biggest package.
  ["without a split package every package still runs exactly once across the shards", () => {
    const chain = ["@x/a", "@x/b", "@x/c", "@x/d", "@x/e"];
    const all = [1, 2, 3].flatMap((index) => planShard(chain, { index, total: 3 }, "").map((step) => step.name));
    assert.deepEqual([...all].sort(), [...chain].sort());
  }],
  // Defect: a malformed or out-of-range shard parses to something and runs less than asked, unnoticed.
  ["a malformed shard is rejected, and an empty or 1/1 shard means unsharded", () => {
    assert.equal(parseShard(undefined), null);
    assert.equal(parseShard(""), null);
    assert.equal(parseShard("1/1"), null);
    assert.deepEqual(parseShard("2/4"), { index: 2, total: 4 });
    for (const bad of ["0/4", "5/4", "2", "2/", "/4", "a/b", "1/0", "-1/4", "1.5/4", "1/4/4"]) {
      assert.throws(() => parseShard(bad), /UNIT_SHARD/, bad);
    }
  }],
  // Defect: the split package's test script is guessed at (a chained or custom script), so a shard silently
  // runs something other than the package's own vitest invocation.
  ["only a plain `vitest run` script can be split", () => {
    assert.deepEqual(vitestCommand("vitest run"), ["run"]);
    assert.deepEqual(vitestCommand("vitest run --config vitest.config.ts"), ["run", "--config", "vitest.config.ts"]);
    for (const script of ["vitest", "vitest run && echo done", "pnpm build && vitest run", "vitest run; rm -rf .", "vitest run $(x)", "vitest run | tee", undefined, ""]) {
      assert.equal(vitestCommand(script), null, String(script));
    }
  }],
  // Defect: sharding widens a PR's affected subset back to the whole chain (no saving), or narrows a full run.
  ["a shard splits the selected set: the affected subset on a PR, the whole chain otherwise", () => {
    const chain = ["@x/a", "@x/b", "@x/c", "@x/app"];
    const affected = selectUnitRun({ CI_SCOPE: "affected", UNIT_FILTERS: "@x/b @x/app" }, chain);
    const run = [1, 2].flatMap((index) => planShard(affected.names, { index, total: 2 }, "@x/app").map((step) => step.name));
    assert.deepEqual([...run].sort(), ["@x/app", "@x/app", "@x/b"]);
  }],
];

let failed = 0;
for (const [name, run] of CASES) {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}\n${error.message}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
