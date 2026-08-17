import { readFileSync } from "node:fs";
import { parse } from "yaml";

const CI_WORKFLOW_PATH = ".github/workflows/ci.yaml";
const PR_BUILD_WORKFLOW_PATH = ".github/workflows/pr-build.yml";
const PR_LINT_WORKFLOW_PATH = ".github/workflows/pr-lint.yaml";
const REPO_POLICY_PATH = ".cogni/repo-policy.json";

const ciWorkflow = readWorkflow(CI_WORKFLOW_PATH);
const prBuildWorkflow = readWorkflow(PR_BUILD_WORKFLOW_PATH);
const prLintWorkflow = readWorkflow(PR_LINT_WORKFLOW_PATH);
const repoPolicy = JSON.parse(readFileSync(REPO_POLICY_PATH, "utf8"));

function readWorkflow(path) {
  return parse(readFileSync(path, "utf8"));
}

function fail(path, message) {
  console.error(`${path}: ${message}`);
  process.exitCode = 1;
}

function expectEqual(path, actual, expected, label) {
  if (actual !== expected) {
    fail(path, `${label} must be ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`);
  }
}

function expectOwnKey(path, object, key, label) {
  if (!object || typeof object !== "object" || !Object.hasOwn(object, key)) {
    fail(path, `${label} must define ${key}`);
    return undefined;
  }
  return object[key];
}

function expectIncludes(path, value, fragment, label) {
  if (!String(value ?? "").includes(fragment)) {
    fail(path, `${label} must include ${JSON.stringify(fragment)}`);
  }
}

function expectStep(path, steps, name) {
  const step = steps.find((candidate) => candidate?.name === name);
  if (!step) fail(path, `steps must include ${JSON.stringify(name)}`);
  return step;
}

function expectTrigger(path, workflow, trigger) {
  const triggers = expectOwnKey(path, workflow, "on", "workflow");
  return expectOwnKey(path, triggers, trigger, "workflow triggers");
}

function expectMainPush(path, workflow) {
  const push = expectTrigger(path, workflow, "push");
  const branches = Array.isArray(push?.branches) ? push.branches : [];
  if (!branches.includes("main")) {
    fail(path, "push trigger must include main");
  }
}

function expectNoWorkflowDispatch(path, workflow) {
  const triggers = expectOwnKey(path, workflow, "on", "workflow");
  if (Object.hasOwn(triggers ?? {}, "workflow_dispatch")) {
    fail(path, "workflow must not use workflow_dispatch as launch or image evidence");
  }
}

function requiredCheckContexts(policy) {
  expectEqual(
    REPO_POLICY_PATH,
    policy?.schemaVersion,
    "cogni.node-repo-policy.v1",
    "schemaVersion"
  );
  expectEqual(
    REPO_POLICY_PATH,
    policy?.ruleset?.target,
    "default_branch",
    "ruleset.target"
  );
  expectEqual(
    REPO_POLICY_PATH,
    policy?.ruleset?.enforcement,
    "active",
    "ruleset.enforcement"
  );
  const bypassActors = policy?.ruleset?.bypassActors;
  if (!Array.isArray(bypassActors) || bypassActors.length !== 0) {
    fail(REPO_POLICY_PATH, "ruleset.bypassActors must be an empty array");
  }
  const contexts = policy?.ruleset?.requiredStatusChecks?.contexts;
  if (
    !Array.isArray(contexts) ||
    contexts.length === 0 ||
    contexts.some(
      (context) => typeof context !== "string" || context.length === 0
    ) ||
    new Set(contexts).size !== contexts.length
  ) {
    fail(
      REPO_POLICY_PATH,
      "ruleset.requiredStatusChecks.contexts must be non-empty unique strings"
    );
    return [];
  }
  return contexts;
}

function assertRequiredChecksRunOnReviewEvents(policy, workflows) {
  for (const context of requiredCheckContexts(policy)) {
    const providers = workflows.filter(({ workflow }) =>
      Object.hasOwn(workflow?.jobs ?? {}, context)
    );
    if (providers.length !== 1) {
      fail(
        REPO_POLICY_PATH,
        `required check ${JSON.stringify(context)} must be provided by exactly one workflow; found ${providers.length}`
      );
      continue;
    }
    const [{ path, workflow }] = providers;
    expectTrigger(path, workflow, "pull_request");
    expectTrigger(path, workflow, "merge_group");
    const jobIf = String(workflow.jobs[context]?.if ?? "");
    if (
      jobIf.includes("github.event_name") ||
      jobIf.includes("github.event.action")
    ) {
      fail(
        path,
        `required job ${JSON.stringify(context)} must not conditionally disappear for a review event`
      );
    }
  }
}

