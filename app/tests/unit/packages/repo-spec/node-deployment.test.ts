// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { extractNodeServices, parseRepoSpec } from "@cogni/repo-spec";
import { buildTestRepoSpec } from "@cogni/repo-spec/testing";
import { describe, expect, it } from "vitest";

const APP = {
  name: "app",
  artifact: { name: "app" },
  port: 3200,
  visibility: "public",
} as const;

describe("node deployment repo-spec", () => {
  it("preserves the existing one-image node-template when omitted", () => {
    expect(extractNodeServices(buildTestRepoSpec())).toEqual([
      {
        name: "app",
        artifact: {
          name: "app",
          context: ".",
          dockerfile: "Dockerfile",
          target: "runner",
        },
        port: 3200,
        visibility: "public",
        bindings: {},
        bindHost: "0.0.0.0",
        internalUrl: "http://app:3200",
        resources: { cpuUnits: 0.5, memoryMi: 1024, storageMi: 2048 },
      },
    ]);
  });

  it("declares a public app, private sibling, and Git-owned binding", () => {
    const services = extractNodeServices(
      buildTestRepoSpec({
        deployment: {
          services: [
            { ...APP, bindings: { WORKER_URL: "worker" } },
            {
              name: "worker",
              artifact: {
                name: "worker",
                context: "services/worker",
                dockerfile: "services/worker/Dockerfile",
              },
              port: 9100,
              visibility: "private",
            },
          ],
        },
      })
    );

    expect(services[0]?.bindings).toEqual({ WORKER_URL: "worker" });
    expect(services[1]).toMatchObject({
      name: "worker",
      bindHost: "0.0.0.0",
      internalUrl: "http://worker:9100",
      visibility: "private",
    });
  });

  it("allows two services to reuse identical build instructions", () => {
    const services = extractNodeServices(
      buildTestRepoSpec({
        deployment: {
          services: [
            APP,
            {
              name: "worker",
              artifact: { name: "app" },
              port: 9100,
              visibility: "private",
            },
          ],
        },
      })
    );
    expect(services.map((service) => service.artifact.name)).toEqual([
      "app",
      "app",
    ]);
  });

  it.each([
    {
      name: "missing binding target",
      services: [{ ...APP, bindings: { WORKER_URL: "worker" } }],
      message: /binding target is not declared/,
    },
    {
      name: "loopback bind",
      services: [{ ...APP, bind_host: "127.0.0.1" }],
      message: /Invalid repo-spec structure/,
    },
    {
      name: "two public services",
      services: [APP, { ...APP, name: "other" }],
      message: /exactly one public service/,
    },
  ])("rejects $name", ({ services, message }) => {
    expect(() =>
      parseRepoSpec({
        node_id: "00000000-0000-4000-8000-000000000001",
        governance: {},
        deployment: { services },
      })
    ).toThrow(message);
  });

  it("rejects persistent-state fields structurally, not service names", () => {
    expect(() =>
      parseRepoSpec({
        node_id: "00000000-0000-4000-8000-000000000001",
        governance: {},
        deployment: {
          services: [{ ...APP, persistent_volume: { size_mi: 1024 } }],
        },
      })
    ).toThrow(/Invalid repo-spec structure/);

    expect(() =>
      parseRepoSpec({
        node_id: "00000000-0000-4000-8000-000000000001",
        governance: {},
        deployment: {
          services: [APP, { ...APP, name: "redis", visibility: "private" }],
        },
      })
    ).not.toThrow();
  });
});
