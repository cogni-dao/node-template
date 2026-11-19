// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/service-links-config`
 * Purpose: Public URLs are Git config (story.0038): the shipped `.cogni/service-links.yaml` gives candidate-a its trusted home and its toks5 target, production none, and any
 *   missing, unreadable or malformed input is no homes and no targets (fail closed).
 * Side-effects: filesystem read of the committed file
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseServiceLinksFile } from "@cogni/repo-spec";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadServiceLinksConfig } from "@/bootstrap/service-links-config";

const ROOT = resolve(__dirname, "../../../..");
const SHIPPED = readFileSync(resolve(ROOT, ".cogni/service-links.yaml"), "utf8");
const log = { debug: vi.fn(), warn: vi.fn() };
beforeEach(() => {
  log.debug.mockClear();
  log.warn.mockClear();
});
const load = (environment: string | undefined, read: (file: string) => string = () => SHIPPED, repoRoot: string | undefined = "/repo") =>
  loadServiceLinksConfig({ environment, repoRoot, log: log as never, read });

describe("the shipped .cogni/service-links.yaml", () => {
  it("candidate-a trusts toks5-test's node-ai and node-connect (with its node id) and may call toks5 (with its offer text); the operator's git-review is trusted on both; production has no targets", () => {
    expect(load("candidate-a")).toEqual({
      trustedHomes: [
        {
          issuer: "https://toks5-test.cognidao.org",
          jwksUri: "https://toks5-test.cognidao.org/.well-known/jwks.json",
          services: ["node-ai", "node-connect"],
          nodeId: "f66b260b-4633-41e2-8711-b7c1b8449cc1",
          name: "toks5",
        },
        // The operator's git-review (test.cognidao.org); no kid is pinned.
        { issuer: "https://test.cognidao.org", jwksUri: "https://test.cognidao.org/.well-known/jwks.json", services: ["git-review"], name: "operator" },
      ],
      targets: [
        {
          alias: "toks5",
          nodeId: "f66b260b-4633-41e2-8711-b7c1b8449cc1",
          origin: "https://toks5-test.cognidao.org",
          offer: "AI runs on toks5, charged to this node's account there, up to your limit. Reads are free.",
        },
      ],
    });
    expect(load("production")).toEqual({
      trustedHomes: [{ issuer: "https://cognidao.org", jwksUri: "https://cognidao.org/.well-known/jwks.json", services: ["git-review"], name: "operator" }],
      targets: [],
    });
    // The operator's git-review may read, never connect: node-connect is on no operator entry.
    for (const env of ["candidate-a", "production"])
      for (const home of load(env).trustedHomes.filter((h) => !h.issuer.includes("toks5"))) expect(home.services).toEqual(["git-review"]);
  });

  it("an environment with no key, a missing environment name and a missing repo root are none", () => {
    for (const env of ["preview", "local", "Candidate-A", "__proto__", "toString"]) expect(load(env), env).toEqual({ trustedHomes: [], targets: [] });
    expect(load(undefined)).toEqual({ trustedHomes: [], targets: [] });
    expect(loadServiceLinksConfig({ environment: "candidate-a", repoRoot: undefined, log: log as never, read: () => SHIPPED })).toEqual({ trustedHomes: [], targets: [] });
  });

  it("reads the file under the repo root's .cogni directory, and an unreadable file is none", () => {
    const read = vi.fn(() => SHIPPED);
    load("candidate-a", read, "/srv/app");
    expect(read).toHaveBeenCalledWith("/srv/app/.cogni/service-links.yaml");
    expect(
      load("candidate-a", () => {
        throw new Error("ENOENT");
      })
    ).toEqual({ trustedHomes: [], targets: [] });
  });
});

describe("what the loader logs", () => {
  it("an unreadable file and a malformed file are ONE warning naming the reason, never the contents", () => {
    expect(
      load("candidate-a", () => {
        throw new Error("ENOENT secret-path");
      })
    ).toEqual({ trustedHomes: [], targets: [] });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toMatchObject({ reason: "file_unreadable", environment: "candidate-a" });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("secret-path");
    log.warn.mockClear();
    for (const text of ["a: [unclosed", "- a\n- list", "candidate-a: nope", "candidate-a:\n  - x"]) {
      expect(load("candidate-a", () => text), text).toEqual({ trustedHomes: [], targets: [] });
    }
    expect(log.warn).toHaveBeenCalledTimes(4);
    expect(log.warn.mock.calls.every(([fields]) => (fields as { reason: string }).reason === "file_malformed")).toBe(true);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("unclosed");
  });

  it("a missing environment key is routine: debug only, no warning; a good file warns nothing", () => {
    expect(load("preview")).toEqual({ trustedHomes: [], targets: [] });
    expect(load("candidate-a").targets).toHaveLength(1);
    expect(load(undefined)).toEqual({ trustedHomes: [], targets: [] });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalled();
  });
});

describe("parseServiceLinksFile and the strict parsers fail closed", () => {
  it("malformed YAML, a non-mapping file and a non-mapping section are none", () => {
    for (const text of ["a: [unclosed", "- just\n- a list", "42", "", "candidate-a: nope", "candidate-a:\n  - x"]) {
      expect(parseServiceLinksFile(text, "candidate-a"), text).toMatchObject({ trustedHomes: [], targets: [] });
    }
  });

  it("a section with bad entries keeps the good ones and drops the rest", () => {
    const text = [
      "candidate-a:",
      "  trusted_homes:",
      "    - { issuer: 'https://a.example', jwks_uri: 'https://a.example/jwks', services: [node-ai] }",
      "    - { issuer: 'http://b.example', jwks_uri: 'https://b.example/jwks', services: [node-ai] }",
      "    - { issuer: 'https://c.example', jwksUri: 'https://c.example/jwks', services: [node-ai] }",
      "  targets:",
      "    - { alias: ok, node_id: n1, origin: 'https://ok.example' }",
      "    - { alias: bad, node_id: n2, origin: 'http://bad.example' }",
      "    - { alias: camel, nodeId: n3, origin: 'https://camel.example' }",
    ].join("\n");
    const config = load("candidate-a", () => text);
    expect(config.trustedHomes.map((h) => h.issuer)).toEqual(["https://a.example"]);
    expect(config.targets.map((t) => t.alias)).toEqual(["ok"]);
  });
});
