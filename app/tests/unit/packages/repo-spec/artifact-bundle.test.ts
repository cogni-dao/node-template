// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import {
  buildNodeArtifactBundle,
  extractNodeArtifactBuilds,
  resolveNodeArtifactBundle,
} from "@cogni/repo-spec";
import { buildTestRepoSpec, TEST_NODE_IDS } from "@cogni/repo-spec/testing";
import { describe, expect, it } from "vitest";

const SHA = "a".repeat(40);
const APP_IMAGE = `ghcr.io/example/node@sha256:${"1".repeat(64)}`;
const WORKER_IMAGE = `ghcr.io/example/node-worker@sha256:${"2".repeat(64)}`;

function spec() {
  return buildTestRepoSpec({
    deployment: {
      services: [
        {
          name: "app",
          artifact: { name: "app" },
          port: 3200,
          visibility: "public",
        },
        {
          name: "worker",
          artifact: {
            name: "worker",
            dockerfile: "services/worker/Dockerfile",
          },
          port: 9100,
          visibility: "private",
        },
      ],
    },
  });
}

describe("node artifact bundle", () => {
  it("extracts each declared artifact once and marks the ingress artifact", () => {
    expect(extractNodeArtifactBuilds(spec())).toEqual([
      {
        artifact: "app",
        context: ".",
        dockerfile: "Dockerfile",
        public: true,
      },
      {
        artifact: "worker",
        context: ".",
        dockerfile: "services/worker/Dockerfile",
        public: false,
      },
    ]);
  });

  it("builds and resolves a complete immutable source-bound bundle", () => {
    const declaration = spec();
    const bundle = buildNodeArtifactBundle({
      spec: declaration,
      sourceSha: SHA,
      repository: "example/node",
      artifacts: [
        { artifact: "app", sourceSha: SHA, image: APP_IMAGE },
        { artifact: "worker", sourceSha: SHA, image: WORKER_IMAGE },
      ],
    });
    expect(bundle.services.map((service) => service.service)).toEqual([
      "app",
      "worker",
    ]);
    expect(
      resolveNodeArtifactBundle(declaration, bundle, {
        sourceSha: SHA,
        repository: "example/node",
      })
    ).toMatchObject({ nodeId: TEST_NODE_IDS.default, sourceSha: SHA });
  });

  it.each([
    {
      name: "missing artifact",
      artifacts: [{ artifact: "app", sourceSha: SHA, image: APP_IMAGE }],
      message: /Missing artifact/,
    },
    {
      name: "mixed source SHA",
      artifacts: [
        { artifact: "app", sourceSha: SHA, image: APP_IMAGE },
        {
          artifact: "worker",
          sourceSha: "b".repeat(40),
          image: WORKER_IMAGE,
        },
      ],
      message: /Source SHA mismatch/,
    },
    {
      name: "mutable image",
      artifacts: [
        { artifact: "app", sourceSha: SHA, image: "ghcr.io/example/node:latest" },
        { artifact: "worker", sourceSha: SHA, image: WORKER_IMAGE },
      ],
      message: /Invalid bundle/,
    },
  ])("fails atomically on $name", ({ artifacts, message }) => {
    expect(() =>
      buildNodeArtifactBundle({
        spec: spec(),
        sourceSha: SHA,
        repository: "example/node",
        artifacts,
      })
    ).toThrow(message);
  });

  it.each([
    {
      expected: { sourceSha: "b".repeat(40), repository: "example/node" },
      message: /Source SHA mismatch/,
    },
    {
      expected: { sourceSha: SHA, repository: "example/other" },
      message: /Repository mismatch/,
    },
  ])("rejects the wrong flight identity", ({ expected, message }) => {
    const declaration = spec();
    const bundle = buildNodeArtifactBundle({
      spec: declaration,
      sourceSha: SHA,
      repository: "example/node",
      artifacts: [
        { artifact: "app", sourceSha: SHA, image: APP_IMAGE },
        { artifact: "worker", sourceSha: SHA, image: WORKER_IMAGE },
      ],
    });
    expect(() =>
      resolveNodeArtifactBundle(declaration, bundle, expected)
    ).toThrow(message);
  });
});
