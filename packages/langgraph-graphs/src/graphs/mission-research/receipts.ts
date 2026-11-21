// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { createHash } from "node:crypto";
import { z } from "zod";

const text = z.string().trim().min(1);
const Source = z.object({ url: z.string().url() }).strict();
const Claim = z
	.object({
		id: text,
		content: text,
		sourceUrls: z.array(z.string().url()).min(1),
	})
	.strict();
const Atom = z
	.object({
		id: text,
		action: z.enum(["create", "refine", "no-change"]),
		domain: text,
		title: text,
		useWhen: text,
		content: text,
		relationships: z.array(text),
		ownerId: z.string().nullable(),
		sourceUrls: z.array(z.string().url()).min(1),
	})
	.strict();
export const Packet = z
	.object({
		missionScope: text,
		decision: text,
		sources: z.array(Source).min(1),
		atoms: z.array(Atom).min(1),
		principles: z.array(Claim).min(1),
		contradictions: z.array(text),
		unknowns: z.array(text),
		critiqueResolutions: z.array(
			z
				.object({
					findingId: text,
					action: z.enum(["removed", "revised", "unresolved"]),
				})
				.strict(),
		),
		kpiHypotheses: z
			.array(
				z
					.object({
						id: text,
						outcome: text,
						metric: text,
						rationale: text,
						source: text,
						window: text,
						guardrails: z.array(text).min(1),
						gamingRisk: text,
						measurementGap: text,
					})
					.strict(),
			)
			.min(1),
	})
	.strict();
const Critique = z
	.object({
		fingerprint: text,
		explanation: z.string().trim().min(20),
		findings: z.array(
			z
				.object({
					id: text,
					claimIds: z.array(text).min(1),
					severity: z.enum(["critical", "major", "minor"]),
					explanation: text,
				})
				.strict(),
		),
	})
	.strict();
type Draft = z.infer<typeof Packet>;
const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const obj = (v: unknown): Record<string, unknown> | undefined =>
	v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: undefined;
