// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Restore authenticated node read snapshots into this node's local Doltgres.
 * Usage: node scripts/dev/restore-local-hub.mjs --knowledge FILE --cognition FILE --graph FILE
 * Local-only: verifies an admitted operation branch before merging into main.
 * Makes no network requests, copies no work items, and never pushes a remote.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs, parseEnv } from "node:util";
import { parse } from "yaml";
import {
	acquireDoltWriterLocks,
	runDoltBranchMutation,
} from "../../packages/doltgres-admission/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { values } = parseArgs({
	options: {
		knowledge: { type: "string" },
		cognition: { type: "string" },
		graph: { type: "string" },
	},
});
for (const key of ["knowledge", "cognition", "graph"]) {
	if (!values[key]) throw new Error(`--${key} snapshot is required`);
}
const read = (file) => JSON.parse(readFileSync(resolve(file), "utf8"));
const snapshot = read(values.knowledge);
const cognition = read(values.cognition);
const graph = read(values.graph);
const spec = parse(
	readFileSync(resolve(root, ".cogni/repo-spec.yaml"), "utf8"),
);
const env = parseEnv(readFileSync(resolve(root, ".env.local"), "utf8"));
const target = new URL(env.DOLTGRES_URL);
if (
	!new Set(["127.0.0.1", "localhost", "[::1]"]).has(target.hostname) ||
	!["postgres:", "postgresql:"].includes(target.protocol) ||
	target.pathname !== `/knowledge_${spec.intent.name.replaceAll("-", "_")}`
) {
	throw new Error("Restore requires this node's loopback knowledge database");
}
if (cognition.node !== spec.node_id || cognition.name !== spec.intent.name) {
	throw new Error("Snapshot belongs to a different node");
}
if (
	!Array.isArray(snapshot.items) ||
	!snapshot.items.length ||
	snapshot.items.length > 500 ||
	!Array.isArray(cognition.domainPointers) ||
	!Array.isArray(graph.nodes) ||
	!Array.isArray(graph.edges)
) {
	throw new Error(
		"Expected complete nonempty knowledge, cognition and graph snapshots",
	);
}
const ids = new Set();
for (const row of snapshot.items) {
	if (
		!["id", "domain", "title", "content", "entryType", "sourceType"].every(
			(key) => typeof row[key] === "string" && row[key].trim(),
		) ||
		ids.has(row.id)
	) {
		throw new Error("Invalid or duplicate knowledge row");
	}
	ids.add(row.id);
}
if (
	graph.nodes.length !== ids.size ||
	new Set(graph.nodes.map((row) => row.id)).size !== ids.size ||
	graph.nodes.some((row) => !ids.has(row.id)) ||
	graph.edges.some((edge) => !ids.has(edge.source) || !ids.has(edge.target))
) {
	throw new Error(
		"Graph and knowledge snapshots differ; fetch them again before restoring",
	);
}
const require = createRequire(resolve(root, "app/package.json"));
const postgres = require("postgres");
const db = postgres(env.DOLTGRES_URL, {
	max: 1,
	prepare: false,
	onnotice: () => {},
});
const literal = (value) =>
	value == null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
