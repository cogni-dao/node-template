// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

// The package release train (story.0085, hub package-release-train): five coupled packages share one version `T`,
// held in packages/release-train.json. This module is pure: `planTrain` computes the release PR's manifest edits and
// `checkTrain` returns the violations of a tree (and, on a PR, of its diff). The CLI (release-train.mjs) and the CI
// check (check-release-train.mjs) only read and write files around it.

export const TRAIN_FILE = "packages/release-train.json";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function compareVersions(a, b) {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) return Number.NaN;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

/** The member a dependency key or `workspace:` target names: `@cogni/work-items` and `@cogni-dao/work-items` both name work-items. */
export function memberFor(key, value, members) {
  const spec = typeof value === "string" && value.startsWith("workspace:") ? value.slice("workspace:".length) : "";
  const at = spec.lastIndexOf("@");
  const named = spec.startsWith("@") ? (at > 0 ? spec.slice(0, at) : spec) : key;
  const base = (name) => name.replace(/^@[^/]+\//, "");
  return members.find((m) => base(m.name) === base(named)) ?? null;
}

/**
 * The release PR's edits: every member's version, its member peers as `^T`, and its member `workspace:<version>`
 * specifiers as `workspace:*`. `manifests` maps a member dir to its parsed package.json; returns the new manifests.
 */
export function planTrain(train, manifests, version) {
  if (!SEMVER.test(version)) throw new Error(`train version ${version} is not x.y.z`);
  if (!(compareVersions(version, train.version) > 0)) throw new Error(`train version ${version} must be above ${train.version}`);
  const members = train.members.map((dir) => ({ dir, name: manifests[dir].name }));
  const next = {};
  for (const { dir } of members) {
    const pkg = structuredClone(manifests[dir]);
    pkg.version = version;
    for (const [key, value] of Object.entries(pkg.peerDependencies ?? {}))
      if (memberFor(key, value, members)) pkg.peerDependencies[key] = `^${version}`;
    for (const field of ["dependencies", "devDependencies"])
      for (const [key, value] of Object.entries(pkg[field] ?? {}))
        if (typeof value === "string" && /^workspace:\d/.test(value) && memberFor(key, value, members)) pkg[field][key] = "workspace:*";
    next[dir] = pkg;
  }
  return { train: { ...train, version }, manifests: next };
}

/**
 * Violations of the train rules. `tree` is `{ train, manifests }` at HEAD. `pr`, when checking a pull request, is
 * `{ baseTrain, baseManifests, changedFiles, manifestDiffs }`: the base's train file (null when the base has none),
 * the base member manifests, every changed path, and for each changed member manifest the top-level fields that differ.
 */
export function checkTrain(tree, pr) {
  const problems = [];
  const { train, manifests } = tree;
  if (!train) return problems;
  const members = train.members.map((dir) => ({ dir, name: manifests[dir]?.name }));
  for (const { dir, name } of members) {
    const pkg = manifests[dir];
    if (!pkg) {
      problems.push(`train_member_missing: ${dir}`);
      continue;
    }
    if (pkg.version !== train.version) problems.push(`train_version_split: ${name} is ${pkg.version}, the train is ${train.version}`);
    for (const [key, value] of Object.entries(pkg.peerDependencies ?? {}))
      if (memberFor(key, value, members) && value !== `^${train.version}`)
        problems.push(`train_peer_unpinned: ${name} peers ${key}@${value}, want ^${train.version}`);
    for (const field of ["dependencies", "devDependencies"])
      for (const [key, value] of Object.entries(pkg[field] ?? {}))
        if (typeof value === "string" && /^workspace:\d/.test(value) && memberFor(key, value, members))
          problems.push(`train_workspace_pin_exact: ${name} ${field}.${key}=${value}, want workspace:*`);
  }
  if (!pr || !pr.baseTrain) return problems; // adding the train file is the bootstrap release PR
  const releasePr = pr.changedFiles.includes(TRAIN_FILE);
  if (releasePr) {
    if (!(compareVersions(train.version, pr.baseTrain.version) > 0))
      problems.push(`release_pr_version_not_raised: ${TRAIN_FILE} is ${train.version}, base is ${pr.baseTrain.version}`);
    if (JSON.stringify([...train.members].sort()) !== JSON.stringify([...pr.baseTrain.members].sort()))
      problems.push("release_pr_not_version_only: a release PR cannot change the train members");
    const memberManifests = new Set(train.members.map((dir) => `${dir}/package.json`));
    for (const file of pr.changedFiles) {
      if (file === TRAIN_FILE || file === "pnpm-lock.yaml") continue;
      if (!memberManifests.has(file)) {
        problems.push(`release_pr_not_version_only: ${file} changed in a release PR`);
        continue;
      }
      const fields = pr.manifestDiffs[file] ?? [];
      for (const field of fields)
        if (!["version", "peerDependencies", "devDependencies", "dependencies"].includes(field))
          problems.push(`release_pr_not_version_only: ${file} changes ${field}`);
      // Dependency fields may change only on member keys: peers to ^T, workspace pins to workspace:*.
      const dir = file.slice(0, -"/package.json".length);
      const before = pr.baseManifests[dir] ?? {};
      const after = manifests[dir] ?? {};
      for (const field of ["peerDependencies", "devDependencies", "dependencies"]) {
        const keys = new Set([...Object.keys(before[field] ?? {}), ...Object.keys(after[field] ?? {})]);
        for (const key of keys) {
          const was = before[field]?.[key];
          const now = after[field]?.[key];
          if (was === now) continue;
          const allowed =
            memberFor(key, now, members) &&
            was !== undefined &&
            (field === "peerDependencies" ? now === `^${train.version}` : now === "workspace:*");
          if (!allowed) problems.push(`release_pr_not_version_only: ${file} ${field}.${key} ${was ?? "(none)"} -> ${now ?? "(none)"}`);
        }
      }
    }
  } else {
    for (const { dir, name } of members)
      if (pr.baseManifests[dir] && pr.baseManifests[dir].version !== manifests[dir]?.version)
        problems.push(`version_outside_release_pr: ${name} version changed without ${TRAIN_FILE}`);
  }
  return problems;
}
