// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/work-items/tests/workflow-cli`
 * Purpose: Real HTTP/process tests of native presentation, credentials and lost acknowledgements.
 * Scope: Transport/cache boundary only; no database mock or persistence/adherence claim.
 * Invariants: NO_WRITE_RETRY, NODE_KEY_ONLY, STARTUP_FAIL_OPEN.
 * Side-effects: IO (loopback HTTP, child processes, disposable directories).
 * @internal
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const cli = fileURLToPath(
  new URL("../bin/cogni-workflow.mjs", import.meta.url)
);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-cli-"));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const state = {
    writes: 0,
    lostAck: false,
    malformedAck: false,
    wrongDiscovery: false,
    auth: [] as (string | undefined)[],
  };
  const packet = {
    workflowId: "cicd-v1",
    checkpointId: "review_ci",
    instruction: "Inspect the current-head CI now",
    expectedRevision: 4,
    lastReceipt: { key: "implementation-proof", digest: "a".repeat(64) },
  };
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* Drain the real request body. */
    }
    state.auth.push(req.headers.authorization);
    let data: unknown;
    if (req.url === "/.well-known/agent.json")
      data = {
        actions: {
          advanceWorkItemWorkflow: {
            method: "POST",
            endpoint: `${state.wrongDiscovery ? "https://elsewhere.test" : origin}/api/v1/work/items/{id}/workflow`,
          },
        },
      };
    else if (req.method === "POST") {
      state.writes++;
      if (state.lostAck) {
        req.socket.destroy();
        return;
      }
      if (state.malformedAck) {
        res.end("{");
        return;
      }
      data = {
        replayed: false,
        item: {
          id: "task.1000",
          nextCheckpoint: packet,
          claimedByRun: "native-a",
          workflowRun: {
            receipts: [{ key: "implementation-proof", digest: "a".repeat(64) }],
          },
        },
      };
    } else
      data = {
        nextCheckpoint: packet,
        session: { status: "active", claimedByRun: "native-a" },
      };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(data));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  cleanups.push(
    () =>
      new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done()))
      )
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  const origin = `http://127.0.0.1:${address.port}`;
  await writeFile(
    join(cwd, ".env.cogni"),
    `COGNI_NODE_API_KEY=child-key\nCOGNI_NODE_URL=${origin}\n`
  );
  return { cwd, origin, state, packet };
}
function invoke(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  input = ""
) {
  return new Promise<{ code: number | null; out: string; err: string }>(
    (done, reject) => {
      const child = spawn(process.execPath, [cli, ...args], {
        cwd,
        env: {
          ...process.env,
          CODEX_THREAD_ID: "native-a",
          COGNI_NODE_API_KEY: "parent-key",
          COGNI_NODE_URL: "https://parent.test",
          ...env,
        },
        stdio: "pipe",
      });
      let out = "",
        err = "";
      child.stdout.on("data", (value) => {
        out += value;
      });
      child.stderr.on("data", (value) => {
        err += value;
      });
      child.on("error", reject);
      child.on("close", (code) => done({ code, out, err }));
      child.stdin.end(input);
    }
  );
}
const body = JSON.stringify({
  expectedRevision: 3,
  runId: "native-a",
  event: { op: "start", workflowId: "cicd-v1" },
});

