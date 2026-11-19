// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/connected-orgs/ConnectedOrgs.client`
 * Purpose: The connected orgs table: one row per customer node that connected to this node. Helps a provider admin decide how much each may spend and whether to stop one.
 *   Columns: Org · Status · Allowance · Used / cap · Last call · actions. Actions: Suspend or Resume, and Grant allowance (a number of credits). Same layout, components and table style as the AI access page.
 * Scope: Presentation over plain `fetch` (`cache: "no-store"`, the browser session only). Loads on mount and after every action. Decides nothing: every decision is the routes'.
 * Invariants:
 *   - HUMAN_ROUTES_SESSION_ONLY: requests carry the browser session; this file never sets an Authorization header.
 *   - NON_ADMIN_SEES_NOTHING: the layout already redirects non-admins; a 401, 403 or 404 from the list shows nothing at all (no heading, no skeleton).
 *   - ONE_CLICK_ONE_ACTION: a click in flight replaces that row's actions with a Skeleton; every other row's actions ignore clicks meanwhile (never dimmed).
 *   - HUMAN_SURFACE_TOKENLESS: the text holds no token, id, key or API path. An allowance grant sends one fresh Idempotency-Key per click, so a double click grants once.
 *   - No filters and no extra controls: a "More" link appears only when the server says there is another page.
 * Side-effects: IO (fetch)
 * Links: story.0038, src/app/api/v1/admin/connected-orgs/route.ts
 * @internal
 */

"use client";

import type { ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button, Input, Skeleton } from "@/components";

import { allowancePath, CONNECTED_ORGS_PATH, suspensionPath } from "./connected-orgs-endpoints";

type Status = "connected" | "suspended" | "disconnected";

interface ConnectedOrg {
	readonly orgUserId: string;
	readonly issuer: string;
	readonly nodeId?: string;
	readonly status: Status;
	readonly allowance: number;
	readonly debits: number;
	readonly cap: number;
	readonly lastCallAt: string | null;
}

interface Page {
	readonly orgs: readonly ConnectedOrg[];
	readonly nextAfter: string | null;
}

type State =
	| { readonly status: "loading" }
	| { readonly status: "hidden" }
	| { readonly status: "unavailable" }
	| { readonly status: "ready"; readonly page: Page };

const PAGE_SIZE = 50;
const UNAVAILABLE_COPY = "Can't load connected orgs right now. Try again.";
const ACTION_FAILED_COPY = "That did not go through. Try again.";
const STATUS_LABEL: Record<Status, string> = { connected: "Connected", suspended: "Suspended", disconnected: "Disconnected" };

const credits = (n: number): string => n.toLocaleString();

/** The issuer's host, shown as the org's name; the raw text if it is not a URL. */
function hostOf(issuer: string): string {
	try {
		return new URL(issuer).host;
	} catch {
		return issuer;
	}
}

