// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/_components/WorkDetailSheet`
 * Purpose: One eager, controlled Work detail Sheet whose body loads lazily on first selection.
 * Scope: Presentation and focus management. The view owns selection and data.
 * Invariants:
 *   - ONE_DIALOG: a single Sheet instance serves every selected item.
 *   - NO_AUTO_RELOAD: a failed body chunk shows Close and Reload page inside the dialog; it never reloads itself.
 *   - FOCUS_RETURNS: close restores focus to the opener, else the Work heading.
 *   - BOUNDARY_PER_ITEM: a render failure for one item does not stick to the next.
 * Side-effects: none
 * Links: ./WorkItemDetailBody.tsx, ../view.tsx, task.0035
 * @internal
 */

"use client";

import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/sheet";
import {
	Component,
	lazy,
	type ReactNode,
	type RefObject,
	Suspense,
	useEffect,
	useRef,
	useState,
} from "react";
import type { WorkItemDetailBodyProps } from "./WorkItemDetailBody";

const DetailBody = lazy(() =>
	import("./WorkItemDetailBody").then((module) => ({
		default: module.WorkItemDetailBody,
	})),
);

function DetailMessage({
	failed = false,
	reload = reloadPage,
}: {
	readonly failed?: boolean;
	readonly reload?: () => void;
}) {
	return (
		<SheetHeader className="px-6 py-16 text-center sm:text-center">
			<SheetTitle>
				{failed ? "Unable to load work item details" : "Loading work item"}
			</SheetTitle>
			<SheetDescription>
				{failed
					? "The detail view could not be loaded. Close it or reload the page to try again."
					: "Loading details for the selected work item."}
			</SheetDescription>
			{failed && (
				<button
					type="button"
					className="underline"
					onClick={reload}
				>
					Reload page
				</button>
			)}
		</SheetHeader>
	);
}

function reloadPage() {
	window.location.reload();
}

class DetailBoundary extends Component<
	{ readonly children: ReactNode; readonly reload: () => void },
	{ failed: boolean }
> {
	override state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	override render() {
		return this.state.failed ? (
			<div role="alert">
				<DetailMessage failed reload={this.props.reload} />
			</div>
		) : (
			this.props.children
		);
	}
}

export function WorkDetailSheet({
	open,
	onOpenChange,
	opener,
	fallback,
	reload = reloadPage,
	...body
}: WorkItemDetailBodyProps & {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly opener: RefObject<HTMLElement | null>;
	readonly fallback: RefObject<HTMLElement | null>;
	readonly reload?: () => void;
}) {
	const lastBody = useRef(body);
	const [everSelected, setEverSelected] = useState(open);
	useEffect(() => {
		if (open) {
			lastBody.current = body;
			setEverSelected(true);
		}
	});
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				className="w-full overflow-y-auto sm:max-w-lg"
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					if (open) return;
					const target =
						opener.current?.isConnected && opener.current !== document.body
							? opener.current
							: fallback.current;
					target?.focus();
				}}
			>
				{(open || everSelected) && (
					<DetailBoundary
						key={(open ? body : lastBody.current).itemId ?? "none"}
						reload={reload}
					>
						<Suspense fallback={<DetailMessage />}>
							<DetailBody {...(open ? body : lastBody.current)} />
						</Suspense>
					</DetailBoundary>
				)}
			</SheetContent>
		</Sheet>
	);
}