it("presents one server checkpoint and resumes using native hook input identity", async () => {
  const { cwd, packet, state } = await fixture();
  const next = await invoke(cwd, [
    "next",
    "task.1000",
    "--env-file",
    ".env.cogni",
  ]);
  expect(next.code).toBe(0);
  expect(JSON.parse(next.out).nextCheckpoint).toEqual(packet);
  const before = state.auth.length;
  const resumed = await invoke(
    cwd,
    ["session-start"],
    { CODEX_THREAD_ID: "" },
    JSON.stringify({ session_id: "native-a" })
  );
  expect(resumed.code).toBe(0);
  const context = JSON.parse(resumed.out).hookSpecificOutput.additionalContext;
  expect(context).toContain("Inspect the current-head CI now");
  expect(context).toContain("advisory");
  expect(context).toContain("Before dependent action");
  expect(state.auth).toHaveLength(before);
  expect(state.writes).toBe(0);
});
it("pairs an explicit credential file with its node, never the inherited parent", async () => {
  const { cwd, state } = await fixture();
  const result = await invoke(cwd, [
    "next",
    "task.1000",
    "--env-file",
    ".env.cogni",
  ]);
  expect(result.code).toBe(0);
  expect(state.auth).toEqual(["Bearer child-key", "Bearer child-key"]);
  expect(result.out + result.err).not.toContain("child-key");
  expect(result.out + result.err).not.toContain("parent-key");
});
it("does not replay a POST after the server loses its acknowledgement", async () => {
  const { cwd, state } = await fixture();
  state.lostAck = true;
  const result = await invoke(cwd, [
    "record",
    "task.1000",
    "--env-file",
    ".env.cogni",
    "--body",
    body,
  ]);
  expect(result.code).toBe(1);
  expect(result.err).toContain("Write outcome unknown");
  expect(state.writes).toBe(1);
});
it("preserves successful mutation output when the advisory cache cannot be written", async () => {
  const { cwd, state } = await fixture();
  await mkdir(join(cwd, ".cogni"));
  await writeFile(
    join(cwd, ".cogni", ".workflow-session"),
    "file instead of directory"
  );
  const result = await invoke(cwd, [
    "record",
    "task.1000",
    "--env-file",
    ".env.cogni",
    "--body",
    body,
  ]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out).item.nextCheckpoint.checkpointId).toBe(
    "review_ci"
  );
  expect(JSON.parse(result.out).item.workflowRun.receipts[0].key).toBe(
    "implementation-proof"
  );
  expect(result.err).toContain("keep the API result");
  expect(state.writes).toBe(1);
});
it("refuses discovery drift and another native session before any write", async () => {
  const { cwd, state } = await fixture();
  state.wrongDiscovery = true;
  expect(
    (
      await invoke(cwd, [
        "record",
        "task.1000",
        "--env-file",
        ".env.cogni",
        "--body",
        body,
      ])
    ).code
  ).toBe(1);
  expect(state.writes).toBe(0);
  state.wrongDiscovery = false;
  expect(
    (
      await invoke(
        cwd,
        ["record", "task.1000", "--env-file", ".env.cogni", "--body", body],
        { CODEX_THREAD_ID: "native-b" }
      )
    ).code
  ).toBe(1);
  expect(state.writes).toBe(0);
});
it("does not block startup when there is no cached checkpoint", async () => {
  const { cwd, state } = await fixture();
  const result = await invoke(cwd, ["session-start"]);
  expect(result.code).toBe(0);
  expect(result.out).toBe("");
  expect(state.auth).toHaveLength(0);
});

it("reconciles a committed write with a truncated JSON acknowledgement through read-only next", async () => {
  const { cwd, state } = await fixture();
  state.malformedAck = true;
  const result = await invoke(cwd, [
    "record",
    "task.1000",
    "--env-file",
    ".env.cogni",
    "--body",
    body,
  ]);
  expect(result.code).toBe(1);
  expect(result.err).toContain("Write outcome unknown");
  expect(result.err).toContain("read next/item receipts");
  expect(state.writes).toBe(1);
  const recovery = await invoke(cwd, [
    "next",
    "task.1000",
    "--env-file",
    ".env.cogni",
  ]);
  expect(recovery.code).toBe(0);
  expect(JSON.parse(recovery.out).nextCheckpoint.lastReceipt.key).toBe(
    "implementation-proof"
  );
  expect(state.writes).toBe(1);
});

it.each(["key-only", "url-only"])(
  "refuses a partial default file (%s) before sending inherited credentials",
  async (kind) => {
    const { cwd, origin, state } = await fixture();
    await writeFile(
      join(cwd, ".env.cogni"),
      kind === "key-only"
        ? "COGNI_NODE_API_KEY=child-key\n"
        : `COGNI_NODE_URL=${origin}\n`
    );
    const result = await invoke(cwd, ["next", "task.1000"], {
      COGNI_NODE_URL: origin,
    });
    expect(result.code).toBe(1);
    expect(state.auth).toHaveLength(0);
    expect(result.err).toContain("credential pair");
    expect(result.out + result.err).not.toContain("child-key");
    expect(result.out + result.err).not.toContain("parent-key");
  }
);
it("uses an explicit origin with a key-only local file without inheriting the parent key", async () => {
  const { cwd, origin, state } = await fixture();
  await writeFile(join(cwd, ".env.cogni"), "COGNI_NODE_API_KEY=child-key\n");
  const result = await invoke(cwd, ["next", "task.1000", "--node-url", origin]);
  expect(result.code).toBe(0);
  expect(state.auth).toEqual(["Bearer child-key", "Bearer child-key"]);
});
it("uses the complete environment pair only when no saved file exists", async () => {
  const { cwd, origin, state } = await fixture();
  await rm(join(cwd, ".env.cogni"));
  const result = await invoke(cwd, ["next", "task.1000"], {
    COGNI_NODE_URL: origin,
  });
  expect(result.code).toBe(0);
  expect(state.auth).toEqual(["Bearer parent-key", "Bearer parent-key"]);
});
it("refuses an unreadable default file instead of silently falling back to inherited identity", async () => {
  const { cwd, origin, state } = await fixture();
  await rm(join(cwd, ".env.cogni"));
  await mkdir(join(cwd, ".env.cogni"));
  const result = await invoke(cwd, ["next", "task.1000"], {
    COGNI_NODE_URL: origin,
  });
  expect(result.code).toBe(1);
  expect(state.auth).toHaveLength(0);
});