export class ResearchReceipts {
	readonly sources = new Map<string, string>();
	readonly sourceStates = new Map<string, "available" | "partial">();
	readonly webSources = new Set<string>();
	readonly owners = new Map<string, { content: string; domain: string }>();
	readonly guidance = new Set<string>();
	readonly domains = new Set<string>();
	readonly reasons = new Set<string>();
	goalsObserved = false;
	tools = 0;
	searches = 0;
	tasks = 0;
	evidenceBytes = 0;
	draft?: Draft;
	fingerprint?: string;
	critique?: z.infer<typeof Critique>;
	taskId?: string;
	constructor(readonly origin: string) {}
	observe(name: string, args: unknown, value: unknown) {
		if (
			size(value) > 48 * 1024 ||
			this.evidenceBytes + size(value) > 128 * 1024
		) {
			this.reasons.add("evidence_limit");
			return;
		}
		const input = obj(args);
		const output = obj(value);
		if (!output) return;
		if (name === "core__goal_list" && Array.isArray(output.goals))
			this.goalsObserved = true;
		if (
			name === "core__knowledge_read" &&
			typeof input?.id === "string" &&
			output.mode === "get" &&
			output.node === undefined &&
			Array.isArray(output.entries)
		) {
			const entry = output.entries.map(obj).find((e) => e?.id === input.id);
			if (
				entry &&
				typeof entry.id === "string" &&
				typeof entry.content === "string" &&
				entry.content.trim() &&
				typeof entry.domain === "string"
			) {
				const url = `${this.origin.replace(/\/$/, "")}/knowledge/${encodeURIComponent(entry.id)}`;
				this.domains.add(entry.domain);
				this.owners.set(entry.id, {
					content: entry.content,
					domain: entry.domain,
				});
				this.sources.set(url, entry.content);
				this.sourceStates.set(url, "available");
				this.guidance.add(entry.id);
				this.evidenceBytes += size(entry);
			}
		}
		if (name === "core__web_search" && Array.isArray(output.results))
			for (const item of output.results) {
				const row = obj(item);
				if (
					typeof row?.url === "string" &&
					typeof row.rawContent === "string" &&
					row.rawContent &&
					["available", "partial"].includes(String(row.rawContentState))
				) {
					this.sources.set(row.url, row.rawContent);
					this.webSources.add(row.url);
					this.sourceStates.set(
						row.url,
						row.rawContentState as "available" | "partial",
					);
					this.evidenceBytes += size(row);
				}
			}
	}
	validDraft(draft: Draft) {
		const urls = new Set(draft.sources.map((s) => s.url));
		return (
			urls.size === draft.sources.length &&
			[...urls].some((url) => this.webSources.has(url)) &&
			new Set(
				[...draft.atoms, ...draft.principles, ...draft.kpiHypotheses].map(
					(claim) => claim.id,
				),
			).size ===
				draft.atoms.length +
					draft.principles.length +
					draft.kpiHypotheses.length &&
			[...urls].every((url) => this.sources.has(url)) &&
			[...draft.atoms, ...draft.principles].every((item) =>
				item.sourceUrls.every((url) => urls.has(url) && this.sources.has(url)),
			) &&
			draft.atoms.every(
				(atom) =>
					this.domains.has(atom.domain) &&
					(atom.action === "create"
						? atom.ownerId === null
						: !!atom.ownerId &&
							this.owners.get(atom.ownerId)?.domain === atom.domain &&
							atom.sourceUrls.includes(
								`${this.origin.replace(/\/$/, "")}/knowledge/${encodeURIComponent(atom.ownerId)}`,
							)),
			)
		);
	}
	prepare(raw: string, callId: string) {
		if (size(raw) > 24 * 1024) {
			this.reasons.add("draft_limit");
			return undefined;
		}
		let data: unknown;
		try {
			data = JSON.parse(raw);
		} catch {
			this.reasons.add("invalid_draft");
			return undefined;
		}
		const parsed = Packet.safeParse(data);
		if (!parsed.success || !this.validDraft(parsed.data)) {
			this.reasons.add("unverified_draft");
			return undefined;
		}
		this.draft = parsed.data;
		const evidence = [...this.sources]
			.filter(([url]) => parsed.data.sources.some((s) => s.url === url))
			.map(([url, passage]) => ({
				url,
				passage,
				state: this.sourceStates.get(url),
			}));
		const fingerprint = createHash("sha256")
			.update(JSON.stringify(parsed.data))
			.digest("hex");
		const assignment = JSON.stringify({
			draft: parsed.data,
			fingerprint,
			evidence,
		});
		if (size(assignment) > 24 * 1024) {
			this.reasons.add("critic_input_limit");
			return undefined;
		}
		this.fingerprint = fingerprint;
		this.taskId = callId;
		return assignment;
	}
	complete(raw: unknown) {
		if (size(raw) > 8 * 1024 || typeof raw !== "string") {
			this.reasons.add("critic_output_limit");
			return;
		}
		let data: unknown;
		try {
			data = JSON.parse(raw);
		} catch {
			this.reasons.add("invalid_critique");
			return;
		}
		const parsed = Critique.safeParse(data);
		if (
			!parsed.success ||
			parsed.data.fingerprint !== this.fingerprint ||
			new Set(parsed.data.findings.map((f) => f.id)).size !==
				parsed.data.findings.length
		) {
			this.reasons.add("invalid_critique");
			return;
		}
		this.critique = parsed.data;
	}
	project(answer: string, forcedReason?: string) {
		if (forcedReason) this.reasons.add(forcedReason);
		let data: unknown;
		try {
			data = JSON.parse(answer);
		} catch {
			this.reasons.add("invalid_packet");
		}
		const parsed = Packet.safeParse(data);
		const packet =
			parsed.success &&
			size(parsed.data) <= 28 * 1024 &&
			this.validDraft(parsed.data)
				? parsed.data
				: undefined;
		if (!packet) this.reasons.add("unverified_packet");
		if (
			!this.guidance.has("knowledge-syntropy-expert") ||
			!this.guidance.has("mission-loop-expert")
		)
			this.reasons.add("missing_guidance");
		if (!this.goalsObserved) this.reasons.add("missing_goal_context");
		if (!this.critique || !this.draft) this.reasons.add("missing_critique");
		if (
			packet &&
			this.critique &&
			(new Set(packet.critiqueResolutions.map((r) => r.findingId)).size !==
				packet.critiqueResolutions.length ||
				packet.critiqueResolutions.some(
					(r) => !this.critique?.findings.some((f) => f.id === r.findingId),
				))
		)
			this.reasons.add("invalid_resolution");
		if (packet && this.critique && this.draft)
			for (const finding of this.critique.findings) {
				const resolution = packet.critiqueResolutions.find(
					(r) => r.findingId === finding.id,
				);
				if (
					!resolution ||
					(resolution.action === "unresolved" &&
						finding.severity === "critical")
				) {
					this.reasons.add("unresolved_critique");
					continue;
				}
				for (const id of finding.claimIds) {
					const old = [
						...this.draft.atoms,
						...this.draft.principles,
						...this.draft.kpiHypotheses,
					].find((c) => c.id === id);
					const current = [
						...packet.atoms,
						...packet.principles,
						...packet.kpiHypotheses,
					].find((c) => c.id === id);
					const revised =
						old &&
						current &&
						("metric" in old
							? "metric" in current &&
								JSON.stringify(current) !== JSON.stringify(old)
							: "content" in current &&
								"action" in old === "action" in current &&
								current.content !== old.content);
					if (
						!old ||
						(resolution.action === "removed" && current) ||
						(resolution.action === "revised" && !revised)
					)
						this.reasons.add("invalid_resolution");
				}
			}
		const observedSources: { url: string; state: "available" | "partial" }[] =
			[];
		for (const url of this.sources.keys()) {
			const source = { url, state: this.sourceStates.get(url) ?? "partial" };
			if (size([...observedSources, source]) > 8 * 1024) break;
			observedSources.push(source);
		}
		let projectedPacket = packet ?? this.draft ?? null;
		if (
			size({
				packet: projectedPacket,
				observedSources,
				observedOwners: [...this.owners.keys()],
			}) >
			26 * 1024
		) {
			this.reasons.add("packet_limit");
			projectedPacket = this.draft ?? null;
			observedSources.length = 0;
		}
		const result = {
			observedSources,
			observedOwners: [...this.owners.keys()].slice(0, 50),
			status: this.reasons.size ? "incomplete" : "complete",
			reasons: [...this.reasons],
			packet: projectedPacket,
			unknowns: [
				"Independent semantic evaluation and source qualification remain pending.",
				"Model usage and provider cost are unknown unless supplied by the executor.",
			],
			telemetry: {
				status: this.reasons.size ? "incomplete" : "complete",
				reasonCodes: [...this.reasons],
				toolCalls: this.tools,
				searches: this.searches,
				taskAttempts: this.tasks,
				reasonCount: this.reasons.size,
			},
		};
		return { answer: JSON.stringify(result), output: result };
	}
}
