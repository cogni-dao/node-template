// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/node-declarations/tests/check`
 * Purpose: Prove the node PR check (bug.5254): red PR #49's catalog and a stray `secret_refs` fail,
 *   valid and empty declarations pass, an unknown `workloads` name fails, and no refusal echoes a value.
 * Scope: Unit tests of `checkNodeDeclarations`, `findRetiredSecretRefs` and `readServiceNames`. The
 *   operator's `parseNodeSecretsCatalog` cases live in `secrets-catalog.test.ts`; the CLI in `cli.test.ts`.
 * Invariants: NO_SOURCE_ECHO. Pass 3 (reserved, inherited, off-cluster keys) is operator data and is not tested here.
 * Side-effects: IO (reads one fixture file)
 * Links: packages/node-declarations/src/check.ts, bug.5254
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkNodeDeclarations,
  findRetiredSecretRefs,
  RETIRED_SECRET_REFS_MESSAGE,
  readServiceNames,
} from "../src/index";

const RED_PR49_CATALOG = readFileSync(
  new URL("./fixtures/red-pr49-secrets-catalog.yaml", import.meta.url),
  "utf8"
);

const REPO_SPEC_APP_ONLY = `intent:
  name: demo
`;

const REPO_SPEC_TWO_SERVICES = `intent:
  name: red
deployment:
  services:
    - name: app
      visibility: public
    - name: sandbox
      visibility: private
`;

const VALID_CATALOG = `secrets:
  - name: SANDBOX_EXECD_TOKEN
    tier: A2
    source: agent
    generate: { kind: hex, bytes: 32 }
    workloads: [app, sandbox]
    required: true
    category: Sandbox
    description: Shared execd token.
    steps: []
`;

const check = (over: {
  repoSpecText?: string;
  catalogText?: string | null;
  nodeSlug?: string;
}) =>
  checkNodeDeclarations({
    repoSpecText: REPO_SPEC_TWO_SERVICES,
    catalogText: VALID_CATALOG,
    nodeSlug: "red",
    ...over,
  });

describe("red PR #49 (first head 12bfaf80)", () => {
  // The repo-spec the PR carried: SANDBOX_EXECD_TOKEN listed on both services in `secret_refs`.
  const PR49_REPO_SPEC = `intent:
  name: red
deployment:
  services:
    - name: app
      visibility: public
      secret_refs:
        - key: SANDBOX_EXECD_TOKEN
    - name: sandbox
      visibility: private
      secret_refs:
        - key: SANDBOX_EXECD_TOKEN
`;

  it("its catalog fails alone: source agent with no generate and no steps", () => {
    const result = check({ catalogText: RED_PR49_CATALOG });
    expect(result.ok).toBe(false);
    expect(result.issues).toMatchObject([
      { file: "secrets-catalog", code: "schema_invalid", path: "secrets[0].steps" },
    ]);
  });

  it("the whole PR fails: the catalog and both per-service secret_refs", () => {
    const result = check({
      repoSpecText: PR49_REPO_SPEC,
      catalogText: RED_PR49_CATALOG,
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => `${i.file}:${i.code}:${i.path}`)).toEqual([
      "repo-spec:retired_secret_refs:deployment.services[0].secret_refs",
      "repo-spec:retired_secret_refs:deployment.services[1].secret_refs",
      "secrets-catalog:schema_invalid:secrets[0].steps",
    ]);
  });
});

describe("retired secret_refs", () => {
  it("fails on a top-level secret_refs, even empty", () => {
    for (const body of ["secret_refs: []\n", "secret_refs:\n  - key: K\n"]) {
      const result = check({ repoSpecText: `${REPO_SPEC_APP_ONLY}${body}`, catalogText: null });
      expect(result.ok).toBe(false);
      expect(result.issues).toEqual([
        {
          file: "repo-spec",
          code: "retired_secret_refs",
          path: "secret_refs",
          message: RETIRED_SECRET_REFS_MESSAGE,
        },
      ]);
    }
  });

  it("fails on a per-service secret_refs, even empty, and names the service index", () => {
    const spec = `intent:
  name: red
deployment:
  services:
    - name: app
      visibility: public
    - name: sandbox
      visibility: private
      secret_refs: []
`;
    const result = check({ repoSpecText: spec, catalogText: null });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      {
        file: "repo-spec",
        code: "retired_secret_refs",
        path: "deployment.services[1].secret_refs",
        message: RETIRED_SECRET_REFS_MESSAGE,
      },
    ]);
  });

  it("reports every occurrence and uses the operator's exact refusal text", () => {
    const spec = `secret_refs: []
deployment:
  services:
    - name: app
      secret_refs: [{ key: A }]
    - name: sandbox
      secret_refs: []
`;
    expect(findRetiredSecretRefs(spec).map((i) => i.path)).toEqual([
      "secret_refs",
      "deployment.services[0].secret_refs",
      "deployment.services[1].secret_refs",
    ]);
    expect(RETIRED_SECRET_REFS_MESSAGE).toBe(
      "secret_refs is retired: declare each node secret in .cogni/secrets-catalog.yaml with `workloads` (bug.5254)"
    );
  });

  it("reports a null-valued secret_refs key too (the operator schema refuses it)", () => {
    expect(findRetiredSecretRefs("secret_refs:\n").map((i) => i.path)).toEqual([
      "secret_refs",
    ]);
  });

  it("passes a repo-spec with no secret_refs", () => {
    expect(findRetiredSecretRefs(REPO_SPEC_TWO_SERVICES)).toEqual([]);
  });

  it("fails closed on a repo-spec too large to check", () => {
    const big = `# ${"x".repeat(300 * 1024)}\nnode_id: x\n`;
    expect(findRetiredSecretRefs(big).map((i) => i.code)).toEqual([
      "retired_secret_refs",
    ]);
  });

  it("never echoes a secret_refs value", () => {
    const marker = "sk-live-MARKER123";
    const result = check({
      repoSpecText: `secret_refs:\n  - key: ${marker}\ndeployment:\n  services:\n    - name: app\n      secret_refs: [{ key: ${marker} }]\n`,
      catalogText: null,
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("MARKER123");
  });
});

