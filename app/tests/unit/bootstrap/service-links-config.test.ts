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
import { describe, expect, it, vi } from "vitest";
import { loadServiceLinksConfig } from "@/bootstrap/service-links-config";

const ROOT = resolve(__dirname, "../../../..");
const SHIPPED = readFileSync(resolve(ROOT, ".cogni/service-links.yaml"), "utf8");
const log = { debug: vi.fn(), warn: vi.fn() };
const load = (environment: string | undefined, read: (file: string) => string = () => SHIPPED, repoRoot: string | undefined = "/repo") =>
  loadServiceLinksConfig({ environment, repoRoot, log: log as never, read });

describe("the shipped .cogni/service-links.yaml", () => {
  it("candidate-a trusts toks5-test's node-ai and may call toks5; production has none", () => {
    expect(load("candidate-a")).toEqual({
      trustedHomes: [
        { issuer: "https://toks5-test.cognidao.org", jwksUri: "https://toks5-test.cognidao.org/.well-known/jwks.json", services: ["node-ai"] },
      ],
      targets: [{ alias: "toks5", nodeId: "f66b260b-4633-41e2-8711-b7c1b8449cc1", origin: "https://toks5-test.cognidao.org" }],
    });
    expect(load("production")).toEqual({ trustedHomes: [], targets: [] });
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

describe("parseServiceLinksFile and the strict parsers fail closed", () => {
  it("malformed YAML, a non-mapping file and a non-mapping section are none", () => {
    for (const text of ["a: [unclosed", "- just\n- a list", "42", "", "candidate-a: nope", "candidate-a:\n  - x"]) {
      expect(parseServiceLinksFile(text, "candidate-a"), text).toEqual({ trustedHomes: [], targets: [] });
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
