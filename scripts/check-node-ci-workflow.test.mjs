// Self-tests for check-node-ci-workflow.mjs.
//
// WHY THIS FILE EXISTS: the checker's whole purpose is to prove that every context
// named in .cogni/repo-policy.json is actually emitted, on review events, by exactly
// one job that cannot skip. A checker that silently stops catching drift is worse than
// no checker — it reports "protected" while a spawned node's required check never
// reports and its default branch deadlocks. A green run against the current tree
// proves nothing about that; only a mutation that MUST fail does.
//
// Each case mutates a throwaway copy of the real workflow/policy files and asserts the
// checker exits non-zero with a recognisable message.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(REPO_ROOT, "scripts", "check-node-ci-workflow.mjs");
const ACTION = ".github/actions/node-ci/action.yml";
// node-template carries the action; a fleet node pins it by SHA and has no such file, so the cases that
// mutate the action are template-only and every other case must still run unchanged in a fleet repo.
const HAS_ACTION = existsSync(join(REPO_ROOT, ACTION));
// A node may fan its unit lane over a matrix behind a bare-named `unit` gate (task.0138); the cases that
// mutate that shape skip in a tree that keeps one plain `unit` job, which every other case still covers.
const HAS_SHARDED_UNIT = /\n  unit-shard:\n/.test(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yaml"), "utf8"));
const FILES = [
  ".github/workflows/ci.yaml",
  ...(HAS_ACTION ? [ACTION] : []),
  ".github/workflows/pr-build.yml",
  ".github/workflows/pr-lint.yaml",
  ".github/workflows/publish-packages.yml",
  ".cogni/repo-policy.json",
];

function runCheckerOn(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "node-ci-policy-"));
  for (const file of FILES) {
    cpSync(join(REPO_ROOT, file), join(dir, file), { recursive: true });
  }
  mutate({
    read: (file) => readFileSync(join(dir, file), "utf8"),
    write: (file, text) => writeFileSync(join(dir, file), text),
  });
  // The checker resolves its inputs relative to CWD, so running it from the fixture
  // dir points it at the mutated copies while `yaml` still resolves from the repo.
  const result = spawnSync(process.execPath, [CHECKER], { cwd: dir, encoding: "utf8" });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

const edit = (file, from, to) => ({ read, write }) => {
  const before = read(file);
  if (!before.includes(from)) throw new Error(`fixture anchor missing in ${file}: ${from}`);
  write(file, before.replace(from, to));
};
const actionEdit = (from, to) => Object.assign(edit(ACTION, from, to), { needsAction: true });
const shardedEdit = (from, to) => Object.assign(edit(".github/workflows/ci.yaml", from, to), { needsShardedUnit: true });
// Replace one whole top-level job of ci.yaml (from `  <id>:` to the next job or the end of the file).
const replaceJob = (id, block) => ({ read, write }) => {
  const path = ".github/workflows/ci.yaml";
  const before = read(path);
  const start = before.indexOf(`\n  ${id}:\n`);
  if (start < 0) throw new Error(`fixture job missing in ${path}: ${id}`);
  const next = before.slice(start + 1).search(/\n  [A-Za-z0-9_-]+:\n/);
  const end = next < 0 ? before.length : start + 1 + next;
  write(path, `${before.slice(0, start)}\n${block}${before.slice(end)}`);
};

const contractInstall =
  "pnpm --filter @cogni/repo-spec... install --frozen-lockfile --ignore-scripts --config.dedupe-peer-dependents=false";
const mainCacheExport =
  "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && format('type=gha,mode=max,scope=node-template-{0}', matrix.target.artifact) || '' }}";
const editPrBuildJob = (job, from, to) => ({ read, write }) => {
  const path = ".github/workflows/pr-build.yml";
  const before = read(path);
  const marker = `\n  ${job}:\n`;
  const index = before.indexOf(marker);
  if (index < 0 || !before.slice(index).includes(from)) throw new Error(`missing ${job} fixture`);
  write(path, before.slice(0, index) + before.slice(index).replace(from, to));
};