expectEqual(CI_WORKFLOW_PATH, ciWorkflow?.name, "CI", "workflow name");
expectTrigger(CI_WORKFLOW_PATH, ciWorkflow, "pull_request");
expectTrigger(CI_WORKFLOW_PATH, ciWorkflow, "merge_group");
expectMainPush(CI_WORKFLOW_PATH, ciWorkflow);
expectNoWorkflowDispatch(CI_WORKFLOW_PATH, ciWorkflow);
expectEqual(CI_WORKFLOW_PATH, ciWorkflow?.permissions?.contents, "read", "permissions.contents");
expectIncludes(CI_WORKFLOW_PATH, ciWorkflow?.concurrency?.group, "ci-${{ github.workflow }}-${{ github.ref }}", "concurrency.group");
expectEqual(CI_WORKFLOW_PATH, ciWorkflow?.concurrency?.["cancel-in-progress"], true, "concurrency.cancel-in-progress");

const staticJob = ciWorkflow?.jobs?.static;
if (!staticJob) fail(CI_WORKFLOW_PATH, "jobs must include static");
const staticSteps = Array.isArray(staticJob?.steps) ? staticJob.steps : [];
expectStep(CI_WORKFLOW_PATH, staticSteps, "Install dependencies");
expectStep(CI_WORKFLOW_PATH, staticSteps, "Build workspace packages");
expectStep(CI_WORKFLOW_PATH, staticSteps, "Type check");
expectStep(CI_WORKFLOW_PATH, staticSteps, "Workflow contract check");

const unitJob = ciWorkflow?.jobs?.unit;
if (!unitJob) fail(CI_WORKFLOW_PATH, "jobs must include unit");
expectEqual(CI_WORKFLOW_PATH, unitJob?.needs, "static", "jobs.unit.needs");
const unitSteps = Array.isArray(unitJob?.steps) ? unitJob.steps : [];
expectStep(CI_WORKFLOW_PATH, unitSteps, "Install dependencies");
expectStep(CI_WORKFLOW_PATH, unitSteps, "Build workspace packages");
expectStep(CI_WORKFLOW_PATH, unitSteps, "Unit + contract coverage tests");

expectEqual(PR_BUILD_WORKFLOW_PATH, prBuildWorkflow?.name, "PR Build", "workflow name");
expectTrigger(PR_BUILD_WORKFLOW_PATH, prBuildWorkflow, "pull_request");
expectTrigger(PR_BUILD_WORKFLOW_PATH, prBuildWorkflow, "merge_group");
expectMainPush(PR_BUILD_WORKFLOW_PATH, prBuildWorkflow);
// MONOREPO PARITY (bug.5057): pr-build MUST support the operator's RBAC-gated
// trusted-build `workflow_dispatch` (build an approved fork PR head → flightable
// image). This is the operator dispatch path, NOT a fork self-pushing — the
// `should_push=false` fork guard below still holds. The old `expectNoWorkflowDispatch`
// here was split-brain vs the monorepo and is removed; require the trusted-build
// inputs instead so the dispatch contract can't silently drift.
expectTrigger(PR_BUILD_WORKFLOW_PATH, prBuildWorkflow, "workflow_dispatch");
{
  const dispatchInputs =
    prBuildWorkflow?.on?.workflow_dispatch?.inputs ?? {};
  for (const required of ["head_repo", "head_sha"]) {
    if (!Object.hasOwn(dispatchInputs, required)) {
      fail(
        PR_BUILD_WORKFLOW_PATH,
        `workflow_dispatch must declare the trusted-build input "${required}"`
      );
    }
  }
}
expectEqual(PR_BUILD_WORKFLOW_PATH, prBuildWorkflow?.permissions?.contents, "read", "permissions.contents");
expectEqual(PR_BUILD_WORKFLOW_PATH, prBuildWorkflow?.permissions?.packages, "write", "permissions.packages");
// cancel-in-progress must NOT cancel a push:main (publishes the deployable) or a
// trusted dispatch (each fork build keyed by its own head_sha) — same as the monorepo.
// So it is an expression, not a literal `true`; assert it is present.
if (prBuildWorkflow?.concurrency?.["cancel-in-progress"] === undefined) {
  fail(PR_BUILD_WORKFLOW_PATH, "concurrency.cancel-in-progress must be set");
}