/** A date for the last billed call: day and month, from the ISO the server sent. */
function lastCall(iso: string | null): string {
	if (!iso) return "—";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function isPage(value: unknown): value is Page {
	const v = value as { orgs?: unknown; nextAfter?: unknown } | null;
	return !!v && Array.isArray(v.orgs) && (v.nextAfter === null || typeof v.nextAfter === "string");
}

export function ConnectedOrgsClient(): ReactElement | null {
	const [state, setState] = useState<State>({ status: "loading" });
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [amounts, setAmounts] = useState<Readonly<Record<string, string>>>({});
	const sequence = useRef(0);

	/** Loads the first `limit` rows (a click replaces the table, so a row an action changed is read back from the server). */
	const load = useCallback(async (limit: number): Promise<void> => {
		const mine = ++sequence.current;
		try {
			const res = await fetch(`${CONNECTED_ORGS_PATH}?limit=${limit}`, { cache: "no-store" });
			if (mine !== sequence.current) return;
			if (res.status === 503) return setState({ status: "unavailable" });
			if (!res.ok) return setState((prev) => (prev.status === "ready" ? prev : { status: "hidden" }));
			const body: unknown = await res.json();
			if (mine === sequence.current) setState(isPage(body) ? { status: "ready", page: body } : { status: "hidden" });
		} catch {
			if (mine === sequence.current) setState((prev) => (prev.status === "ready" ? prev : { status: "hidden" }));
		}
	}, []);

	useEffect(() => {
		void load(PAGE_SIZE);
	}, [load]);

	const more = useCallback(async (after: string): Promise<void> => {
		try {
			const res = await fetch(`${CONNECTED_ORGS_PATH}?limit=${PAGE_SIZE}&after=${encodeURIComponent(after)}`, { cache: "no-store" });
			const body: unknown = res.ok ? await res.json() : null;
			if (!isPage(body)) return setError(UNAVAILABLE_COPY);
			setState((prev) => (prev.status === "ready" ? { status: "ready", page: { orgs: [...prev.page.orgs, ...body.orgs], nextAfter: body.nextAfter } } : prev));
		} catch {
			setError(UNAVAILABLE_COPY);
		}
	}, []);

	const act = useCallback(
		async (orgUserId: string, run: () => Promise<Response>): Promise<boolean> => {
			if (busy !== null) return false;
			setBusy(orgUserId);
			setError(null);
			try {
				const ok = (await run()).ok;
				if (!ok) setError(ACTION_FAILED_COPY);
				const loaded = state.status === "ready" ? state.page.orgs.length : PAGE_SIZE;
				await load(Math.min(100, Math.max(PAGE_SIZE, loaded)));
				return ok;
			} catch {
				setError(ACTION_FAILED_COPY);
				return false;
			} finally {
				setBusy(null);
			}
		},
		[busy, load, state]
	);

	const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
		fetch(path, { method: "POST", cache: "no-store", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

	const suspend = (org: ConnectedOrg) => act(org.orgUserId, () => post(suspensionPath(org.orgUserId), { suspended: org.status !== "suspended" }));

	const grant = async (org: ConnectedOrg): Promise<void> => {
		const credit = Number(amounts[org.orgUserId] ?? "");
		if (!Number.isSafeInteger(credit) || credit < 1) return setError("Enter a whole number of credits.");
		const ok = await act(org.orgUserId, () => post(allowancePath(org.orgUserId), { credits: credit }, { "idempotency-key": crypto.randomUUID() }));
		if (ok) setAmounts((prev) => ({ ...prev, [org.orgUserId]: "" }));
	};

	// No flash: nothing renders until the server confirms an admin view or a 503.
	if (state.status === "hidden" || state.status === "loading") return null;

	return (
		<section aria-labelledby="connected-orgs-heading">
			<div className="pt-8 pb-2">
				<h2 id="connected-orgs-heading" className="font-semibold text-foreground text-lg">
					Connected orgs
				</h2>
				<div className="mt-2 border-border border-b" />
			</div>

			{state.status === "unavailable" && (
				<p className="flex items-center gap-3 py-3 text-destructive text-sm" role="alert">
					{UNAVAILABLE_COPY}
					<button type="button" className="text-foreground underline" onClick={() => void load(PAGE_SIZE)}>
						Try again
					</button>
				</p>
			)}

			{state.status === "ready" && (
				<div className="py-2">
					{error && (
						<p className="pb-2 text-destructive text-sm" role="alert">
							{error}
						</p>
					)}
					{state.page.orgs.length === 0 ? (
						<p className="py-2 text-muted-foreground text-sm">No node has connected yet.</p>
					) : (
						<div className="overflow-x-auto">
							<table className="w-full text-left text-sm">
								<thead className="text-muted-foreground text-xs">
									<tr>
										<th scope="col" className="py-1 pr-3 font-medium">Org</th>
										<th scope="col" className="py-1 pr-3 font-medium">Status</th>
										<th scope="col" className="py-1 pr-3 text-right font-medium">Allowance</th>
										<th scope="col" className="py-1 pr-3 text-right font-medium">Used / cap</th>
										<th scope="col" className="py-1 pr-3 font-medium">Last call</th>
										<th scope="col" className="py-1 text-right font-medium">Actions</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-border">
									{state.page.orgs.map((org) => {
										const saving = busy === org.orgUserId;
										return (
											<tr key={org.orgUserId} aria-busy={saving || undefined}>
												<td className="py-2 pr-3 align-top text-foreground">
													<span className="font-mono">{hostOf(org.issuer)}</span>
													{org.nodeId && <div className="text-muted-foreground text-xs">Node {org.nodeId}</div>}
												</td>
												<td className={`whitespace-nowrap py-2 pr-3 align-top ${org.status === "suspended" ? "text-destructive" : "text-foreground"}`}>
													{STATUS_LABEL[org.status]}
												</td>
												<td className="whitespace-nowrap py-2 pr-3 text-right align-top tabular-nums">{credits(org.allowance)}</td>
												<td className="whitespace-nowrap py-2 pr-3 text-right align-top text-muted-foreground tabular-nums">
													{credits(org.debits)} / {credits(org.cap)}
												</td>
												<td className="whitespace-nowrap py-2 pr-3 align-top text-muted-foreground">{lastCall(org.lastCallAt)}</td>
												<td className="py-2 align-top">
													{saving ? (
														<>
															<Skeleton className="ml-auto h-9 w-40" />
															<span className="sr-only" role="status">Saving</span>
														</>
													) : (
														<div className="flex flex-wrap items-center justify-end gap-2">
															<Input
																type="number"
																inputMode="numeric"
																min={1}
																step={1}
																className="w-28"
																placeholder="Credits"
																aria-label={`Allowance to grant ${hostOf(org.issuer)}`}
																value={amounts[org.orgUserId] ?? ""}
																onChange={(event) => setAmounts((prev) => ({ ...prev, [org.orgUserId]: event.target.value }))}
															/>
															<Button type="button" size="sm" onClick={() => void grant(org)}>
																Grant allowance
															</Button>
															<Button type="button" size="sm" variant="outline" onClick={() => void suspend(org)}>
																{org.status === "suspended" ? "Resume" : "Suspend"}
															</Button>
														</div>
													)}
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
					)}
					{state.page.nextAfter && (
						<button type="button" className="pt-3 text-foreground text-sm underline" onClick={() => void more(state.page.nextAfter as string)}>
							More
						</button>
					)}
				</div>
			)}
		</section>
	);
}