describe("catalog presence", () => {
  it("passes an absent catalog (null) and an empty catalog", () => {
    expect(check({ catalogText: null })).toEqual({ ok: true, issues: [] });
    expect(check({ catalogText: "" })).toEqual({ ok: true, issues: [] });
    expect(check({ catalogText: "secrets: []\n" })).toEqual({
      ok: true,
      issues: [],
    });
  });

  it("passes a valid catalog with workloads", () => {
    expect(check({})).toEqual({ ok: true, issues: [] });
  });

  it("passes a human entry with no workloads (the poly and beacon shape)", () => {
    const catalog = `secrets:
  - name: X_API_BEARER_TOKEN
    tier: A2
    appliesTo: web
    shared: false
    source: human
    required: false
    category: "X (Twitter)"
    description: X API v2 bearer token.
    steps:
      - "Create a Project + App in the X developer portal."
`;
    expect(check({ catalogText: catalog })).toEqual({ ok: true, issues: [] });
  });

  it("fails an unknown workloads name and names the key, not a value", () => {
    const result = check({
      catalogText: VALID_CATALOG.replace("[app, sandbox]", "[app, web]"),
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      {
        file: "secrets-catalog",
        code: "unknown_workload",
        path: "secrets[0].workloads",
        message: "SANDBOX_EXECD_TOKEN: web is not a repo-spec service",
      },
    ]);
  });

  it("fails a workloads name for a service the repo-spec does not declare, with no deployment block", () => {
    // No `deployment:` means the legacy default: one service named `app`.
    expect(
      check({ repoSpecText: REPO_SPEC_APP_ONLY, catalogText: VALID_CATALOG }).issues.map(
        (i) => i.code
      )
    ).toEqual(["unknown_workload"]);
    expect(
      check({
        repoSpecText: REPO_SPEC_APP_ONLY,
        catalogText: VALID_CATALOG.replace("[app, sandbox]", "[app]"),
      }).ok
    ).toBe(true);
  });

  it("collects the repo-spec and catalog issues together", () => {
    const result = check({
      repoSpecText: "secret_refs: []\n",
      catalogText: RED_PR49_CATALOG,
    });
    expect(result.issues.map((i) => `${i.file}:${i.code}`)).toEqual([
      "repo-spec:retired_secret_refs",
      "secrets-catalog:schema_invalid",
    ]);
  });
});

describe("NO_SOURCE_ECHO", () => {
  it("a marker planted in values, keys and unknown fields never reaches an issue", () => {
    const marker = "sk-live-MARKER123";
    const result = check({
      catalogText: `secrets:\n  - name: K\n    tier: ${marker}\n    source: ${marker}\n    consumedBy: [${marker}]\n    inheritEnvironmentByLane: { ${marker}: lane }\n    required: false\n    category: c\n    description: d\n    steps: []\n`,
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("MARKER123");
    expect(result.issues[0]?.message).toBe(
      "does not match the secrets catalog schema"
    );
  });
});

describe("readServiceNames", () => {
  it("defaults to the legacy single app when there is no deployment block", () => {
    expect(readServiceNames(REPO_SPEC_APP_ONLY)).toEqual(["app"]);
  });

  it("reads deployment.services[].name in order", () => {
    expect(readServiceNames(REPO_SPEC_TWO_SERVICES)).toEqual([
      "app",
      "sandbox",
    ]);
  });

  it("fails closed on text that is not a YAML mapping", () => {
    expect(readServiceNames("- a\n- b\n")).toBeNull();
    expect(readServiceNames("a: [\n")).toBeNull();
    const result = check({ repoSpecText: "not: [valid", catalogText: null });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("repo_spec_unreadable");
  });
});
