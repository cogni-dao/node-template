// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/connections/Connections.client`
 * Purpose: The connections table: one row per provider this node's `.cogni/service-links.yaml` lists as a target. Helps a customer admin decide which provider this node may spend on, and how much.
 *   Columns: Node · Offer · Status · Cap · actions. Actions: Connect (a cap in credits) and Disconnect. Same layout, components and table style as the AI access page.
 * Scope: Presentation over plain `fetch` (`cache: "no-store"`, the browser session only). Loads on mount and after every action. Decides nothing: the node signs and sends, the provider answers.
 * Invariants:
 *   - HUMAN_ROUTES_SESSION_ONLY: requests carry the browser session; this file never sets an Authorization header.
 *   - NON_ADMIN_SEES_NOTHING: a 401, 403 or 404 from the list shows nothing at all (no heading, no skeleton).
 *   - NO_SIGNER_IS_A_STATE: a node with no signing key shows one clear line and offers no Connect; the offer text from config still shows.
 *   - THE_PROVIDERS_ANSWER_SHOWS: after a click, one status line says what the provider answered (connected, disconnected, or its plain refusal code), never a token.
 *   - ONE_CLICK_ONE_ACTION: a click in flight replaces that row's actions with a Skeleton; every other click is ignored meanwhile (never dimmed).
 *   - No filters and no extra controls.
 * Side-effects: IO (fetch)
 * Links: story.0038, src/app/api/v1/admin/connections/route.ts
 * @internal
 */

"use client";

import type { ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button, Input, Skeleton } from "@/components";

import { CONNECTIONS_PATH } from "./connections-endpoints";

interface Target {
	readonly alias: string;
	readonly origin: string;
	readonly offer?: string;
	readonly status: "connected" | "not_connected";
	readonly cap: number | null;
}

interface View {
	readonly signer: boolean;
	readonly targets: readonly Target[];
}

type State =
	| { readonly status: "loading" }
	| { readonly status: "hidden" }
	| { readonly status: "unavailable" }
	| { readonly status: "ready"; readonly view: View };

const UNAVAILABLE_COPY = "Can't load connections right now. Try again.";
const NO_SIGNER_COPY = "This node has no signing key, so it cannot connect to another node.";

const credits = (n: number): string => n.toLocaleString();

function hostOf(origin: string): string {
	try {
		return new URL(origin).host;
	} catch {
		return origin;
	}
}

function isView(value: unknown): value is View {
	const v = value as { signer?: unknown; targets?: unknown } | null;
	return !!v && typeof v.signer === "boolean" && Array.isArray(v.targets);
}

/** One line about the provider's answer to a click, in plain words. */
function answerLine(alias: string, body: { status?: unknown; error?: unknown; httpStatus?: unknown } | null, httpStatus: number): string {
	if (body?.status === "connected") return `${alias} accepted the connection.`;
	if (body?.status === "disconnected") return `${alias} recorded the disconnect.`;
	if (typeof body?.error === "string" && /^[a-z_]{1,40}$/.test(body.error)) {
		if (httpStatus === 404) return "That node is not one this node is set up to use.";
		if (httpStatus === 502) return `Couldn't reach ${alias}. Try again.`;
		if (httpStatus === 503 && body.error === "signer_unavailable") return NO_SIGNER_COPY;
		return `${alias} did not accept it: ${body.error.replaceAll("_", " ")}.`;
	}
	if (typeof body?.httpStatus === "number") return `${alias} answered with status ${body.httpStatus}.`;
	return `${alias} did not accept it.`;
}

