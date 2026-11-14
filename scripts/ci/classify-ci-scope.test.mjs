// Outcome test for classify-ci-scope.mjs. Each case names the defect it catches: a wrong
// scope either skips tests a PR can break (false green) or runs everything for nothing.
import assert from "node:assert/strict";

import { classifyFiles, parseTestChain, selectUnitFilters } from "./classify-ci-scope.mjs";

const DIRS = ["app", "graphs", "packages/ids", "packages/metrics"];
const scopeOf = (files) => classifyFiles(files, DIRS).scope;

const CASES = [
  // Defect: docs-only PRs keep paying for install + build + tests.
  ["docs and markdown only is docs-only", () => assert.equal(scopeOf(["docs/spec/a.md", "packages/ids/README.md"]), "docs-only")],
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
    const result = classifyFiles(["docs/a.md", "packages/ids/src/a.ts"], DIRS);
    assert.equal(result.scope, "affected");
    assert.deepEqual(result.packages, ["packages/ids"]);
  }],
  // Defect: the curated chain stops owning what runs, or selection reorders/invents packages.
  ["unit selection is the curated chain intersected with the affected set, in chain order", () => {
    const chain = parseTestChain('node a && pnpm --filter @x/b test && pnpm --filter @x/a test && pnpm --filter "@x/c" test');
    assert.deepEqual(chain, ["@x/b", "@x/a", "@x/c"]);
    assert.deepEqual(selectUnitFilters(chain, ["@x/c", "@x/b", "@x/not-in-chain"]), ["@x/b", "@x/c"]);
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
