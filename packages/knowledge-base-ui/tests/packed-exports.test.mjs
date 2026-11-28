// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
// Qualify the artifacts produced by packages:build; never rebuild or mutate dist.
// Train siblings are packed from this source build, not unpublished release URLs.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { test } from "node:test";

const root = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
);
const ui = path.join(root, "packages/knowledge-base-ui");
const fixtures = path.join(ui, "tests/_fixtures/packed-consumer");
const run = (command, args, cwd, timeout = 120000) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
const inside = (parent, child) => {
  const rel = path.relative(parent, child);
  return (
    rel !== "" &&
    !rel.startsWith(`..${path.sep}`) &&
    rel !== ".." &&
    !path.isAbsolute(rel)
  );
};
function assertIsolated(repository, consumer) {
  assert.ok(
    !inside(repository, consumer) &&
      !inside(consumer, repository) &&
      repository !== consumer,
    "consumer overlaps repository"
  );
  for (let dir = path.dirname(consumer); ; dir = path.dirname(dir)) {
    assert.ok(
      !existsSync(path.join(dir, "node_modules")),
      `ancestor node_modules: ${dir}`
    );
    if (dir === path.dirname(dir)) break;
  }
}
function confined(rootDir, file) {
  assert.ok(
    inside(rootDir, realpathSync(file)),
    `input escaped consumer: ${file}`
  );
}

