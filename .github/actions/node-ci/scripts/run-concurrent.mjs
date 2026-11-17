// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@github/actions/node-ci/scripts/run-concurrent`
 * Purpose: Run independent CI commands side by side with readable output and an honest exit code (story.0052).
 * Scope: Spawns each job, buffers its output, and prints it as one block when the job ends. Owns no command list; callers name the jobs.
 * Invariants:
 *   - EVERY_JOB_RUNS: a failing job never cancels or hides a sibling; all jobs finish and every failure is printed.
 *   - EXIT_CODE_IS_THE_FIRST_FAILURE: the process exits with the exit code of the first failing job in the order given, so concurrency never turns a failure green.
 *   - READABLE_OUTPUT: a passing job prints inside a collapsed `::group::` with its duration; a failing job prints open, with an `::error::` annotation.
 *   - Bounded concurrency (default 2): the unit and component lanes are CPU-bound on a 4-vCPU runner, so more parallelism only adds memory pressure.
 * CLI: `node run-concurrent.mjs [--concurrency N] "<name>=<shell command>" ...`
 * Side-effects: IO (spawns processes, writes stdout).
 * Links: ./run-unit-tests.mjs, ../action.yml
 */

// biome-ignore-all lint/suspicious/noConsole: CI script

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {{ name: string, cmd: string, args: string[] }} Job
 * @typedef {{ name: string, status: number, seconds: number }} Result
 */

function runJob(job, onDone) {
  const started = Date.now();
  const chunks = [];
  const child = spawn(job.cmd, job.args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stderr.on("data", (chunk) => chunks.push(chunk));
  const finish = (status) => {
    const seconds = Math.round((Date.now() - started) / 1000);
    const output = Buffer.concat(chunks).toString("utf8");
    const ok = status === 0;
    console.log(`${ok ? "::group::" : ""}${job.name}: ${ok ? "passed" : `FAILED (exit ${status})`} in ${seconds}s`);
    if (output) console.log(output.endsWith("\n") ? output.slice(0, -1) : output);
    if (ok) console.log("::endgroup::");
    else console.log(`::error title=${job.name}::${job.name} failed with exit code ${status}`);
    onDone({ name: job.name, status, seconds });
  };
  child.on("error", (error) => {
    chunks.push(Buffer.from(`spawn error: ${error.message}\n`));
    finish(127);
  });
  child.on("close", (code, signal) => finish(code ?? (signal ? 128 : 1)));
}

/**
 * @param {Job[]} jobs
 * @param {{ concurrency?: number, heartbeatMs?: number }} [options]
 * @returns {Promise<Result[]>} one result per job, in the order the jobs were given
 */
export function runAll(jobs, { concurrency = 2, heartbeatMs = 30_000 } = {}) {
  return new Promise((resolveAll) => {
    const results = new Array(jobs.length);
    const running = new Set();
    let next = 0;
    let finished = 0;
    const beat =
      heartbeatMs > 0 && jobs.length > 1
        ? setInterval(() => console.log(`run-concurrent: still running: ${[...running].join(", ")}`), heartbeatMs)
        : undefined;
    const pump = () => {
      while (running.size < concurrency && next < jobs.length) {
        const index = next++;
        const job = jobs[index];
        running.add(job.name);
        console.log(`run-concurrent: start ${job.name}`);
        runJob(job, (result) => {
          results[index] = result;
          running.delete(job.name);
          finished += 1;
          if (finished === jobs.length) {
            if (beat) clearInterval(beat);
            resolveAll(results);
          } else {
            pump();
          }
        });
      }
    };
    if (jobs.length === 0) resolveAll([]);
    else pump();
  });
}

/** The exit code a caller should use: the first failing job's, in the order the jobs were given. */
export function exitCodeOf(results) {
  const failed = results.find((result) => result.status !== 0);
  return failed ? failed.status || 1 : 0;
}

async function main(argv) {
  let concurrency = 2;
  const jobs = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--concurrency") {
      concurrency = Number(argv[++i]);
      continue;
    }
    const at = argv[i].indexOf("=");
    if (at <= 0) throw new Error(`job must be "<name>=<command>"; got ${JSON.stringify(argv[i])}`);
    jobs.push({ name: argv[i].slice(0, at), cmd: "bash", args: ["-c", argv[i].slice(at + 1)] });
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer");
  const results = await runAll(jobs, { concurrency });
  console.log(results.map((r) => `${r.name} ${r.status === 0 ? "ok" : "FAILED"} ${r.seconds}s`).join(" | "));
  process.exit(exitCodeOf(results));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`run-concurrent: ${error.message}`);
    process.exit(2);
  });
}
