// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/ReassignAgentWorkPanel.client`
 * Purpose: Admin panel to move work items from a re-keyed agent principal to its successor (bug.0013).
 * Scope: Client component. Preview (dry run) then Reassign via `POST /api/v1/work/items/reassign`. No authorization logic here.
 * Invariants: The route is the security boundary (session-only node admin); this panel is a UX surface. Reassign is enabled only after a Preview of the same from/to pair.
 * Side-effects: IO (fetch POST) on user click
 * Links: src/app/api/v1/work/items/reassign/route.ts, https://node-template.cognidao.org/work/items/bug.0013
 * @public
 */
"use client";

import type { WorkItemsReassignOutput } from "@cogni/node-contracts";
import { type ReactElement, useState } from "react";

import { Button, Card, CardContent, Input } from "@/components";

export const REASSIGN_PATH = "/api/v1/work/items/reassign";

async function postReassign(body: {
	fromPrincipalId: string;
	toPrincipalId: string;
	dryRun: boolean;
}): Promise<WorkItemsReassignOutput> {
	const res = await fetch(REASSIGN_PATH, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const data = (await res.json().catch(() => ({}))) as
		| WorkItemsReassignOutput
		| { error?: string; errorCode?: string };
	if (!res.ok) {
		const failure = data as { error?: string; errorCode?: string };
		throw new Error(failure.error ?? failure.errorCode ?? `HTTP ${res.status}`);
	}
	return data as WorkItemsReassignOutput;
}

export function ReassignAgentWorkPanel(): ReactElement {
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<WorkItemsReassignOutput | null>(null);

	const pair = { fromPrincipalId: from.trim(), toPrincipalId: to.trim() };
	const previewed =
		result?.dryRun === true &&
		result.fromPrincipalId === pair.fromPrincipalId.toLowerCase() &&
		result.toPrincipalId === pair.toPrincipalId.toLowerCase();

	async function run(dryRun: boolean): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			setResult(await postReassign({ ...pair, dryRun }));
		} catch (e) {
			setResult(null);
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Card className="h-full">
			<CardContent className="space-y-4 p-5">
				<div className="space-y-1">
					<h3 className="font-semibold">Reassign agent work</h3>
					<p className="text-muted-foreground text-sm">
						Move every work item created by an old agent principal to its
						re-keyed successor. Preview first; reassign writes one commit.
					</p>
				</div>
				<div className="grid gap-3 sm:grid-cols-2">
					<label className="space-y-1 text-sm">
						<span className="text-muted-foreground">From principal</span>
						<Input
							value={from}
							onChange={(e) => setFrom(e.target.value)}
							placeholder="old principal UUID"
							className="font-mono"
							spellCheck={false}
						/>
					</label>
					<label className="space-y-1 text-sm">
						<span className="text-muted-foreground">To principal</span>
						<Input
							value={to}
							onChange={(e) => setTo(e.target.value)}
							placeholder="successor principal UUID"
							className="font-mono"
							spellCheck={false}
						/>
					</label>
				</div>
				<div className="flex gap-2">
					<Button
						variant="outline"
						disabled={busy || !pair.fromPrincipalId || !pair.toPrincipalId}
						onClick={() => void run(true)}
					>
						Preview
					</Button>
					<Button
						disabled={busy || !previewed || result?.count === 0}
						onClick={() => void run(false)}
					>
						Reassign
					</Button>
				</div>
				{error ? <p className="text-destructive text-sm">{error}</p> : null}
				{result ? (
					<div className="space-y-1 text-sm">
						<p>
							{result.dryRun
								? `${result.count} item(s) would move.`
								: `${result.count} item(s) reassigned.`}
						</p>
						{result.ids.length > 0 ? (
							<p className="font-mono text-muted-foreground text-xs">
								{result.ids.join(", ")}
							</p>
						) : null}
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}