test("reject repository equality and host dependency escape", () => {
  const parent = realpathSync(
    mkdtempSync(path.join(tmpdir(), "cogni-isolation-"))
  );
  try {
    const repository = path.join(parent, "checkout");
    const consumer = path.join(parent, "consumer");
    mkdirSync(repository);
    mkdirSync(consumer);
    const outside = path.join(repository, "outside.txt");
    const insideFile = path.join(consumer, "inside.txt");
    writeFileSync(outside, "outside");
    writeFileSync(insideFile, "inside");
    assertIsolated(realpathSync(repository), realpathSync(consumer));
    assert.throws(
      () => assertIsolated(repository, repository),
      /overlaps repository/
    );
    assert.throws(
      () => assertIsolated(parent, consumer),
      /overlaps repository/
    );
    assert.throws(
      () => assertIsolated(repository, parent),
      /overlaps repository/
    );
    confined(consumer, insideFile);
    assert.throws(() => confined(consumer, outside), /escaped consumer/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test(
  "qualify packed UI with frozen public dependencies and source train",
  { timeout: 300000 },
  () => {
    const consumer = realpathSync(
      mkdtempSync(path.join(tmpdir(), "cogni-packed-consumer-"))
    );
    try {
      assertIsolated(root, consumer);
      for (const f of [
        "package.json",
        "package-lock.json",
        "consumer.ts",
        "tsconfig.json",
      ])
        copyFileSync(path.join(fixtures, f), path.join(consumer, f));
      run(
        "npm",
        [
          "ci",
          "--legacy-peer-deps",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
        consumer,
        180000
      );
      // Install exactly the packed build outputs, without asking npm to resolve peers.
      for (const [pkg, name] of [
        ["work-items", "@cogni/work-items"],
        ["knowledge-store", "@cogni/knowledge-store"],
        ["metrics", "@cogni-dao/metrics"],
        ["knowledge-base-ui", "@cogni-dao/knowledge-base-ui"],
      ]) {
        const archive = run(
          "npm",
          [
            "pack",
            "--ignore-scripts",
            "--pack-destination",
            consumer,
            "--silent",
          ],
          path.join(root, "packages", pkg)
        )
          .trim()
          .split("\n")
          .at(-1);
        const dest = path.join(consumer, "node_modules", name);
        mkdirSync(dest, { recursive: true });
        run(
          "tar",
          [
            "-xzf",
            path.join(consumer, archive),
            "--strip-components=1",
            "-C",
            dest,
          ],
          consumer
        );
      }
      const require = createRequire(path.join(consumer, "package.json"));
      const semver = require("semver");
      const seen = new Set();
      function peerClosure(dir) {
        dir = realpathSync(dir);
        confined(consumer, dir);
        if (seen.has(dir)) return;
        seen.add(dir);
        const manifest = JSON.parse(
          readFileSync(path.join(dir, "package.json"), "utf8")
        );
        for (const [name, range] of Object.entries(
          manifest.peerDependencies || {}
        )) {
          let found;
          for (
            let p = dir;
            inside(consumer, p) || p === consumer;
            p = path.dirname(p)
          ) {
            const candidate = path.join(
              p,
              "node_modules",
              name,
              "package.json"
            );
            if (existsSync(candidate)) {
              found = candidate;
              break;
            }
          }
          if (!found && manifest.peerDependenciesMeta?.[name]?.optional)
            continue;
          assert.ok(found, `${manifest.name}: missing peer ${name}@${range}`);
          confined(consumer, found);
          const dep = JSON.parse(readFileSync(found, "utf8"));
          assert.ok(
            semver.satisfies(dep.version, range, { includePrerelease: true }),
            `${manifest.name}: incompatible peer ${name}@${dep.version}, expected ${range}`
          );
          peerClosure(path.dirname(found));
        }
      }
      peerClosure(
        path.join(consumer, "node_modules/@cogni-dao/knowledge-base-ui")
      );
      function checkInstalledPeers(modules) {
        if (!existsSync(modules)) return;
        for (const entry of readdirSync(modules, { withFileTypes: true })) {
          if (entry.name.startsWith(".")) continue;
          const candidate = path.join(modules, entry.name);
          if (entry.name.startsWith("@")) {
            checkInstalledPeers(candidate);
          } else if (existsSync(path.join(candidate, "package.json"))) {
            peerClosure(candidate);
            checkInstalledPeers(path.join(candidate, "node_modules"));
          }
        }
      }
      checkInstalledPeers(path.join(consumer, "node_modules"));
      // Packed siblings were extracted rather than installed by npm: verify their
      // regular dependencies too, so a missing declaration cannot hide in a tree.
      for (const name of [
        "@cogni/work-items",
        "@cogni/knowledge-store",
        "@cogni-dao/metrics",
      ]) {
        const manifest = JSON.parse(
          readFileSync(
            path.join(consumer, "node_modules", name, "package.json"),
            "utf8"
          )
        );
        for (const [dependency, range] of Object.entries(
          manifest.dependencies || {}
        )) {
          const file = path.join(
            consumer,
            "node_modules",
            dependency,
            "package.json"
          );
          confined(consumer, file);
          const version = JSON.parse(readFileSync(file, "utf8")).version;
          assert.ok(
            semver.satisfies(version, range),
            `${name}: incompatible dependency ${dependency}@${version}, expected ${range}`
          );
        }
      }
      const probe = `import { registerHooks } from 'node:module';\nimport { fileURLToPath } from 'node:url';\nimport { realpathSync } from 'node:fs';\nconst root = realpathSync(process.cwd()) + '/';\nregisterHooks({resolve(s,c,n){const r=n(s,c); if(r.url.startsWith('file:')&&!realpathSync(fileURLToPath(r.url)).startsWith(root)) throw Error('resolution escaped consumer: '+r.url); return r;}});\nfor(const e of ['', '/knowledge', '/goals', '/work-item', '/graph-3d', '/epochs']) await import('@cogni-dao/knowledge-base-ui'+e);\n`;
      writeFileSync(path.join(consumer, "probe.mjs"), probe);
      run("node", ["probe.mjs"], consumer);
      const pkg = path.join(
        consumer,
        "node_modules/@cogni-dao/knowledge-base-ui"
      );
      assert.deepEqual(
        readFileSync(path.join(pkg, "tailwind-source.css")),
        readFileSync(path.join(ui, "tailwind-source.css"))
      );
      assert.ok(
        readdirSync(path.join(pkg, "dist")).some((f) =>
          /^chunk-.*\.js$/.test(f)
        )
      );
      writeFileSync(
        path.join(consumer, "browser.mjs"),
        'import * as epochs from "@cogni-dao/knowledge-base-ui/epochs"; console.log(epochs);\n'
      );
      run(
        path.join(consumer, "node_modules/.bin/esbuild"),
        [
          "browser.mjs",
          "--bundle",
          "--platform=browser",
          "--format=esm",
          "--outfile=browser.js",
          "--metafile=meta.json",
        ],
        consumer
      );
      const meta = JSON.parse(
        readFileSync(path.join(consumer, "meta.json"), "utf8")
      );
      for (const input of Object.keys(meta.inputs))
        confined(consumer, path.resolve(consumer, input));
      const tsc = path.join(consumer, "node_modules/.bin/tsc");
      const files = run(
        tsc,
        ["-p", "tsconfig.json", "--listFilesOnly"],
        consumer
      );
      for (const file of files.trim().split("\n")) confined(consumer, file);
      const full = spawnSync(
        tsc,
        ["-p", "tsconfig.json", "--pretty", "false"],
        { cwd: consumer, encoding: "utf8", timeout: 120000 }
      );
      if (full.error) throw full.error;
      const diagnostics = (full.stdout + full.stderr).trim();
      console.log(
        `Full declaration diagnostics (exit ${full.status}):\n${diagnostics}`
      );
      const errors = diagnostics
        .split("\n")
        .filter((line) => line.includes("error TS"));
      assert.equal(full.status, 2, "unexpected full declaration result");
      assert.equal(errors.length, 7, "changed third-party diagnostic count");
      assert.equal(
        errors.filter(
          (e) =>
            e.includes("node_modules/@dnd-kit/core/") &&
            e.includes("TS2503") &&
            e.includes("JSX")
        ).length,
        6
      );
      assert.equal(
        errors.filter(
          (e) =>
            e.includes("node_modules/recharts/") &&
            e.includes("TS7016") &&
            e.includes("lodash")
        ).length,
        1
      );
      run(
        tsc,
        ["-p", "tsconfig.json", "--skipLibCheck", "true", "--pretty", "false"],
        consumer
      );
    } finally {
      rmSync(consumer, { recursive: true, force: true });
    }
  }
);