const hash = (text) => createHash("sha256").update(text).digest("hex");
const fieldsFor = (row) => ({
	id: row.id,
	domain: row.domain,
	entity_id: row.entityId,
	title: row.title,
	content: row.content,
	entry_type: row.entryType,
	metric_spec: row.metricSpec == null ? null : JSON.stringify(row.metricSpec),
	kpi_bindings:
		row.kpiBindings == null ? null : JSON.stringify(row.kpiBindings),
	confidence_pct: row.confidencePct,
	source_type: row.sourceType,
	source_ref: row.sourceRef,
	tags: row.tags == null ? null : JSON.stringify(row.tags),
	evaluate_at: row.evaluateAt,
	resolution_strategy: row.resolutionStrategy,
	created_at: row.createdAt,
	use_when: row.useWhen,
});
const equivalentTo = (old, row) =>
	old &&
	Object.entries(fieldsFor(row)).every(([key, value]) => {
		if (key === "tags")
			return isDeepStrictEqual(old.tags ?? null, row.tags ?? null);
		if (key === "metric_spec")
			return isDeepStrictEqual(old.metric_spec ?? null, row.metricSpec ?? null);
		if (key === "kpi_bindings")
			return isDeepStrictEqual(
				old.kpi_bindings ?? null,
				row.kpiBindings ?? null,
			);
		if (key === "created_at" || key === "evaluate_at") {
			return (
				(old[key] == null && value == null) ||
				(old[key] != null &&
					value != null &&
					new Date(old[key]).getTime() === new Date(value).getTime())
			);
		}
		return (old[key] ?? null) === (value ?? null);
	});
