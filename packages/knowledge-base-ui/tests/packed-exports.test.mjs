// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
// Copy _fixtures/packed-consumer/package.json into a temporary directory outside
// the repository, then run npm install --legacy-peer-deps --ignore-scripts there.
// Set COGNI_UI_PACKED_CONSUMER to that directory and run node --test on this file.
// The fixture pins genuine published peers; update its train pins on a new release.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
const ui = path.join(root, "packages/knowledge-base-ui");
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const digest = (p) =>
  createHash("sha256").update(readFileSync(p)).digest("hex");

test(
  "packed UI survives the production build order in a public consumer",
  { timeout: 120000 },
  () => {
    const configured = process.env.COGNI_UI_PACKED_CONSUMER;
    assert.ok(
      configured,
      "set COGNI_UI_PACKED_CONSUMER to an isolated real-peer npm consumer"
    );
    const consumer = realpathSync(configured);
    assert.ok(
      !consumer.startsWith(`${realpathSync(root)}${path.sep}`),
      "consumer must be outside the repository"
    );
    assert.ok(
      !realpathSync(root).startsWith(`${consumer}${path.sep}`),
      "consumer must not be a repository ancestor"
    );
    const packDir = mkdtempSync(path.join(tmpdir(), "cogni-ui-pack-"));
    const typeDir = mkdtempSync(path.join(consumer, "ui-type-"));
    try {
      rmSync(path.join(ui, "dist"), { recursive: true, force: true });
      rmSync(path.join(ui, "tsconfig.tsbuildinfo"), { force: true });
      run("pnpm", ["--filter", "@cogni-dao/knowledge-base-ui", "build"], root);
      const js = readdirSync(path.join(ui, "dist")).filter((f) =>
        f.endsWith(".js")
      );
      const before = new Map(
        js.map((f) => [f, digest(path.join(ui, "dist", f))])
      );
      run(
        "pnpm",
        ["exec", "tsc", "-b", "packages/knowledge-base-ui/tsconfig.json"],
        root
      );
      const archive = run(
        "npm",
        ["pack", "--pack-destination", packDir, "--silent"],
        ui
      )
        .trim()
        .split("\n")
        .at(-1);
      const installed = path.join(
        consumer,
        "node_modules/@cogni-dao/knowledge-base-ui"
      );
      rmSync(installed, { recursive: true, force: true });
      run(
        "npm",
        [
          "install",
          "--no-save",
          "--legacy-peer-deps",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          path.join(packDir, archive),
        ],
        consumer
      );
      const probe = `import { registerHooks } from 'node:module';\nimport { fileURLToPath } from 'node:url';\nimport { realpathSync } from 'node:fs';\nconst root = realpathSync(process.cwd()) + '/';\nregisterHooks({resolve(s,c,n){const r=n(s,c); if(r.url.startsWith('file:')&&!realpathSync(fileURLToPath(r.url)).startsWith(root)) throw Error('resolution escaped consumer: '+r.url); return r;}});\nfor(const e of ['', '/knowledge', '/goals', '/work-item', '/graph-3d', '/epochs']) await import('@cogni-dao/knowledge-base-ui'+e);\n`;
      writeFileSync(path.join(consumer, "ui-packed-probe.mjs"), probe);
      run("node", ["ui-packed-probe.mjs"], consumer);
      for (const [f, hash] of before)
        assert.equal(
          digest(path.join(ui, "dist", f)),
          hash,
          `TypeScript overwrote ${f}`
        );
      assert.ok(
        readdirSync(path.join(installed, "dist")).some((f) =>
          /^chunk-.*\.js$/.test(f)
        ),
        "shared chunks missing"
      );
      assert.ok(
        readFileSync(path.join(installed, "tailwind-source.css")).length,
        "CSS missing"
      );
      writeFileSync(
        path.join(consumer, "ui-packed-browser.mjs"),
        'import * as epochs from "@cogni-dao/knowledge-base-ui/epochs"; console.log(epochs);\n'
      );
      run(
        path.join(consumer, "node_modules/.bin/esbuild"),
        [
          "ui-packed-browser.mjs",
          "--bundle",
          "--platform=browser",
          "--format=esm",
          `--outfile=${path.join(packDir, "browser.js")}`,
        ],
        consumer
      );
      // Full third-party diagnostics are reported separately from this surface check.
      for (const f of ["consumer.ts", "tsconfig.json"])
        copyFileSync(
          path.join(ui, "tests/_fixtures/packed-consumer", f),
          path.join(typeDir, f)
        );
      run(
        path.join(consumer, "node_modules/.bin/tsc"),
        ["-p", "tsconfig.json", "--skipLibCheck", "true", "--pretty", "false"],
        typeDir
      );
    } finally {
      rmSync(typeDir, { recursive: true, force: true });
      rmSync(packDir, { recursive: true, force: true });
    }
  }
);
