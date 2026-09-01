// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../../..");
const DETECT = path.join(
  REPO_ROOT,
  "scripts/ci/detect-node-build-targets.mjs"
);
const FRAGMENT = path.join(
  REPO_ROOT,
  "scripts/ci/write-node-build-fragment.mjs"
);
const MANIFEST = path.join(
  REPO_ROOT,
  "scripts/ci/write-node-build-manifest.mjs"
);
const SHA = "a".repeat(40);

const temporaryDirectories: string[] = [];

function makeWorkspace(spec: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "node-artifact-ci-"));
  temporaryDirectories.push(directory);
  mkdirSync(path.join(directory, ".cogni"));
  writeFileSync(path.join(directory, ".cogni/repo-spec.yaml"), spec);
  return directory;
}

function run(script: string, cwd: string, env: Record<string, string>) {
  return spawnSync(process.execPath, [script], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function parseOutput(stdout: string, key: string): unknown {
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith(`${key}=`));
  if (!line) throw new Error(`Missing ${key} in ${stdout}`);
  return JSON.parse(line.slice(key.length + 1));
}

function writeFragment(input: {
  directory: string;
  artifact: string;
  imageName: string;
  digest?: string;
}) {
  const output = path.join(input.directory, `${input.artifact}.json`);
  const result = run(FRAGMENT, input.directory, {
    OUTPUT_FILE: output,
    TARGET: input.artifact === "app" ? "node" : `node-${input.artifact}`,
    ARTIFACT_NAME: input.artifact,
    IMAGE_NAME: input.imageName,
    IMAGE_TAG: `sha-${SHA}`,
    SOURCE_SHA: SHA,
    DIGEST: input.digest ?? "",
    REPOSITORY: "example/node",
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return output;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("node artifact CI lane", () => {
  it("keeps the omitted declaration on the legacy root Dockerfile target", () => {
    const cwd = makeWorkspace(`node_id: 00000000-0000-4000-8000-000000000001
governance: {}
`);
    const result = run(DETECT, cwd, {
      IMAGE_NAME: "ghcr.io/example/node",
      GITHUB_REPOSITORY: "example/node",
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(parseOutput(result.stdout, "targets_json")).toEqual([
      {
        artifact: "app",
        context: ".",
        dockerfile: "Dockerfile",
        target: "runner",
        public: true,
        image_name: "ghcr.io/example/node",
        legacy_target: "node",
      },
    ]);
  });

  it("plans each unique artifact once and keeps the ingress image identity", () => {
    const cwd = makeWorkspace(`node_id: 00000000-0000-4000-8000-000000000001
governance: {}
deployment:
  services:
    - name: app
      artifact: { name: app }
      port: 3200
      visibility: public
    - name: worker
      artifact: { name: app }
      port: 9100
      visibility: private
    - name: api
      artifact:
        name: api
        context: services/api
        dockerfile: services/api/Dockerfile
      port: 9200
      visibility: private
`);
    const result = run(DETECT, cwd, {
      IMAGE_NAME: "ghcr.io/example/node",
      GITHUB_REPOSITORY: "example/node",
    });

    expect(result.status).toBe(0);
    expect(parseOutput(result.stdout, "targets_json")).toEqual([
      expect.objectContaining({
        artifact: "app",
        image_name: "ghcr.io/example/node",
        public: true,
      }),
      expect.objectContaining({
        artifact: "api",
        image_name: "ghcr.io/example/node-api",
        public: false,
      }),
    ]);
  });

  it("emits one complete trusted bundle and no partial bundle", () => {
    const cwd = makeWorkspace(`node_id: 00000000-0000-4000-8000-000000000001
governance: {}
deployment:
  services:
    - name: app
      artifact: { name: app }
      port: 3200
      visibility: public
    - name: worker
      artifact: { name: worker }
      port: 9100
      visibility: private
`);
    const fragments = path.join(cwd, "fragments");
    mkdirSync(fragments);
    writeFragment({
      directory: fragments,
      artifact: "app",
      imageName: "ghcr.io/example/node",
      digest: `sha256:${"1".repeat(64)}`,
    });
    writeFragment({
      directory: fragments,
      artifact: "worker",
      imageName: "ghcr.io/example/node-worker",
      digest: `sha256:${"2".repeat(64)}`,
    });

    const manifest = path.join(cwd, "build-manifest.json");
    const bundle = path.join(cwd, `node-artifact-bundle-${SHA}.json`);
    const environment = {
      FRAGMENTS_DIR: fragments,
      MANIFEST_FILE: manifest,
      BUNDLE_FILE: bundle,
      IMAGE_NAME: "ghcr.io/example/node",
      IMAGE_TAG: `sha-${SHA}`,
      SOURCE_SHA: SHA,
      REPOSITORY: "example/node",
      SOURCE_REPOSITORY: "example/node",
      EMIT_BUNDLE: "true",
    };
    const complete = run(MANIFEST, cwd, environment);

    expect(complete.stderr).toBe("");
    expect(complete.status).toBe(0);
    expect(JSON.parse(readFileSync(bundle, "utf8"))).toEqual({
      schema_version: 1,
      node_id: "00000000-0000-4000-8000-000000000001",
      source_sha: SHA,
      repository: "example/node",
      services: [
        {
          service: "app",
          artifact: "app",
          source_sha: SHA,
          image: `ghcr.io/example/node@sha256:${"1".repeat(64)}`,
        },
        {
          service: "worker",
          artifact: "worker",
          source_sha: SHA,
          image: `ghcr.io/example/node-worker@sha256:${"2".repeat(64)}`,
        },
      ],
    });

    rmSync(bundle);
    rmSync(path.join(fragments, "worker.json"));
    const partial = run(MANIFEST, cwd, environment);
    expect(partial.status).not.toBe(0);
    expect(partial.stderr).toMatch(/Missing artifact for service worker/);
    expect(existsSync(bundle)).toBe(false);
  });

  it("keeps fork PR checks but emits no unpushed bundle", () => {
    const cwd = makeWorkspace(`node_id: 00000000-0000-4000-8000-000000000001
governance: {}
`);
    const fragments = path.join(cwd, "fragments");
    mkdirSync(fragments);
    writeFragment({
      directory: fragments,
      artifact: "app",
      imageName: "ghcr.io/example/node",
    });
    const manifest = path.join(cwd, "build-manifest.json");
    const bundle = path.join(cwd, `node-artifact-bundle-${SHA}.json`);
    const result = run(MANIFEST, cwd, {
      FRAGMENTS_DIR: fragments,
      MANIFEST_FILE: manifest,
      BUNDLE_FILE: bundle,
      IMAGE_NAME: "ghcr.io/example/node",
      IMAGE_TAG: `sha-${SHA}`,
      SOURCE_SHA: SHA,
      REPOSITORY: "example/node",
      SOURCE_REPOSITORY: "contributor/node",
      EMIT_BUNDLE: "false",
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(existsSync(manifest)).toBe(true);
    expect(existsSync(bundle)).toBe(false);
  });
});
