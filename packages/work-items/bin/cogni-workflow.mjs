#!/usr/bin/env node

// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { execFileSync } from "node:child_process";
/**
 * Module: `@cogni/work-items/bin/cogni-workflow`
 * Purpose: Present node-returned checkpoint instructions to external coding agents.
 * Scope: next/record client and bounded offline native SessionStart projection.
 * Invariants: NODE_KEY_ONLY, NO_WRITE_RETRY, SERVER_OWNS_PROGRESS.
 * Side-effects: IO (explicit node HTTP and disposable per-session cache).
 * Links: https://cognidao.org/work/items/task.5300
 * @public
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [operation, itemId, ...args] = process.argv.slice(2);
let root = process.cwd();
try {
  root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1000,
  }).trim();
} catch {
  /* Explicit cwd is the standalone fallback. */
}
let sessionId = process.env.CODEX_THREAD_ID;
if (operation === "session-start" && !sessionId && !process.stdin.isTTY) {
  const input = await new Promise((done) => {
    let text = "";
    const finish = () => {
      clearTimeout(timer);
      process.stdin.pause();
      done(text);
    };
    const timer = setTimeout(finish, 250);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (text.length < 32000) text += chunk;
    });
    process.stdin.once("end", finish);
    process.stdin.once("error", finish);
    process.stdin.resume();
  });
  try {
    const id = JSON.parse(input).session_id;
    if (typeof id === "string" && id.length <= 160) sessionId = id;
  } catch {
    /* No binding is advisory, never a startup failure. */
  }
}
const cache = sessionId
  ? join(
      root,
      ".cogni",
      ".workflow-session",
      `${createHash("sha256").update(sessionId).digest("hex")}.json`,
    )
  : undefined;
const readCache = async () => {
  try {
    const text = await readFile(cache, "utf8");
    return text.length <= 32000 ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
};

async function main() {
  if (operation === "session-start") {
    const value = cache ? await readCache() : undefined;
    if (value?.nextCheckpoint)
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: `Cached workflow checkpoint (advisory, not a current claim): ${JSON.stringify(value)}\nBefore dependent action, call cogni-workflow next for this node/item. Claim/reclaim through the node API before writes. Never replay a prior action merely to recover context.`,
          },
        }),
      );
    return;
  }
  if (
    !["next", "record"].includes(operation) ||
    !/^(task|bug|story|spike|subtask)\.\d+$/.test(itemId ?? "")
  )
    throw new Error(
      "Usage: cogni-workflow next|record ITEM --node-url ORIGIN [--env-file FILE] [--body JSON]",
    );
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !["--node-url", "--env-file", "--body"].includes(args[i]) ||
      args[i + 1] === undefined
    )
      throw new Error("Unknown/incomplete option");
    options[args[i].slice(2)] = args[i + 1];
  }
  const local = {};
  try {
    for (const line of (
      await readFile(resolve(root, options["env-file"] ?? ".env.cogni"), "utf8")
    ).split(/\r?\n/)) {
      const match =
        /^(?:export\s+)?(COGNI_NODE_API_KEY|COGNI_NODE_URL)\s*=\s*(.*?)\s*$/.exec(
          line,
        );
      if (match) local[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch (error) {
    if (options["env-file"] || error.code !== "ENOENT")
      throw new Error(
        "Saved node credential pair cannot be read; no request attempted",
      );
  }
  // A saved key/origin is one compartment, including the default file.
  const fromFile =
    Boolean(options["env-file"]) ||
    Object.hasOwn(local, "COGNI_NODE_API_KEY") ||
    Object.hasOwn(local, "COGNI_NODE_URL");
  const key = fromFile
    ? local.COGNI_NODE_API_KEY
    : process.env.COGNI_NODE_API_KEY;
  const nodeUrl =
    options["node-url"] ??
    (fromFile ? local.COGNI_NODE_URL : process.env.COGNI_NODE_URL);
  if (!key || !nodeUrl)
    throw new Error(
      "Complete node credential pair required; inherited values cannot fill a saved pair",
    );
  const node = new URL(nodeUrl);
  if (
    (node.protocol !== "https:" &&
      !(
        node.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(node.hostname)
      )) ||
    node.username ||
    node.password ||
    node.pathname !== "/" ||
    node.search ||
    node.hash ||
    !key
  )
    throw new Error(
      "Explicit HTTPS node origin and its saved NODE key required",
    );
  const origin = node.origin;
  async function request(path, method = "GET", body) {
    let response;
    let value;
    try {
      response = await fetch(origin + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${key}`,
          "User-Agent": "cogni-workflow/1",
          "x-request-id": `workflow_${randomUUID()}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      value = await response.json();
    } catch {
      throw new Error(
        method === "GET"
          ? "Workflow read unavailable; pause dependent action"
          : "Write outcome unknown: read next/item receipts; do not replay the action or mutation blindly",
      );
    }
    if (!response.ok) {
      const code =
        typeof value?.error === "string" &&
        /^[a-z0-9_:-]{1,100}$/.test(value.error)
          ? value.error
          : "request_failed";
      throw new Error(
        `Workflow HTTP ${response.status}: ${code}; reconcile via read-only next before another write`,
      );
    }
    return value;
  }
  const discovery = await request("/.well-known/agent.json");
  const action = discovery.actions?.advanceWorkItemWorkflow;
  if (
    action?.method !== "POST" ||
    action.endpoint !== `${origin}/api/v1/work/items/{id}/workflow`
  )
    throw new Error(
      "Node does not advertise the checkpoint protocol; no write attempted",
    );
  const path = `/api/v1/work/items/${itemId}`;
  let value;
  if (operation === "record") {
    let body;
    try {
      body = JSON.parse(options.body ?? "null");
    } catch {
      throw new Error("Invalid record JSON; no write attempted");
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !Number.isInteger(body.expectedRevision) ||
      !body.runId ||
      (sessionId && body.runId !== sessionId)
    )
      throw new Error(
        "record requires explicit expectedRevision, event and this native session's runId",
      );
    value = await request(`${path}/workflow`, "POST", body);
    if (!value?.item?.nextCheckpoint)
      throw new Error(
        "Write acknowledged without a checkpoint packet: read next/item receipts before another write",
      );
  } else {
    value = await request(`${path}/coordination`);
  }
  const projection = { nodeUrl: origin, itemId, ...value };
  // The API response is the result. Cache failure must never turn a successful write into a retry.
  console.log(JSON.stringify(projection));
  if (cache) {
    try {
      await mkdir(resolve(cache, ".."), { recursive: true, mode: 0o700 });
      const temporary = `${cache}.${randomUUID()}.tmp`;
      const cached = {
        nodeUrl: origin,
        itemId,
        nextCheckpoint:
          operation === "record"
            ? value.item.nextCheckpoint
            : value.nextCheckpoint,
        session:
          operation === "record"
            ? { claimedByRun: value.item.claimedByRun ?? null }
            : value.session,
      };
      const encoded = JSON.stringify(cached);
      if (encoded.length > 32000)
        throw new Error("Checkpoint exceeds advisory cache bound");
      await writeFile(temporary, encoded, { mode: 0o600 });
      await rename(temporary, cache);
    } catch {
      console.error(
        "Advisory cache unavailable; keep the API result and refresh with read-only next.",
      );
    }
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
