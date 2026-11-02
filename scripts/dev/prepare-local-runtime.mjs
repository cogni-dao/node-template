// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Create workspace-owned gateway/worker bindings from approved local Docker templates.
 * Requires the shared local substrate, its images, config and provider access already present.
 * Never stops/reconfigures existing containers. Repeated matching setup is a no-op.
 */
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { values } = parseArgs({
	options: {
		"gateway-template": { type: "string" },
		"worker-template": { type: "string" },
		"gateway-port": { type: "string" },
		"worker-port": { type: "string" },
		prefix: { type: "string" },
	},
});
for (const key of [
	"gateway-template",
	"worker-template",
	"gateway-port",
	"worker-port",
	"prefix",
]) {
	if (!values[key]) throw new Error(`--${key} is required`);
}
if (!/^[a-z][a-z0-9-]{0,45}$/.test(values.prefix))
	throw new Error("Use a short lowercase workspace prefix");
const envPath = resolve(root, ".env.local");
const original = readFileSync(envPath, "utf8");
const env = parseEnv(original);
const spec = parse(
	readFileSync(resolve(root, ".cogni/repo-spec.yaml"), "utf8"),
);
const ports = [values["gateway-port"], values["worker-port"]].map(Number);
if (
	ports.some(
		(port) => !Number.isInteger(port) || port < 1024 || port > 65535,
	) ||
	new Set([...ports, Number(env.PORT), Number(env.LANGGRAPH_PORT)]).size !== 4
) {
	throw new Error("Use distinct valid app, graph, gateway and worker ports");
}
const base = new URL(env.APP_BASE_URL);
const temporal = new URL(`http://${env.TEMPORAL_ADDRESS}`);
if (
	!new Set(["localhost", "127.0.0.1", "[::1]"]).has(base.hostname) ||
	base.protocol !== "http:" ||
	!new Set(["localhost", "127.0.0.1", "[::1]"]).has(temporal.hostname) ||
	Number(base.port) !== Number(env.PORT) ||
	!env.TEMPORAL_NAMESPACE?.startsWith("cogni-local") ||
	!env.TEMPORAL_TASK_QUEUE ||
	env.DEPLOY_ENVIRONMENT !== "local"
)
	throw new Error(
		"Configure this node's local app and Temporal bindings first",
	);
for (const key of [
	"LITELLM_MASTER_KEY",
	"BILLING_INGEST_TOKEN",
	"SCHEDULER_API_TOKEN",
]) {
	if (!env[key] || env[key].length < 32 || /replace-me|pending/.test(env[key]))
		throw new Error(`Configure ${key} first`);
}
const docker = (args, options = {}) =>
	execFileSync("docker", args, { encoding: "utf8", ...options }).trim();
function inspect(name, optional = false) {
	try {
		return JSON.parse(
			docker(["inspect", name], { stdio: ["ignore", "pipe", "pipe"] }),
		)[0];
	} catch (error) {
		if (optional) return null;
		throw error;
	}
}
const toEnv = (container) =>
	Object.fromEntries(
		container.Config.Env.map((line) => {
			const offset = line.indexOf("=");
			return [line.slice(0, offset), line.slice(offset + 1)];
		}),
	);
