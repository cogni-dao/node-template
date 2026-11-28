// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/scripts/check-packed-consumer`
 * Purpose: Prove the PACKED package works in a clean consumer: the tarball's bundled declarations typecheck with `skipLibCheck: false` and the entrypoints load in plain Node.
 * Scope: Packs this package and its published peers, installs the tarballs into an empty temp directory (no workspace, no repo source), typechecks tests/packed-consumer/consumer.ts and imports each entrypoint. Does not run a graph.
 * Invariants:
 *   - CLEAN_CONSUMER: the consumer sees only tarballs and registry packages; a type that leaks a private workspace package (`@cogni/ai-core`, `@cogni/graph-execution-core`) or an inferred third-party type fails here
 *   - SKIP_LIB_CHECK_FALSE: the declarations are checked, not trusted
 * Side-effects: IO (pnpm pack, npm install from the registry, tsc, node)
 * Links: https://node-template.cognidao.org/knowledge/inproc-provider-package-design
 */

// biome-ignore-all lint/suspicious/noConsole: validator script

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = resolve(PKG_DIR, "..");
/** This package and the published packages its declarations reach (peers and their peers). */
const PACKED = ["langgraph-graphs", "ai-tools", "agent-grants", "work-items", "knowledge-store", "metrics"];
/** Peer names the package imports, installed under the alias a node uses. */
const ALIASES = { "@cogni/ai-tools": "ai-tools", "@cogni/agent-grants": "agent-grants" };
const REGISTRY_DEPS = {
  "drizzle-orm": "0.44.7",
  postgres: "^3.4.5",
  zod: "^4.1.12",
  typescript: "5.9.3",
  "@types/node": "^22",
};

const work = mkdtempSync(join(tmpdir(), "packed-consumer-"));
const packs = join(work, "packs");
const consumer = join(work, "consumer");
mkdirSync(packs);
mkdirSync(join(consumer, "src"), { recursive: true });

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}

try {
  const tarballs = {};
  for (const dir of PACKED) {
    const manifest = JSON.parse(readFileSync(join(PACKAGES, dir, "package.json"), "utf8"));
    run("pnpm", ["pack", "--pack-destination", packs], join(PACKAGES, dir));
    tarballs[dir] = {
      name: manifest.name,
      file: join(packs, `${manifest.name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`),
    };
  }
  const dependencies = { ...REGISTRY_DEPS };
  for (const { name, file } of Object.values(tarballs)) dependencies[name] = `file:${file}`;
  dependencies["@cogni/langgraph-graphs"] = `file:${tarballs["langgraph-graphs"].file}`;
  for (const [alias, dir] of Object.entries(ALIASES)) dependencies[alias] = `file:${tarballs[dir].file}`;
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "clean-consumer", private: true, type: "module", dependencies }, null, 2),
  );
  cpSync(join(PKG_DIR, "tests/packed-consumer/consumer.ts"), join(consumer, "src/consumer.ts"));
  cpSync(join(PKG_DIR, "tests/packed-consumer/tsconfig.json"), join(consumer, "tsconfig.json"));

  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], consumer);

  try {
    run("npx", ["tsc", "-p", "tsconfig.json"], consumer);
  } catch (error) {
    console.error(`packed consumer typecheck failed:\n${error.stdout ?? ""}${error.stderr ?? ""}`.slice(0, 6000));
    process.exitCode = 1;
  }

  const probe = `
    const inproc = await import("@cogni/langgraph-graphs/inproc");
    const root = await import("@cogni/langgraph-graphs");
    for (const name of ["createLangGraphInProcProvider", "createNodeCatalog", "requiresInProcess", "resolveNodeSourceContext"])
      if (typeof inproc[name] !== "function") throw new Error("missing export " + name);
    if (typeof inproc.INPROC_EVENTS !== "object") throw new Error("missing INPROC_EVENTS");
    const catalog = inproc.createNodeCatalog(root.LANGGRAPH_CATALOG, { omit: ["work-closeout"] });
    if (!("cogni" in catalog) || "work-closeout" in catalog) throw new Error("createNodeCatalog omit failed");
    console.log("loaded " + Object.keys(inproc).length + " inproc exports");
  `;
  try {
    console.log(run("node", ["--input-type=module", "-e", probe], consumer).trim());
  } catch (error) {
    console.error(`packed consumer load failed:\n${error.stdout ?? ""}${error.stderr ?? ""}`.slice(0, 4000));
    process.exitCode = 1;
  }
  if (!process.exitCode) console.log("packed consumer: typecheck (skipLibCheck: false) and load passed");
} finally {
  rmSync(work, { recursive: true, force: true });
}
