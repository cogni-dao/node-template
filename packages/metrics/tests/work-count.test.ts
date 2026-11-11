// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/** work.count@1 untriaged mode counts items waiting for triage or still unscored (task.0085). */
import { describe, expect, it } from "vitest";
import { readWorkCount } from "../src/sources.js";
import { fakeSql } from "./fakes.js";

const signal = new AbortController().signal;
const ASOF = "2026-11-11T00:00:00.000Z";

describe("work.count@1 untriaged", () => {
	it("counts needs_triage items and open unscored items in one statement", async () => {
		const { sql, queries } = fakeSql(() => [{ as_of: ASOF, value: "25" }]);
		const sample = await readWorkCount(sql, "untriaged", signal);
		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain("status = 'needs_triage'");
		expect(queries[0]).toContain("scores IS NULL");
		expect(queries[0]).toContain("test-fixture");
		expect(sample).toMatchObject({ value: 25, unit: "items", complete: true });
		expect(sample.evidenceRefs).toEqual(["node:work_items:count:untriaged:excludes-synthetic"]);
	});
});