const plans = [
	{
		kind: "gateway",
		source: values["gateway-template"],
		port: ports[0],
		inside: 4000,
	},
	{
		kind: "worker",
		source: values["worker-template"],
		port: ports[1],
		inside: 9000,
	},
].map((plan) => {
	const template = inspect(plan.source);
	const config = toEnv(template);
	// These are local development templates, not a route into a deployed credential bank.
	for (const endpoint of (config.COGNI_NODE_ENDPOINTS ?? "")
		.split(",")
		.filter(Boolean)) {
		const url = new URL(endpoint.slice(endpoint.indexOf("=") + 1));
		if (
			!new Set(["localhost", "127.0.0.1", "host.docker.internal", "[::1]"]).has(
				url.hostname,
			)
		)
			throw new Error("Template routes to a remote node");
	}
	config.COGNI_NODE_ENDPOINTS = `${spec.node_id}=http://host.docker.internal:${env.PORT}`;
	if (plan.kind === "gateway")
		Object.assign(config, {
			COGNI_DEFAULT_NODE_ID: spec.node_id,
			LITELLM_MASTER_KEY: env.LITELLM_MASTER_KEY,
			BILLING_INGEST_TOKEN: env.BILLING_INGEST_TOKEN,
		});
	else
		Object.assign(config, {
			TEMPORAL_ADDRESS: `host.docker.internal:${temporal.port || 7233}`,
			TEMPORAL_NAMESPACE: env.TEMPORAL_NAMESPACE,
			TEMPORAL_TASK_QUEUE: env.TEMPORAL_TASK_QUEUE,
			SCHEDULER_API_TOKEN: env.SCHEDULER_API_TOKEN,
		});
	const name = `${values.prefix}-${plan.kind}-${plan.port}`;
	const existing = inspect(name, true);
	const network = Object.keys(template.NetworkSettings.Networks)[0];
	if (!network)
		throw new Error("Local template has no shared substrate network");
	if (existing) {
		const current = toEnv(existing);
		const published =
			existing.HostConfig.PortBindings[`${plan.inside}/tcp`] ?? [];
		if (
			existing.Config.Labels?.["cogni.local.workspace"] !== root ||
			existing.Config.Labels?.["cogni.local.node"] !== spec.node_id ||
			existing.Image !== template.Image ||
			!Object.entries(config).every(([key, value]) => current[key] === value) ||
			!published.some(
				(binding) =>
					binding.HostIp === "127.0.0.1" &&
					binding.HostPort === String(plan.port),
			)
		) {
			throw new Error(
				`Existing ${name} differs; inspect its ownership before changing it`,
			);
		}
	}
	return { ...plan, template, config, name, network, existing };
});
for (const plan of plans.filter((entry) => !entry.existing)) {
	await new Promise((accept, reject) => {
		const server = createServer();
		server.once("error", () =>
			reject(new Error(`Port ${plan.port} is occupied`)),
		);
		server.listen(plan.port, "127.0.0.1", () => server.close(accept));
	});
}
const secretDir = mkdtempSync(join(tmpdir(), "cogni-local-runtime-"));
chmodSync(secretDir, 0o700);
try {
	for (const plan of plans) {
		if (plan.existing) continue;
		const secretPath = join(secretDir, `${plan.kind}.env`);
		writeFileSync(
			secretPath,
			`${Object.entries(plan.config)
				.map(([key, value]) => `${key}=${value}`)
				.join("\n")}\n`,
			{ mode: 0o600 },
		);
		const args = [
			"create",
			"--label",
			`cogni.local.workspace=${root}`,
			"--label",
			`cogni.local.node=${spec.node_id}`,
			"--name",
			plan.name,
			"--network",
			plan.network,
			"--env-file",
			secretPath,
			"-p",
			`127.0.0.1:${plan.port}:${plan.inside}`,
		];
		for (const mount of plan.template.Mounts.filter(
			(entry) => entry.Type === "bind",
		))
			args.push("-v", `${mount.Source}:${mount.Destination}:ro`);
		const entrypoint = plan.template.Config.Entrypoint ?? [];
		if (entrypoint.length) args.push("--entrypoint", entrypoint[0]);
		args.push(
			plan.template.Image,
			...entrypoint.slice(1),
			...(plan.template.Config.Cmd ?? []),
		);
		docker(args);
	}
	const replacements = {
		LITELLM_BASE_URL: `http://127.0.0.1:${ports[0]}`,
		SCHEDULER_WORKER_HEALTH_URL: `http://127.0.0.1:${ports[1]}`,
	};
	const lines = original.split(/\r?\n/).map((line) => {
		const key = line.slice(0, line.indexOf("="));
		return key in replacements ? `${key}=${replacements[key]}` : line;
	});
	for (const [key, value] of Object.entries(replacements))
		if (!original.split(/\r?\n/).some((line) => line.startsWith(`${key}=`)))
			lines.push(`${key}=${value}`);
	const updated = lines.join("\n");
	if (updated !== original) {
		writeFileSync(`${envPath}.tmp`, updated, { mode: 0o600 });
		renameSync(`${envPath}.tmp`, envPath);
	}
	for (const plan of plans) {
		if (!plan.existing?.State.Running) docker(["start", plan.name]);
		const url = `http://127.0.0.1:${plan.port}${plan.kind === "gateway" ? "/v1/models" : "/readyz"}`;
		let ready = false;
		for (let attempt = 0; attempt < 50; attempt++) {
			try {
				const response = await fetch(url, {
					headers:
						plan.kind === "gateway"
							? { Authorization: `Bearer ${env.LITELLM_MASTER_KEY}` }
							: {},
					signal: AbortSignal.timeout(2000),
				});
				if (response.ok) {
					ready = true;
					break;
				}
			} catch {
				/* container is still starting */
			}
			await new Promise((accept) => setTimeout(accept, 500));
		}
		if (!ready)
			throw new Error(
				`${plan.name} did not become ready; inspect its local logs`,
			);
	}
	console.log(
		JSON.stringify(
			{
				node: spec.node_id,
				app: env.APP_BASE_URL,
				namespace: env.TEMPORAL_NAMESPACE,
				queueBase: env.TEMPORAL_TASK_QUEUE,
				containers: plans.map(({ name, port, kind, existing }) => ({
					name,
					port,
					kind,
					reused: Boolean(existing),
				})),
			},
			null,
			2,
		),
	);
} finally {
	rmSync(secretDir, { recursive: true, force: true });
}