const branch = `local-hub-backup-${Date.now()}-${randomUUID().slice(0, 8)}`;
const evidenceDir = resolve(root, ".context/local-hub-restore", branch);
mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
const connection = await db.reserve();
const native = { unsafe: (query) => connection.unsafe(query) };
let guard;
let uncertain = false;
try {
	guard = await acquireDoltWriterLocks(native);
	const active = await native.unsafe("SELECT active_branch() AS branch");
	if (active[0]?.branch !== "main")
		throw new Error("Local hub restoration requires clean main entry");
	const dirty = await native.unsafe("SELECT * FROM dolt.status");
	if (dirty.length)
		throw new Error(
			"Local hub has uncommitted changes; preserve them before restoring",
		);
	await native.unsafe(`SELECT DOLT_BRANCH(${literal(branch)})`);
	const backup = {};
	const projections = {};
	// Materialize text explicitly: Doltgres row_to_json can expose native text pointers.
	for (const table of ["knowledge", "domains", "citations"]) {
		const columns = await native.unsafe(
			`SELECT column_name,data_type FROM information_schema.columns WHERE table_name=${literal(table)} ORDER BY ordinal_position`,
		);
		const projection = columns
			.map(({ column_name: name, data_type: type }) =>
				type === "text"
					? `substring("${name}"::text from 1 for 1048576) AS "${name}"`
					: `"${name}"`,
			)
			.join(",");
		projections[table] = projection;
		backup[table] = await native.unsafe(`SELECT ${projection} FROM ${table}`);
	}
	writeFileSync(
		resolve(evidenceDir, "before.json"),
		JSON.stringify(backup, null, 2),
		{ mode: 0o600 },
	);
	const result = await runDoltBranchMutation(native, {
		guard,
		operationId: `local-hub-restore:${branch}`,
		message: `Local snapshot restore for ${spec.intent.name}`,
		onSessionUncertain: async () => {
			uncertain = true;
		},
		run: async (db) => {
			const domains = new Map(backup.domains.map((row) => [row.id, row]));
			for (const row of cognition.domainPointers) {
				if (!domains.has(row.domain))
					await db.unsafe(
						`INSERT INTO domains (id,name,description) VALUES (${literal(row.domain)},${literal(row.domain)},${literal(row.description)})`,
					);
				else if (domains.get(row.domain).description !== row.description)
					await db.unsafe(
						`UPDATE domains SET description=${literal(row.description)} WHERE id=${literal(row.domain)}`,
					);
			}
			for (const row of snapshot.items) {
				const fields = fieldsFor(row);
				const old = backup.knowledge.find((previous) => previous.id === row.id);
				const equivalent = equivalentTo(old, row);
				if (equivalent) continue;
				if (old) {
					await db.unsafe(
						`UPDATE knowledge SET ${Object.entries(fields)
							.filter(([key]) => key !== "id")
							.map(([key, value]) => `${key}=${literal(value)}`)
							.join(",")} WHERE id=${literal(row.id)}`,
					);
				} else {
					await db.unsafe(
						`INSERT INTO knowledge (${Object.keys(fields).join(",")}) VALUES (${Object.values(fields).map(literal).join(",")})`,
					);
				}
			}
			let addedEdges = 0;
			for (const edge of graph.edges) {
				const exists = backup.citations.some(
					(old) =>
						old.citing_id === edge.source &&
						old.cited_id === edge.target &&
						old.citation_type === edge.citationType,
				);
				if (!exists) {
					await db.unsafe(
						`INSERT INTO citations (id,citing_id,cited_id,citation_type) VALUES (${literal(randomUUID())},${literal(edge.source)},${literal(edge.target)},${literal(edge.citationType)})`,
					);
					addedEdges++;
				}
			}
			const changed = (await db.unsafe("SELECT * FROM dolt.status")).length > 0;
			const after = await db.unsafe(
				`SELECT ${projections.knowledge} FROM knowledge`,
			);
			for (const row of snapshot.items) {
				if (
					!equivalentTo(
						after.find((actual) => actual.id === row.id),
						row,
					)
				)
					throw new Error(`Readback mismatch: ${row.id}`);
			}
			const restoredDomains = await db.unsafe(
				`SELECT ${projections.domains} FROM domains`,
			);
			for (const row of cognition.domainPointers) {
				if (
					restoredDomains.find((actual) => actual.id === row.domain)
						?.description !== row.description
				)
					throw new Error(`Domain readback mismatch: ${row.domain}`);
			}
			const citations = await db.unsafe(
				"SELECT citing_id,cited_id,citation_type FROM citations",
			);
			for (const edge of graph.edges) {
				if (
					!citations.some(
						(row) =>
							row.citing_id === edge.source &&
							row.cited_id === edge.target &&
							row.citation_type === edge.citationType,
					)
				)
					throw new Error(
						`Citation readback mismatch: ${edge.source} -> ${edge.target}`,
					);
			}
			for (const edge of backup.citations) {
				if (
					!citations.some(
						(row) =>
							row.citing_id === edge.citing_id &&
							row.cited_id === edge.cited_id &&
							row.citation_type === edge.citation_type,
					)
				)
					throw new Error(`Preserved local citation mismatch: ${edge.id}`);
			}
			for (const row of backup.knowledge.filter((row) => !ids.has(row.id))) {
				if (
					after.find((actual) => actual.id === row.id)?.content !== row.content
				)
					throw new Error(`Preserved local body mismatch: ${row.id}`);
			}
			return { changed, addedEdges, localRows: after.length };
		},
	});
	const receipt = {
		node: spec.node_id,
		observedAt: new Date().toISOString(),
		backupBranch: branch,
		commit: result.commitHash,
		cleanupUncertain: result.cleanupUncertain,
		imported: snapshot.items.length,
		localRows: result.value.localRows,
		sourceEdges: graph.edges.length,
		addedEdges: result.value.addedEdges,
		changed: result.value.changed,
		sourceGeneratedAt: cognition.generatedAt,
		bodies: snapshot.items.map((row) => ({
			id: row.id,
			sha256: hash(row.content),
		})),
	};
	writeFileSync(
		resolve(evidenceDir, "receipt.json"),
		JSON.stringify(receipt, null, 2),
	);
	console.log(
		JSON.stringify({ ...receipt, bodies: undefined, evidenceDir }, null, 2),
	);
} catch (error) {
	writeFileSync(
		resolve(evidenceDir, "failure.json"),
		JSON.stringify(
			{
				observedAt: new Date().toISOString(),
				message: error.message,
				operationId: error.operationId,
				operationBranch: error.branch,
				reason: error.reason,
				commitHash: error.commitHash,
				uncertain,
			},
			null,
			2,
		),
		{ mode: 0o600 },
	);
	throw error;
} finally {
	try {
		if (guard && !uncertain) await guard.release();
	} finally {
		// This one-shot owner never reuses a session after SQL/merge uncertainty.
		await db.end({ timeout: 0 });
	}
}
