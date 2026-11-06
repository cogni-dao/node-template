// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

"use client";

import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@cogni/node-ui-kit/shadcn/sheet";
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

function DetailMessage({ failed = false }: { readonly failed?: boolean }) {
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
					onClick={() => window.location.reload()}
				>
					Reload page
				</button>
			)}
		</SheetHeader>
	);
}

class DetailBoundary extends Component<
	{ readonly children: ReactNode },
	{ failed: boolean }
> {
	override state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	override render() {
		return this.state.failed ? (
			<div role="alert">
				<DetailMessage failed />
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
	...body
}: WorkItemDetailBodyProps & {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly opener: RefObject<HTMLElement | null>;
	readonly fallback: RefObject<HTMLElement | null>;
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
					<DetailBoundary>
						<Suspense fallback={<DetailMessage />}>
							<DetailBody {...(open ? body : lastBody.current)} />
						</Suspense>
					</DetailBoundary>
				)}
			</SheetContent>
		</Sheet>
	);
}
