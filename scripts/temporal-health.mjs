#!/usr/bin/env node

import fs from "node:fs";
import YAML from "yaml";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const spec = YAML.parse(fs.readFileSync(".cogni/repo-spec.yaml", "utf8"));
const nodeName = spec.intent?.name;
const environment = valueAfter("--env") ?? "candidate-a";
const explicitUrl = valueAfter("--url");
const suffix =
  environment === "candidate-a"
    ? "-test"
    : environment === "preview"
      ? "-preview"
      : "";
const baseUrl = explicitUrl ?? `https://${nodeName}${suffix}.cognidao.org`;
const apiKey = process.env.COGNI_NODE_API_KEY;

if (!apiKey) {
  process.stderr.write("COGNI_NODE_API_KEY is required\n");
  process.exit(2);
}

let response;
try {
  response = await fetch(`${baseUrl}/api/v1/temporal/health`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
} catch (error) {
  process.stderr.write(`Temporal health request failed: ${error.message}\n`);
  process.exit(1);
}

const body = await response.json().catch(() => ({ status: "unhealthy", reason: "invalid_response" }));
process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
process.exit(response.ok && body.status === "healthy" ? 0 : 1);
