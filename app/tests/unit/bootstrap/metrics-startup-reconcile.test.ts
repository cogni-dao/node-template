import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	describeSchedule: vi.fn(),
	createSchedule: vi.fn(),
	updateSchedule: vi.fn(),
	ensureGrant: vi.fn(),
	governance: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("@/bootstrap/container", () => ({
	getContainer: () => ({
		executionGrantPort: { ensureGrant: mocks.ensureGrant },
		scheduleControl: {
			describeSchedule: mocks.describeSchedule,
			createSchedule: mocks.createSchedule,
			updateSchedule: mocks.updateSchedule,
		},
	}),
}));
vi.mock("@/bootstrap/jobs/syncGovernanceSchedules.job", () => ({
	runGovernanceSchedulesSyncJob: mocks.governance,
}));
vi.mock("@/shared/config", () => ({ getNodeId: () => "test-node" }));
vi.mock("@/shared/observability", () => ({
	makeLogger: () => ({ warn: mocks.warn }),
}));

beforeEach(() => {
	vi.resetModules();
	vi.resetAllMocks();
	vi.useFakeTimers();
	vi.stubEnv("APP_ENV", "production");
	vi.stubEnv("VITEST", "false");
	mocks.ensureGrant.mockResolvedValue({
		id: "00000000-0000-4000-8000-000000000001",
	});
	mocks.describeSchedule.mockResolvedValue(null);
	mocks.createSchedule.mockResolvedValue(undefined);
	mocks.updateSchedule.mockResolvedValue(undefined);
	mocks.governance.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe("automatic metric clock activation", () => {
	it("registers one scoped clock on boot without an ops request", async () => {
		const { startMetricsSyncOnBoot } = await import(
			"@/bootstrap/startup-reconcile"
		);
		startMetricsSyncOnBoot();
		startMetricsSyncOnBoot();
		await vi.dynamicImportSettled();
		expect(mocks.createSchedule).toHaveBeenCalledTimes(1);
		expect(mocks.createSchedule).toHaveBeenCalledWith(
			expect.objectContaining({
				scheduleId: "metrics:test-node:refresh",
				cron: "* * * * *",
				workflowType: "NodeTaskWorkflow",
				overlapPolicy: "skip",
			}),
		);
		expect(mocks.ensureGrant).toHaveBeenCalledWith(
			expect.objectContaining({
				scopes: ["task:dispatch:test-node:/api/internal/metrics/refresh"],
			}),
		);
	});

	it("retries a transient clock failure independently of governance", async () => {
		mocks.describeSchedule.mockRejectedValueOnce(new Error("unavailable"));
		mocks.governance.mockRejectedValue(new Error("governance unavailable"));
		const { startMetricsSyncOnBoot, startGovernanceSyncOnBoot } = await import(
			"@/bootstrap/startup-reconcile"
		);
		startGovernanceSyncOnBoot();
		startMetricsSyncOnBoot();
		await vi.dynamicImportSettled();
		expect(mocks.createSchedule).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(15000);
		await vi.dynamicImportSettled();
		expect(mocks.createSchedule).toHaveBeenCalledTimes(1);
		expect(mocks.governance).toHaveBeenCalledTimes(2);
	});

	it("keeps unit-test processes inert", async () => {
		vi.stubEnv("APP_ENV", "test");
		const { startMetricsSyncOnBoot } = await import(
			"@/bootstrap/startup-reconcile"
		);
		startMetricsSyncOnBoot();
		await vi.dynamicImportSettled();
		expect(mocks.ensureGrant).not.toHaveBeenCalled();
	});

	it("bounds unsuccessful boot reconciliation", async () => {
		mocks.describeSchedule.mockRejectedValue(new Error("unavailable"));
		const { startMetricsSyncOnBoot } = await import(
			"@/bootstrap/startup-reconcile"
		);
		startMetricsSyncOnBoot();
		await vi.dynamicImportSettled();
		await vi.advanceTimersByTimeAsync(120000);
		await vi.dynamicImportSettled();
		expect(mocks.ensureGrant).toHaveBeenCalledTimes(8);
		expect(mocks.warn).toHaveBeenLastCalledWith(
			expect.objectContaining({ kind: "metrics", exhausted: true }),
			"Schedule startup reconcile failed",
		);
	});
});

describe("clock identity and pause preservation", () => {
	it("reconciles an ambiguous create without making another clock", async () => {
		const paused = { isPaused: true, nextRunAtIso: null };
		mocks.describeSchedule
			.mockResolvedValueOnce(null)
			.mockResolvedValue(paused);
		mocks.createSchedule.mockRejectedValueOnce(new Error("response lost"));
		const { ensureMetricsRefreshSchedule } = await import(
			"@/bootstrap/jobs/metrics-refresh.job"
		);
		const result = await ensureMetricsRefreshSchedule();
		expect(mocks.createSchedule).toHaveBeenCalledTimes(1);
		expect(mocks.updateSchedule).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			scheduleId: "metrics:test-node:refresh",
			paused: true,
		});
	});
});
