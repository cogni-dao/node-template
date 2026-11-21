// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { WebSearchResult, WebSearchResultItem } from "./web-search";

const bytes = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value)).length;

/** Bound a string by its serialized UTF-8 size without splitting Unicode scalars. */
function boundString(value: string, budget: number): string {
	const points = Array.from(value, (point) => {
		const code = point.charCodeAt(0);
		return point.length === 1 && code >= 0xd800 && code <= 0xdfff
			? "\ufffd"
			: point;
	});
	let low = 0;
	let high = points.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (bytes(points.slice(0, middle).join("")) <= budget) low = middle;
		else high = middle - 1;
	}
	return points.slice(0, low).join("");
}

/** Parse untrusted provider output and project a bounded, serializable result. */
export function projectWebSearchResponse(
	value: unknown,
	query: string,
	requested: boolean,
	maxResults: number,
): WebSearchResult {
	if (
		!value ||
		typeof value !== "object" ||
		!Array.isArray((value as { results?: unknown }).results)
	)
		throw new Error("web_search_invalid_response");
	const input = (value as { results: unknown[] }).results;
	const limit = Math.max(1, Math.min(5, maxResults));
	let remaining = 24 * 1024;
	const results: WebSearchResultItem[] = input.slice(0, limit).map((row) => {
		if (!row || typeof row !== "object")
			throw new Error("web_search_invalid_response");
		const r = row as Record<string, unknown>;
		if (
			typeof r.title !== "string" ||
			typeof r.url !== "string" ||
			typeof r.content !== "string"
		)
			throw new Error("web_search_invalid_response");
		const raw =
			typeof r.raw_content === "string" && r.raw_content.length
				? r.raw_content
				: undefined;
		const passage =
			requested && raw
				? boundString(raw, Math.min(8 * 1024, remaining))
				: undefined;
		if (passage !== undefined) remaining -= bytes(passage);
		return {
			title: boundString(Array.from(r.title).slice(0, 120).join(""), 512),
			url: boundString(r.url, 2048),
			content: boundString(Array.from(r.content).slice(0, 160).join(""), 1024),
			...(typeof r.score === "number" && Number.isFinite(r.score)
				? { score: r.score }
				: {}),
			rawContentState: !requested
				? "not_requested"
				: !raw
					? "unavailable"
					: passage === raw
						? "available"
						: "partial",
			...(passage ? { rawContent: passage } : {}),
		};
	});
	const output: WebSearchResult = {
		query: boundString(query, 2048),
		results,
		partial: input.length > limit,
	};
	if (bytes(output) > 48 * 1024) throw new Error("web_search_result_too_large");
	return output;
}