const CASES = [
  {
    name: "baseline tree passes",
    mutate: () => {},
    expectExit: 0,
  },
  ...["detect", "manifest"].map((job) => ({
    name: `${job} must not restore the full workspace install`,
    mutate: editPrBuildJob(job, contractInstall, "pnpm install --frozen-lockfile"),
    expectExit: 1,
    expectMatch: /frozen contract install/,
  })),
  {
    name: "contract installs must retain frozen lock enforcement",
    mutate: editPrBuildJob("detect", contractInstall, contractInstall.replace(" --frozen-lockfile", "")),
    expectExit: 1,
    expectMatch: /frozen contract install/,
  },
  {
    name: "contract jobs must not hydrate the broad workspace cache",
    mutate: editPrBuildJob("manifest", "          node-version: 22", "          node-version: 22\n          cache: pnpm"),
    expectExit: 1,
    expectMatch: /must not hydrate a broad Node cache/,
  },
  {
    name: "PRs must not export the trusted main image cache",
    mutate: edit(".github/workflows/pr-build.yml", mainCacheExport, "type=gha,mode=max,scope=node-template-${{ matrix.target.artifact }}"),
    expectExit: 1,
    expectMatch: /trusted main cache export/,
  },
  {
    name: "workflow dispatch must not become a main cache writer",
    mutate: edit(".github/workflows/pr-build.yml", mainCacheExport, mainCacheExport.replace("github.event_name == 'push' && ", "")),
    expectExit: 1,
    expectMatch: /trusted main cache export/,
  },
  {
    name: "the disposable image job must not restore slow Buildx teardown",
    mutate: edit(".github/workflows/pr-build.yml", "          cleanup: false", "          cleanup: true"),
    expectExit: 1,
    expectMatch: /ephemeral Buildx cleanup/,
  },
  {
    name: "omitting teardown must not silently move to a persistent runner",
    mutate: editPrBuildJob("build", "    runs-on: ubuntu-latest", "    runs-on: self-hosted"),
    expectExit: 1,
    expectMatch: /ephemeral image runner/,
  },
  {
    name: "detection must build the contract its target reader imports",
    mutate: edit(
      ".github/workflows/pr-build.yml",
      "      - name: Build repo-spec contract\n        run: pnpm --filter @cogni/repo-spec build",
      "      - name: Build repo-spec contract\n        run: pnpm check"
    ),
    expectExit: 1,
    expectMatch: /detect dependency build/,
  },
  {
    name: "a second detection step must not rerun the suite under another name",
    mutate: edit(
      ".github/workflows/pr-build.yml",
      "      - name: Detect node image targets",
      "      - name: Redundant verification\n        run: pnpm test:ci\n\n      - name: Detect node image targets"
    ),
    expectExit: 1,
    expectMatch: /jobs.detect must not duplicate CI checks or tests/,
  },
  {
    name: "removing detection checks must not remove the required unit suite",
    mutate: actionEdit('run: node "${{ github.action_path }}/scripts/run-unit-tests.mjs"',
      "run: echo tests skipped"
    ),
    expectExit: 1,
    expectMatch: /unit test command/,
  },
  {
    name: "schema verification remains owned by required static CI",
    mutate: actionEdit("run: pnpm db:check",
      "run: echo schema checks skipped"
    ),
    expectExit: 1,
    expectMatch: /static Database schema checks command/,
  },
  {
    name: "renaming a required job breaks the emitted context (the deadlock case)",
    mutate: edit(".github/workflows/ci.yaml", "\n  unit:\n", "\n  unit:\n    name: Unit Tests\n"),
    expectExit: 1,
    expectMatch: /required check "unit" must be emitted by exactly one job/,
  },
  {
    name: "a templated job name cannot be statically resolved",
    mutate: edit(".github/workflows/ci.yaml", "\n  static:\n", "\n  static:\n    name: static-${{ github.event_name }}\n"),
    expectExit: 1,
    expectMatch: /required check "static"/,
  },
  {
    name: "a matrix on a required job fans the context out per leg",
    mutate: edit(".github/workflows/ci.yaml", "\n  component:\n", "\n  component:\n    strategy:\n      matrix:\n        shard: [1, 2]\n"),
    expectExit: 1,
    expectMatch: /strategy\.matrix/,
  },
  {
    name: "a required check gated on upstream results can skip, and skip scores as success",
    mutate: edit(
      ".github/workflows/pr-build.yml",
      "  manifest:\n    needs: [resolve, detect, build]\n    if: always()",
      "  manifest:\n    needs: [resolve, detect, build]\n    if: |\n      always() &&\n      needs.detect.result == 'success'"
    ),
    expectExit: 1,
    expectMatch: /scores a skipped required check as SUCCESS/,
  },
  {
    name: "a policy context with no emitting job at all is rejected",
    mutate: edit(".cogni/repo-policy.json", '"manifest"]', '"manifest", "nonexistent-check"]'),
    expectExit: 1,
    expectMatch: /required check "nonexistent-check"/,
  },
  {
    name: "a --clobber in the publish lane makes a published version mutable",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      'gh release create "$GITHUB_REF_NAME" "${{ steps.pack.outputs.tgz }}" \\',
      'gh release upload "$GITHUB_REF_NAME" "${{ steps.pack.outputs.tgz }}" --clobber \\'
    ),
    expectExit: 1,
    expectMatch: /uses --clobber/,
  },
  {
    name: "a continue-on-error publish step cannot fail, so it proves nothing",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      "      - name: Attach the tarball to a Release\n        if: github.event_name == 'push'",
      "      - name: Attach the tarball to a Release\n        continue-on-error: true\n        if: github.event_name == 'push'"
    ),
    expectExit: 1,
    expectMatch: /continue-on-error/,
  },
  {
    name: "an ungated release step lets workflow_dispatch publish without a tag",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      "      - name: Attach the tarball to a Release\n        if: github.event_name == 'push'\n",
      "      - name: Attach the tarball to a Release\n"
    ),
    expectExit: 1,
    expectMatch: /publishes or attests but is not gated/,
  },
  {
    name: "deleting the required-checks gate lets an ungated commit be published",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      "      - name: Tagged commit must have passed every required check",
      "      - name: Tagged commit checks are assumed green"
    ),
    expectExit: 1,
    expectMatch: /Tagged commit must have passed every required check/,
  },
  {
    name: "re-adding packages: write signals a second, unreachable distribution channel",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      "  id-token: write\n  attestations: write",
      "  id-token: write\n  attestations: write\n  packages: write"
    ),
    expectExit: 1,
    expectMatch: /permissions\.packages must not be granted/,
  },
  {
    name: "building the artifact on a different Node major than CI gates it",
    mutate: edit(".github/workflows/publish-packages.yml", 'NODE_VERSION: "22"', 'NODE_VERSION: "24"'),
    expectExit: 1,
    expectMatch: /env\.NODE_VERSION must match/,
  },
  // The registry <-> tag-filter bijection. Drift in EITHER direction is silent at
  // author time and only surfaces once a tag has been pushed, which is too late.
  {
    name: "a registered package with no tag filter can never be published",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      '      - "knowledge-store-v*"\n',
      ""
    ),
    expectExit: 1,
    expectMatch: /must include the tag filter "knowledge-store-v\*"/,
  },
  {
    name: "a tag filter with no registry entry fires a run that selects nothing",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      '      - "knowledge-base-v*"\n',
      '      - "knowledge-base-v*"\n      - "node-core-v*"\n'
    ),
    expectExit: 1,
    expectMatch: /tag filter "node-core-v\*" matches no env\.PACKAGES entry/,
  },
  {
    name: "deleting a registry entry while its tag filter remains is rejected",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      '     {"name":"@cogni-dao/knowledge-base","dir":"packages/knowledge-base","tagPrefix":"knowledge-base-v"},\n',
      ""
    ),
    expectExit: 1,
    expectMatch: /tag filter "knowledge-base-v\*" matches no env\.PACKAGES entry/,
  },
  {
    name: "an unparseable registry is rejected rather than silently skipped",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      '  PACKAGES: >-\n',
      '  PACKAGES: "not json"\n  PACKAGES_OLD: >-\n'
    ),
    expectExit: 1,
    expectMatch: /env\.PACKAGES must be valid JSON/,
  },
  {
    name: "a registry entry missing its dir cannot locate the package to pack",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      '{"name":"@cogni-dao/work-items","dir":"packages/work-items","tagPrefix":"work-items-v"}',
      '{"name":"@cogni-dao/work-items","tagPrefix":"work-items-v"}'
    ),
    expectExit: 1,
    expectMatch: /env\.PACKAGES\[\d+\] must declare a non-empty string "dir"/,
  },
  {
    name: "a static matrix replaces the derived one, and matrix is not available in jobs.<id>.if",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      "        pkg: ${{ fromJSON(needs.select.outputs.packages) }}",
      '        pkg:\n          - {"name":"@cogni-dao/work-items","dir":"packages/work-items","tagPrefix":"work-items-v"}'
    ),
    expectExit: 1,
    expectMatch: /matrix\.pkg must be derived from jobs\.select/,
  },
  {
    name: "dropping jobs.select removes the thing that narrows a tag to one package",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      "  select:\n    runs-on: ubuntu-latest\n    outputs:\n      packages: ${{ steps.select.outputs.packages }}\n",
      "  select:\n    runs-on: ubuntu-latest\n"
    ),
    expectExit: 1,
    expectMatch: /jobs\.select must expose a non-empty `packages` output/,
  },
  {
    name: "publish must not run without select, or the matrix resolves to nothing",
    mutate: edit(
      ".github/workflows/publish-packages.yml",
      "  publish:\n    needs: select\n",
      "  publish:\n"
    ),
    expectExit: 1,
    expectMatch: /jobs\.publish\.needs must include "select"/,
  },
  // Defect: narrowing the full unit step to pull requests lets the merge queue pass without
  // running the full chain, so a PR-time under-selection is never caught before merge.
  {
    name: "the full unit chain must still run on merge_group",
    mutate: actionEdit("      if: inputs.lane == 'unit' && steps.scope.outputs.scope != 'docs-only'\n",
      "      if: inputs.lane == 'unit' && steps.scope.outputs.scope != 'docs-only' && github.event_name == 'pull_request'\n"
    ),
    expectExit: 1,
    expectMatch: /unit on merge_group with scope "full".*must run exactly/,
  },
  // Defect: gating the Markdown check on scope lets a docs-only PR pass with nothing verified.
  {
    name: "markdown refs must never be gated",
    mutate: actionEdit("      if: inputs.lane == 'static'\n      shell: bash\n      run: pnpm check:markdown-refs",
      "      if: inputs.lane == 'static' && steps.scope.outputs.scope != 'docs-only'\n      shell: bash\n      run: pnpm check:markdown-refs"
    ),
    expectExit: 1,
    expectMatch: /static on pull_request with scope "docs-only".*must run exactly/,
  },
  // story.0052. Defect: a lane skips work other than the build or the unit selection, so a required
  // check reports green having run less than the merge queue expects.
  {
    name: "a lane step must not be skipped by a scope it was not designed for",
    mutate: actionEdit("      if: inputs.lane == 'static' && steps.scope.outputs.scope != 'docs-only'\n      shell: bash\n      run: pnpm typecheck",
      "      if: inputs.lane == 'static' && steps.scope.outputs.scope == 'full'\n      shell: bash\n      run: pnpm typecheck"
    ),
    expectExit: 1,
    expectMatch: /static on pull_request with scope "affected".*must run exactly/,
  },
  // Defect: a step meant for one lane runs in all three (or a lane runs another lane's check).
  {
    name: "the unit suite must stay gated to the unit lane",
    mutate: actionEdit("      if: inputs.lane == 'unit' && steps.scope.outputs.scope != 'docs-only'\n", "      if: steps.scope.outputs.scope != 'docs-only'\n"),
    expectExit: 1,
    expectMatch: /"Unit tests" must be gated to the unit lane/,
  },
  // Defect: restore-keys restores a build of DIFFERENT sources and skips the build, so a lane tests stale output.
  {
    name: "the build cache may only hit on an exact input hash",
    mutate: actionEdit("          graphs/*.tsbuildinfo\n        key:", "          graphs/*.tsbuildinfo\n        restore-keys: node-ci-build-v1-\n        key:"),
    expectExit: 1,
    expectMatch: /build_cache must not set restore-keys/,
  },
  // Defect: a moved tag changes CI under every node that pinned it without editing a workflow.
  {
    name: "a nested action must be pinned to a full commit SHA",
    mutate: actionEdit("actions/cache/restore@0057852bfaa89a56745cba8c7296529d2fc39830 # v4", "actions/cache/restore@v4"),
    expectExit: 1,
    expectMatch: /must pin actions\/cache\/restore@v4 to a full commit SHA/,
  },
  {
    name: "a caller must pin the shared action by full SHA, not a branch",
    mutate: ({ read, write }) => {
      const path = ".github/workflows/ci.yaml";
      const before = read(path);
      const pattern = /uses: (\.\/\.github\/actions\/node-ci|cogni-dao\/node-template\/\.github\/actions\/node-ci@[0-9a-f]{40})/;
      if (!pattern.test(before)) throw new Error("fixture anchor missing: node-ci uses");
      write(path, before.replace(pattern, "uses: cogni-dao/node-template/.github/actions/node-ci@main"));
    },
    expectExit: 1,
    expectMatch: /node-ci@<40-char commit SHA>/,
  },
  // Defect: FORK_FREEDOM. A secret in the shared action would fail every fork and node PR run.
  {
    name: "the shared action must not read a secret",
    mutate: actionEdit("        node-version: ${{ inputs.node_version }}\n", "        node-version: ${{ inputs.node_version }}\n        token: ${{ secrets.GITHUB_TOKEN }}\n"),
    expectExit: 1,
    expectMatch: /must not reference secrets/,
  },
  // Defect: a job running another lane's steps under this lane's required name.
  {
    name: "a job must run the lane it is named for",
    mutate: edit(".github/workflows/ci.yaml", "lane: unit", "lane: static"),
    expectExit: 1,
    expectMatch: /unit(-shard)? node-ci lane input/,
  },
  // Defect: a key narrowed to the lockfile hits after a package source change, so every lane tests a stale build.
  {
    name: "the build cache key must cover every build input, not only the lockfile",
    mutate: actionEdit(
      "hashFiles('packages/**', 'graphs/**', '!**/node_modules/**', '!**/dist/**', '!**/*.tsbuildinfo', '!**/*.md', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', 'tsconfig.base.json')",
      "hashFiles('pnpm-lock.yaml')"
    ),
    expectExit: 1,
    expectMatch: /build_cache key/,
  },
  // Defect: a typo in `lane` matches no lane-gated step, so the required job passes having run only setup.
  {
    name: "the action must validate its inputs before running anything",
    mutate: actionEdit("    - name: Validate inputs\n", "    - name: Check things\n"),
    expectExit: 1,
    expectMatch: /first step must be "Validate inputs"/,
  },
  // Defect: a required job that cannot fail reports green whatever its steps did.
  {
    name: "a required lane job must not continue on error",
    mutate: edit(".github/workflows/ci.yaml", "\n  unit:\n", "\n  unit:\n    continue-on-error: true\n"),
    expectExit: 1,
    expectMatch: /jobs\.unit must not set continue-on-error/,
  },
  // Defect: node-template quietly drops its schema drift guard (F2) from the reference caller.
  {
    name: "node-template must keep db:check on in its own caller",
    mutate: Object.assign(
      edit(".github/workflows/ci.yaml", "          lane: static\n", "          lane: static\n          db_check: \"false\"\n"),
      { needsAction: true }
    ),
    expectExit: 1,
    expectMatch: /static must run db:check in node-template/,
  },
  // Defect: converting a required job to a reusable-workflow call renames its check to
  // `unit / <called job>`; the required `unit` then never reports and the ruleset deadlocks.
  {
    name: "calling a reusable workflow from a required job cannot provide the bare context",
    mutate: replaceJob(
      "unit",
      "  unit:\n    uses: cogni-dao/node-template/.github/workflows/ci.yml@0000000000000000000000000000000000000000\n"
    ),
    expectExit: 1,
    expectMatch: /required check "unit" must be emitted by exactly one job; found 0/,
  },
  // task.0138. Defect: the sharded gate is not `if: always()`, so a failed shard SKIPS the required `unit`,
  // and GitHub scores a skipped required check as success.
  {
    name: "the sharded unit gate must run under always()",
    mutate: shardedEdit("    if: always()\n", ""),
    expectExit: 1,
    expectMatch: /jobs\.unit gates a sharded unit lane and must run under `if: always\(\)`/,
  },
  // Defect: the gate runs but never looks at the shards, so unit reports green over a red shard.
  {
    name: "the sharded unit gate must assert the shard result",
    mutate: shardedEdit('        run: test "$SHARDS" = success\n', "        run: echo shards finished\n"),
    expectExit: 1,
    expectMatch: /jobs\.unit must fail unless every shard passed/,
  },
  {
    name: "the sharded unit gate must read the shard job it needs, not another job",
    mutate: shardedEdit("SHARDS: ${{ needs.unit-shard.result }}", "SHARDS: ${{ needs.static.result }}"),
    expectExit: 1,
    expectMatch: /jobs\.unit must fail unless every shard passed/,
  },
  // Defect: the gate accepts `skipped` or `cancelled` as passing.
  {
    name: "the sharded unit gate must accept only success",
    mutate: shardedEdit('run: test "$SHARDS" = success', 'run: test "$SHARDS" != failure'),
    expectExit: 1,
    expectMatch: /jobs\.unit must fail unless every shard passed/,
  },
  {
    name: "the sharded unit gate must not continue on error",
    mutate: shardedEdit("\n  unit:\n", "\n  unit:\n    continue-on-error: true\n"),
    expectExit: 1,
    expectMatch: /jobs\.unit must not set continue-on-error/,
  },
  // Defect: a matrix that drops or repeats a shard silently stops running a slice of the suite.
  {
    name: "the shard matrix must name every shard exactly once",
    mutate: shardedEdit('shard: ["1/4", "2/4", "3/4", "4/4"]', 'shard: ["1/4", "2/4", "3/4"]'),
    expectExit: 1,
    expectMatch: /naming every shard 1\.\.N once/,
  },
  {
    name: "the shard matrix must not repeat a shard in place of another",
    mutate: shardedEdit('shard: ["1/4", "2/4", "3/4", "4/4"]', 'shard: ["1/4", "2/4", "3/4", "3/4"]'),
    expectExit: 1,
    expectMatch: /naming every shard 1\.\.N once/,
  },
  // Defect: an `exclude` or `include` quietly removes or adds a leg the shard list does not show.
  {
    name: "the shard matrix must not carry include or exclude legs",
    mutate: shardedEdit('        shard: ["1/4", "2/4", "3/4", "4/4"]\n', '        shard: ["1/4", "2/4", "3/4", "4/4"]\n        exclude:\n          - shard: "4/4"\n'),
    expectExit: 1,
    expectMatch: /naming every shard 1\.\.N once/,
  },
  // Defect: a leg that does not receive its shard runs the whole lane (or none of it).
  {
    name: "each shard leg must pass its own shard to the action",
    mutate: shardedEdit("          unit_shard: ${{ matrix.shard }}\n", ""),
    expectExit: 1,
    expectMatch: /unit_shard input/,
  },
  // Defect: a shard job gated on another job or a condition can skip, and the gate reads that as not-success only
  // by accident; shards must always run.
  {
    name: "a shard job must run unconditionally",
    mutate: shardedEdit("\n  unit-shard:\n", "\n  unit-shard:\n    if: github.event_name == 'pull_request'\n"),
    expectExit: 1,
    expectMatch: /must run in parallel and unconditionally/,
  },
  // Defect: the gate also runs the lane, so the shards' work is repeated under the required name.
  {
    name: "the gate must not run the lane itself",
    mutate: shardedEdit(
      "      - name: Every unit shard passed\n",
      "      - uses: ./.github/actions/node-ci\n        with:\n          lane: unit\n          node_version: ${{ env.NODE_VERSION }}\n      - name: Every unit shard passed\n"
    ),
    expectExit: 1,
    expectMatch: /must not run the lane itself/,
  },
  // Defect (any tree): a plain lane given a shard runs one slice and reports the whole lane green.
  {
    name: "a plain lane must not take a shard",
    mutate: edit(".github/workflows/ci.yaml", "          lane: static\n", '          lane: static\n          unit_shard: "1/2"\n'),
    expectExit: 1,
    expectMatch: /static sets unit_shard outside a sharded unit lane/,
  },
  // Defect: the action stops forwarding the shard, so every leg runs the whole chain: green but no faster.
  {
    name: "the action must forward the shard to the unit runner",
    mutate: actionEdit("        UNIT_SHARD: ${{ inputs.unit_shard }}\n        UNIT_SPLIT_PACKAGE", "        UNIT_SPLIT_PACKAGE"),
    expectExit: 1,
    expectMatch: /Unit tests UNIT_SHARD/,
  },
  // Defect: node-template stops splitting its app suite, so the biggest package lands whole on one shard.
  {
    name: "node-template must split its app suite across the shards",
    mutate: Object.assign(
      edit(".github/workflows/ci.yaml", '          unit_split_package: "@cogni/node-template-app"\n', ""),
      { needsShardedUnit: true, needsAction: true }
    ),
    expectExit: 1,
    expectMatch: /unit_split_package input/,
  },
];

