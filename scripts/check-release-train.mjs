#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

// The release-train check (hub package-release-train), run in `pnpm check:workflow`. On every tree: one version for
// all members, member peers pinned to ^T, no exact member workspace pins. On a pull request (GITHUB_BASE_REF set):
// a member version changes only in a release PR, and a release PR changes only versions, member pins and the lock.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkTrain, TRAIN_FILE } from "./release-train-lib.mjs";

const ROOT = resolve(process.env.RELEASE_TRAIN_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const readJson = (file) => JSON.parse(readFileSync(join(ROOT, file), "utf8"));
if (!existsSync(join(ROOT, TRAIN_FILE))) {
  console.log("release-train: no train file; nothing to check");
  process.exit(0);
}
const train = readJson(TRAIN_FILE);
const manifests = Object.fromEntries(
  train.members.filter((dir) => existsSync(join(ROOT, dir, "package.json"))).map((dir) => [dir, readJson(`${dir}/package.json`)]),
);

let pr;
const baseRef = process.env.GITHUB_BASE_REF;
if (baseRef) {
  const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const base = `origin/${baseRef}`;
  const show = (file) => {
    try {
      return JSON.parse(git("show", `${base}:${file}`));
    } catch {
      return null;
    }
  };
  const changedFiles = git("diff", "--name-only", `${base}...HEAD`).split("\n").filter(Boolean);
  const baseTrain = show(TRAIN_FILE);
  const baseManifests = Object.fromEntries(train.members.map((dir) => [dir, show(`${dir}/package.json`)]));
  const manifestDiffs = {};
  for (const dir of train.members) {
    const before = baseManifests[dir];
    const after = manifests[dir];
    if (!before || !after) continue;
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    manifestDiffs[`${dir}/package.json`] = [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  }
  pr = { baseTrain, baseManifests, changedFiles, manifestDiffs };
}

const problems = checkTrain({ train, manifests }, pr);
if (problems.length) {
  for (const problem of problems) console.error(`release-train: ${problem}`);
  process.exit(1);
}
console.log(`release-train: ${train.members.length} members on train ${train.version}${pr ? " (PR diff checked)" : ""}`);
