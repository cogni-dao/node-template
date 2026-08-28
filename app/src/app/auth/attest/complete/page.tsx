// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/auth/attest/complete`
 * Purpose: Closing leg of operator-attested GitHub sign-in — turns the returned attestation into a session.
 * Scope: Client-only. Reads the token, hands it to NextAuth, redirects. Does not verify
 *   the token (the server does) or read the database.
 * Invariants:
 *   - PUBLIC_BY_NECESSITY: a user signing in has no session yet, so this page cannot sit
 *     behind the proxy's app-route gate. It is registered as public in `proxy.ts`.
 *   - FRAGMENT_IS_CLIENT_ONLY: the operator returns the JWT in a URL fragment, which is
 *     never sent to a server. Only a client component can read it.
 *   - SCRUB_BEFORE_NAVIGATING: the fragment is cleared from history immediately so the
 *     attestation does not survive in the address bar, back button, or a shared link.
 * Side-effects: IO (signIn), history.replaceState
 * Links: task.5042, src/auth.ts
 * @public
 */

"use client";

import { signIn } from "next-auth/react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { OPERATOR_ATTESTED_PROVIDER_ID } from "@/shared/identity/signin-paths";

export const dynamic = "force-dynamic";

export default function AttestSignInCompletePage(): ReactElement {
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
		const token = params.get("attestation");
		// Scrub first: everything after this can navigate, and the fragment must not
		// survive in history or in a URL the human might copy.
		window.history.replaceState(null, "", window.location.pathname);

		if (!token) {
			setFailed(true);
			return;
		}
		void signIn(OPERATOR_ATTESTED_PROVIDER_ID, {
			token,
			callbackUrl: "/chat",
		}).then((result) => {
			if (result?.error) setFailed(true);
		});
	}, []);

	return (
		<main className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-8 text-center">
			{failed ? (
				<>
					<h1 className="font-semibold text-lg">Sign-in link expired</h1>
					<p className="max-w-sm text-muted-foreground text-sm">
						That GitHub verification is no longer valid. Head back and start
						sign-in again.
					</p>
					<a className="text-sm underline" href="/">
						Back to sign in
					</a>
				</>
			) : (
				<p className="text-muted-foreground text-sm">Finishing sign-in…</p>
			)}
		</main>
	);
}
