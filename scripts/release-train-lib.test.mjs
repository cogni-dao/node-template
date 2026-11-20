// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

// Self-tests for release-train-lib.mjs (hub package-release-train): each rule must fail on the mutation it exists for.
import assert from "node:assert/strict";

import { checkTrain, memberFor, planTrain, TRAIN_FILE } from "./release-train-lib.mjs";

const train = { version: "0.24.0", members: ["packages/a", "packages/b"] };
const good = () => ({
  "packages/a": { name: "@cogni-dao/a", version: "0.24.0" },
  "packages/b": {
    name: "@cogni-dao/b",
    version: "0.24.0",
    peerDependencies: { "@cogni/a": "^0.24.0", react: ">=19" },
    devDependencies: { "@cogni/a": "workspace:@cogni-dao/a@*", "@cogni-dao/a": "workspace:*" },
  },
});
const codes = (problems) => problems.map((p) => p.split(":")[0]);

// memberFor resolves aliases and workspace targets.
assert.equal(memberFor("@cogni/a", "^1.0.0", [{ name: "@cogni-dao/a" }])?.name, "@cogni-dao/a");
assert.equal(memberFor("x", "workspace:@cogni-dao/a@*", [{ name: "@cogni-dao/a" }])?.name, "@cogni-dao/a");
assert.equal(memberFor("react", ">=19", [{ name: "@cogni-dao/a" }]), null);

// A tree on one train passes.
assert.deepEqual(checkTrain({ train, manifests: good() }), []);

// Split versions, loose peers and exact workspace pins each fail.
{
  const m = good();
  m["packages/a"].version = "0.23.0";
  m["packages/b"].peerDependencies["@cogni/a"] = ">=0.16.0";
  m["packages/b"].devDependencies["@cogni-dao/a"] = "workspace:0.23.0";
  assert.deepEqual(codes(checkTrain({ train, manifests: m })).sort(), [
    "train_peer_unpinned",
    "train_version_split",
    "train_workspace_pin_exact",
  ]);
}

// A version change outside a release PR fails; adding the train file (bootstrap) does not.
{
  const base = good();
  base["packages/a"].version = "0.23.0";
  const pr = { baseTrain: train, baseManifests: base, changedFiles: ["packages/a/package.json"], manifestDiffs: {} };
  assert.deepEqual(codes(checkTrain({ train, manifests: good() }, pr)), ["version_outside_release_pr"]);
  assert.deepEqual(checkTrain({ train, manifests: good() }, { ...pr, baseTrain: null }), []);
}

// A release PR may change only versions, member pins and the lock.
{
  const pr = {
    baseTrain: { ...train, version: "0.23.0" },
    baseManifests: good(),
    changedFiles: [TRAIN_FILE, "packages/a/package.json", "pnpm-lock.yaml", "packages/a/src/index.ts"],
    manifestDiffs: { "packages/a/package.json": ["version", "exports"] },
  };
  assert.deepEqual(codes(checkTrain({ train, manifests: good() }, pr)), ["release_pr_not_version_only", "release_pr_not_version_only"]);
}

// planTrain sets every version, pins member peers to ^T and frees exact workspace pins.
{
  const m = good();
  m["packages/b"].devDependencies["@cogni-dao/a"] = "workspace:0.24.0";
  const plan = planTrain(train, m, "0.25.0");
  assert.equal(plan.train.version, "0.25.0");
  assert.equal(plan.manifests["packages/a"].version, "0.25.0");
  assert.equal(plan.manifests["packages/b"].peerDependencies["@cogni/a"], "^0.25.0");
  assert.equal(plan.manifests["packages/b"].peerDependencies.react, ">=19");
  assert.equal(plan.manifests["packages/b"].devDependencies["@cogni-dao/a"], "workspace:*");
  assert.deepEqual(checkTrain(plan), []);
  assert.throws(() => planTrain(train, m, "0.24.0"), /must be above/);
}

console.log("release-train-lib: all cases pass");
