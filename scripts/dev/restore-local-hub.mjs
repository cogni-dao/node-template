// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Restore authenticated node read snapshots into this node's local Doltgres.
 * Usage: node scripts/dev/restore-local-hub.mjs --knowledge FILE --cognition FILE --graph FILE
 * Local-only: preserves other local rows and creates a backup branch before writes.
 * Makes no network requests, copies no work items, and never pushes a remote.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";
import { parse } from "yaml";

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
const branch = `local-hub-backup-${Date.now()}-${randomUUID().slice(0, 8)}`;
const evidenceDir = resolve(root, ".context/local-hub-restore", branch);
mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
try {
	const dirty = await db.unsafe("SELECT * FROM dolt_status");
	if (dirty.length)
		throw new Error(
			"Local hub has uncommitted changes; preserve them before restoring",
		);
	await db.unsafe(`SELECT DOLT_BRANCH(${literal(branch)})`);
	const backup = {};
	// Materialize text explicitly: Doltgres row_to_json can expose native text pointers.
	for (const table of ["knowledge", "domains", "citations"]) {
		const columns = await db.unsafe(
			`SELECT column_name,data_type FROM information_schema.columns WHERE table_name=${literal(table)} ORDER BY ordinal_position`,
		);
		const projection = columns
			.map(({ column_name: name, data_type: type }) =>
				type === "text"
					? `substring("${name}"::text from 1 for 1048576) AS "${name}"`
					: `"${name}"`,
			)
			.join(",");
		backup[table] = await db.unsafe(`SELECT ${projection} FROM ${table}`);
	}
	writeFileSync(
		resolve(evidenceDir, "before.json"),
		JSON.stringify(backup, null, 2),
		{ mode: 0o600 },
	);
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
		const fields = {
			id: row.id,
			domain: row.domain,
			entity_id: row.entityId,
			title: row.title,
			content: row.content,
			entry_type: row.entryType,
			confidence_pct: row.confidencePct,
			source_type: row.sourceType,
			source_ref: row.sourceRef,
			tags: row.tags == null ? null : JSON.stringify(row.tags),
			evaluate_at: row.evaluateAt,
			resolution_strategy: row.resolutionStrategy,
			created_at: row.createdAt,
			use_when: row.useWhen,
		};
		const old = backup.knowledge.find((previous) => previous.id === row.id);
		const equivalent =
			old &&
			Object.entries(fields).every(([key, value]) => {
				if (key === "tags")
					return JSON.stringify(old.tags) === JSON.stringify(row.tags);
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
	const changed = (await db.unsafe("SELECT * FROM dolt_status")).length > 0;
	const commit = changed
		? await db.unsafe(
				`SELECT DOLT_COMMIT('-Am',${literal(`Local snapshot restore for ${spec.intent.name}`)}) AS commit`,
			)
		: [];
	const after = await db.unsafe(
		"SELECT id,substring(content::text from 1 for 1048576) AS content FROM knowledge",
	);
	for (const row of snapshot.items) {
		if (after.find((actual) => actual.id === row.id)?.content !== row.content)
			throw new Error(`Readback mismatch: ${row.id}`);
	}
	const receipt = {
		node: spec.node_id,
		observedAt: new Date().toISOString(),
		backupBranch: branch,
		commit,
		imported: snapshot.items.length,
		localRows: after.length,
		sourceEdges: graph.edges.length,
		addedEdges,
		changed,
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
} finally {
	await db.end();
}