const resolveJob = prBuildWorkflow?.jobs?.resolve;
if (!resolveJob) fail(PR_BUILD_WORKFLOW_PATH, "jobs must include resolve");
const resolveSteps = Array.isArray(resolveJob?.steps) ? resolveJob.steps : [];
const sourceStep = expectStep(PR_BUILD_WORKFLOW_PATH, resolveSteps, "Resolve source metadata");
const sourceRun = String(sourceStep?.run ?? "");
expectIncludes(PR_BUILD_WORKFLOW_PATH, sourceRun, 'source_sha="$PR_HEAD_SHA"', "pull_request source SHA");
expectIncludes(PR_BUILD_WORKFLOW_PATH, sourceRun, 'source_sha="$PUSH_SHA"', "push source SHA");
expectIncludes(PR_BUILD_WORKFLOW_PATH, sourceRun, "image_name=ghcr.io/${owner_lc}/${repo_lc}", "repo-owned image name");
expectIncludes(PR_BUILD_WORKFLOW_PATH, sourceRun, "image_tag=sha-${source_sha}", "source SHA image tag");
expectIncludes(PR_BUILD_WORKFLOW_PATH, sourceRun, "should_push=false", "fork pull_request push guard");

const detectJob = prBuildWorkflow?.jobs?.detect;
if (!detectJob) fail(PR_BUILD_WORKFLOW_PATH, "jobs must include detect");
expectEqual(PR_BUILD_WORKFLOW_PATH, detectJob?.needs, "resolve", "jobs.detect.needs");
const detectSteps = Array.isArray(detectJob?.steps) ? detectJob.steps : [];
expectStep(PR_BUILD_WORKFLOW_PATH, detectSteps, "Detect node image targets");

const buildJob = prBuildWorkflow?.jobs?.build;
if (!buildJob) fail(PR_BUILD_WORKFLOW_PATH, "jobs must include build");
if (!Array.isArray(buildJob?.needs) || buildJob.needs.join(",") !== "resolve,detect") {
  fail(PR_BUILD_WORKFLOW_PATH, "jobs.build.needs must be [\"resolve\", \"detect\"]");
}
expectEqual(PR_BUILD_WORKFLOW_PATH, buildJob?.strategy?.["fail-fast"], false, "jobs.build.strategy.fail-fast");
const buildSteps = Array.isArray(buildJob?.steps) ? buildJob.steps : [];
expectStep(PR_BUILD_WORKFLOW_PATH, buildSteps, "Checkout");
expectStep(PR_BUILD_WORKFLOW_PATH, buildSteps, "Install");
expectStep(PR_BUILD_WORKFLOW_PATH, buildSteps, "Typecheck package closure");
expectStep(PR_BUILD_WORKFLOW_PATH, buildSteps, "Login to GHCR");
expectStep(PR_BUILD_WORKFLOW_PATH, buildSteps, "Build app image");
expectStep(PR_BUILD_WORKFLOW_PATH, buildSteps, "Write build fragment");
expectStep(PR_BUILD_WORKFLOW_PATH, buildSteps, "Upload build fragment");

const manifestJob = prBuildWorkflow?.jobs?.manifest;
if (!manifestJob) fail(PR_BUILD_WORKFLOW_PATH, "jobs must include manifest");
if (!Array.isArray(manifestJob?.needs) || manifestJob.needs.join(",") !== "resolve,detect,build") {
  fail(PR_BUILD_WORKFLOW_PATH, "jobs.manifest.needs must be [\"resolve\", \"detect\", \"build\"]");
}
const manifestSteps = Array.isArray(manifestJob?.steps) ? manifestJob.steps : [];
expectStep(PR_BUILD_WORKFLOW_PATH, manifestSteps, "Download build fragments");
expectStep(PR_BUILD_WORKFLOW_PATH, manifestSteps, "Write build manifest");
expectStep(PR_BUILD_WORKFLOW_PATH, manifestSteps, "Upload build manifest");

expectEqual(PR_LINT_WORKFLOW_PATH, prLintWorkflow?.name, "Lint PR", "workflow name");
expectTrigger(PR_LINT_WORKFLOW_PATH, prLintWorkflow, "pull_request");
expectNoWorkflowDispatch(PR_LINT_WORKFLOW_PATH, prLintWorkflow);

assertRequiredChecksRunOnReviewEvents(repoPolicy, [
  { path: CI_WORKFLOW_PATH, workflow: ciWorkflow },
  { path: PR_BUILD_WORKFLOW_PATH, workflow: prBuildWorkflow },
  { path: PR_LINT_WORKFLOW_PATH, workflow: prLintWorkflow },
]);
