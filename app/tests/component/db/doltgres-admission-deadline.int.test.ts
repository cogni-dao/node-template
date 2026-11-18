// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Native engine regression: the migration CLI's public deadline keeps the native writer guard
 * through late DML and the same batch never replays. Its own file and container because it waits
 * on the CLI's real 30s deadline, the longest single wait in the Doltgres lane (task.0138).
 */
import {
	GenericContainer,
	type StartedTestContainer,
	Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, it } from "vitest";

import { assertCliKeepsGuardThroughLateDml } from "./doltgres-admission.fixture";

const PASSWORD = "admission-test";

describe("Doltgres 0.57.3 migration CLI public deadline", () => {
	let container: StartedTestContainer;
	let origin: string;

	beforeAll(async () => {
		container = await new GenericContainer("dolthub/doltgresql:0.57.3")
			.withEnvironment({ DOLTGRES_PASSWORD: PASSWORD })
			.withExposedPorts(5432)
			.withWaitStrategy(
				Wait.forLogMessage(/server (started|listening)/i, 1).withStartupTimeout(
					60_000,
				),
			)
			.start();
		origin = `postgresql://postgres:${PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}`;
	}, 90_000);

	afterAll(async () => {
		await container?.stop();
	});

	it("actual CLI public deadline retains native guard through late DML; same batch never replays", async () => {
		await assertCliKeepsGuardThroughLateDml(origin, "public deadline");
	});
});