let failed = 0;
let skipped = 0;
for (const testCase of CASES) {
  if (testCase.mutate.needsAction && !HAS_ACTION) {
    skipped += 1;
    console.log(`skip ${testCase.name} (template-only: no ${ACTION} in this repo)`);
    continue;
  }
  if (testCase.mutate.needsShardedUnit && !HAS_SHARDED_UNIT) {
    skipped += 1;
    console.log(`skip ${testCase.name} (this repo keeps one plain unit job)`);
    continue;
  }
  const { code, output } = runCheckerOn(testCase.mutate);
  const exitOk = code === testCase.expectExit;
  const matchOk = !testCase.expectMatch || testCase.expectMatch.test(output);
  if (exitOk && matchOk) {
    console.log(`ok   ${testCase.name}`);
    continue;
  }
  failed += 1;
  console.error(`FAIL ${testCase.name}`);
  console.error(`     expected exit ${testCase.expectExit}, got ${code}`);
  if (!matchOk) console.error(`     expected output to match ${testCase.expectMatch}`);
  console.error(output.replace(/^/gm, "     | "));
}

if (failed > 0) {
  console.error(`\n${failed} of ${CASES.length - skipped} self-tests failed`);
  process.exit(1);
}
console.log(`\nall ${CASES.length - skipped} self-tests passed${skipped ? ` (${skipped} template-only skipped)` : ""}`);
