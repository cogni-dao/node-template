#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

// `pnpm release:train <T>`: write the release PR for train T (hub package-release-train). It sets all five member
// versions to T, pins member peers to ^T, rewrites member `workspace:<version>` specifiers to `workspace:*`, writes
// packages/release-train.json and edits the matching lockfile specifiers. Commit the result as its own PR; after merge, push one tag
// `train-v<T>` on the merge commit and publish-packages.yml publishes all five.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkTrain, planTrain, TRAIN_FILE } from "./release-train-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
if (!version) {
  console.error("usage: pnpm release:train <x.y.z>");
  process.exit(2);
}
const readJson = (file) => JSON.parse(readFileSync(join(ROOT, file), "utf8"));
const train = readJson(TRAIN_FILE);
const manifests = Object.fromEntries(train.members.map((dir) => [dir, readJson(`${dir}/package.json`)]));
const plan = planTrain(train, manifests, version);
for (const [dir, pkg] of Object.entries(plan.manifests)) writeFileSync(join(ROOT, dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
writeFileSync(join(ROOT, TRAIN_FILE), `${JSON.stringify(plan.train, null, 2)}\n`);
const problems = checkTrain(plan);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
// Lock: only the importer specifiers of rewritten member `workspace:` pins change (peers and `link:` versions are not in
// it). Edit those lines in place; a fresh `pnpm install --lockfile-only` would re-resolve and churn unrelated entries.
let lock = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");
for (const [dir, pkg] of Object.entries(plan.manifests))
  for (const field of ["dependencies", "devDependencies"])
    for (const [key, value] of Object.entries(pkg[field] ?? {})) {
      const before = manifests[dir][field]?.[key];
      if (before === value) continue;
      const block = new RegExp(`(\n  ${dir}:\n(?:    .*\n|\n)*?      '?${key.replace(/[/.]/g, "\\$&")}'?:\n        specifier: )${before.replace(/[.*]/g, "\\$&")}\n`);
      if (!block.test(lock)) throw new Error(`pnpm-lock.yaml has no ${dir} ${key} specifier ${before}`);
      lock = lock.replace(block, `$1${value}\n`);
    }
writeFileSync(join(ROOT, "pnpm-lock.yaml"), lock);
console.log(`train ${version}: ${train.members.length} members set. Review the lock diff, open the release PR, and after merge push tag train-v${version}.`);
