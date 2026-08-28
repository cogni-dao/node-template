// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/auth/attest/complete/view`
 * Purpose: The account-intent gate for operator-attested sign-in, rendered on the NODE.
 * Scope: Reads the attestation from the URL fragment, shows who is entering where, and
 *   signs in on a deliberate click. Verifies nothing — the server owns every decision.
 * Invariants:
 *   - FRAGMENT_IS_CLIENT_ONLY: the operator returns the JWT in a URL fragment, which is
 *     never sent to a server. Only a client component can read it.
 *   - SCRUB_BEFORE_NAVIGATING: the fragment is cleared from history immediately so the
 *     attestation does not survive in the address bar, back button, or a shared link.
 *   - DISPLAY_ONLY_DECODE: the payload is read UNVERIFIED, to render a name and avatar.
 *     It decides nothing. `authorize()` verifies signature, issuer, audience, origin and
 *     the challenge cookie server-side; a tampered payload changes the text here and
 *     fails there.
 *   - NO_AUTO_SUBMIT: nothing fires without a human click. This screen is the intent
 *     gate, and it lives here rather than on the operator so a person signing in to a
 *     node never reads a page belonging to a product they did not ask for (task.5042).
 * Side-effects: IO (signIn), history.replaceState
 * @public
 */

"use client";

import { signIn } from "next-auth/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { Button } from "@/components/kit/inputs/Button";
import { OPERATOR_ATTESTED_PROVIDER_ID } from "@/shared/identity/signin-paths";

/** Read `github.login` out of an unverified JWT payload, for display only. */
function readLogin(token: string): string | null {
	try {
		const [, payload] = token.split(".");
		if (!payload) return null;
		const json = JSON.parse(
			atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
		) as { github?: { login?: string | null } };
		return json.github?.login ?? null;
	} catch {
		return null;
	}
}

export function AttestSignInComplete({
	nodeName,
}: {
	readonly nodeName: string;
}): ReactElement {
	const [token, setToken] = useState<string | null>(null);
	const [login, setLogin] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [expired, setExpired] = useState(false);

	useEffect(() => {
		const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
		const t = params.get("attestation");
		// Scrub first: everything after this can navigate, and the attestation must not
		// survive in history or in a URL someone might copy.
		window.history.replaceState(null, "", window.location.pathname);
		if (!t) {
			setExpired(true);
			return;
		}
		setToken(t);
		setLogin(readLogin(t));
	}, []);

	if (expired) {
		return (
			<main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-6">
				<p className="text-muted-foreground">Link expired</p>
				<Button asChild variant="outline">
					<a href="/">Start over</a>
				</Button>
			</main>
		);
	}

	return (
		<main className="flex min-h-dvh flex-col items-center justify-center gap-8 p-6">
			{/* The face answers "is this you?" faster than any handle can, which is the
			    only question this screen asks — so it is the only large thing on it. */}
			{login ? (
				// biome-ignore lint/performance/noImgElement: remote GitHub avatar; next/image would need per-node remote-pattern config for no benefit
				<img
					alt=""
					className="size-20 rounded-full ring-1 ring-border"
					src={`https://github.com/${login}.png?size=160`}
				/>
			) : null}

			<div className="space-y-1.5 text-center">
				<p className="font-semibold text-2xl tracking-tight">
					{login ? `@${login}` : "…"}
				</p>
				<p className="text-muted-foreground text-sm">
					signing in to <span className="text-foreground">{nodeName}</span>
				</p>
			</div>

			<div className="flex items-center gap-1">
				<Button
					disabled={!token || pending}
					onClick={() => {
						setPending(true);
						void signIn(OPERATOR_ATTESTED_PROVIDER_ID, {
							token,
							callbackUrl: "/chat",
						}).then((r) => {
							if (r?.error) {
								setPending(false);
								setExpired(true);
							}
						});
					}}
				>
					{pending ? "Signing in…" : "Continue"}
				</Button>
				<Button asChild variant="ghost">
					<a href="/">Cancel</a>
				</Button>
			</div>
		</main>
	);
}