export function ConnectionsClient(): ReactElement | null {
	const [state, setState] = useState<State>({ status: "loading" });
	const [busy, setBusy] = useState<string | null>(null);
	const [answer, setAnswer] = useState<string | null>(null);
	const [caps, setCaps] = useState<Readonly<Record<string, string>>>({});
	const sequence = useRef(0);

	const load = useCallback(async (): Promise<void> => {
		const mine = ++sequence.current;
		try {
			const res = await fetch(CONNECTIONS_PATH, { cache: "no-store" });
			if (mine !== sequence.current) return;
			if (res.status === 503) return setState({ status: "unavailable" });
			if (!res.ok) return setState((prev) => (prev.status === "ready" ? prev : { status: "hidden" }));
			const body: unknown = await res.json();
			if (mine === sequence.current) setState(isView(body) ? { status: "ready", view: body } : { status: "hidden" });
		} catch {
			if (mine === sequence.current) setState((prev) => (prev.status === "ready" ? prev : { status: "hidden" }));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const send = async (alias: string, body: { act: "connect"; alias: string; cap: number } | { act: "disconnect"; alias: string }): Promise<void> => {
		if (busy !== null) return;
		setBusy(alias);
		setAnswer(null);
		try {
			const res = await fetch(CONNECTIONS_PATH, { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
			const parsed: { status?: unknown; error?: unknown; httpStatus?: unknown } | null = await res.json().catch(() => null);
			setAnswer(answerLine(alias, parsed, res.status));
			await load();
		} catch {
			setAnswer(`Couldn't reach ${alias}. Try again.`);
		} finally {
			setBusy(null);
		}
	};

	const connect = (target: Target): void => {
		const cap = Number(caps[target.alias] ?? "");
		if (!Number.isSafeInteger(cap) || cap < 1) return setAnswer("Enter a cap in whole credits.");
		void send(target.alias, { act: "connect", alias: target.alias, cap });
	};

	// No flash: nothing renders until the server confirms an admin view or a 503.
	if (state.status === "hidden" || state.status === "loading") return null;

	return (
		<section aria-labelledby="connections-heading">
			<div className="pt-8 pb-2">
				<h2 id="connections-heading" className="font-semibold text-foreground text-lg">
					Connections
				</h2>
				<div className="mt-2 border-border border-b" />
			</div>

			{state.status === "unavailable" && (
				<p className="flex items-center gap-3 py-3 text-destructive text-sm" role="alert">
					{UNAVAILABLE_COPY}
					<button type="button" className="text-foreground underline" onClick={() => void load()}>
						Try again
					</button>
				</p>
			)}

			{state.status === "ready" && (
				<div className="py-2">
					{!state.view.signer && (
						<p className="pb-2 text-destructive text-sm" role="alert">
							{NO_SIGNER_COPY}
						</p>
					)}
					{answer && (
						<p className="pb-2 text-foreground text-sm" role="status">
							{answer}
						</p>
					)}
					{state.view.targets.length === 0 ? (
						<p className="py-2 text-muted-foreground text-sm">No other node is set up for this node to use.</p>
					) : (
						<div className="overflow-x-auto">
							<table className="w-full text-left text-sm">
								<thead className="text-muted-foreground text-xs">
									<tr>
										<th scope="col" className="py-1 pr-3 font-medium">Node</th>
										<th scope="col" className="py-1 pr-3 font-medium">Offer</th>
										<th scope="col" className="py-1 pr-3 font-medium">Status</th>
										<th scope="col" className="py-1 pr-3 text-right font-medium">Cap</th>
										{state.view.signer && <th scope="col" className="py-1 text-right font-medium">Actions</th>}
									</tr>
								</thead>
								<tbody className="divide-y divide-border">
									{state.view.targets.map((target) => {
										const saving = busy === target.alias;
										return (
											<tr key={target.alias} aria-busy={saving || undefined}>
												<td className="py-2 pr-3 align-top text-foreground">
													<span className="font-mono">{target.alias}</span>
													<div className="text-muted-foreground text-xs">{hostOf(target.origin)}</div>
												</td>
												<td className="py-2 pr-3 align-top text-muted-foreground">{target.offer ?? "—"}</td>
												<td className="whitespace-nowrap py-2 pr-3 align-top text-foreground">{target.status === "connected" ? "Connected" : "Not connected"}</td>
												<td className="whitespace-nowrap py-2 pr-3 text-right align-top tabular-nums">{target.cap === null ? "—" : credits(target.cap)}</td>
												{state.view.signer && (
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
																	placeholder="Cap"
																	aria-label={`Cap in credits for ${target.alias}`}
																	value={caps[target.alias] ?? ""}
																	onChange={(event) => setCaps((prev) => ({ ...prev, [target.alias]: event.target.value }))}
																/>
																<Button type="button" size="sm" onClick={() => connect(target)}>
																	Connect
																</Button>
																{target.status === "connected" && (
																	<Button type="button" size="sm" variant="outline" onClick={() => void send(target.alias, { act: "disconnect", alias: target.alias })}>
																		Disconnect
																	</Button>
																)}
															</div>
														)}
													</td>
												)}
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
					)}
				</div>
			)}
		</section>
	);
}
