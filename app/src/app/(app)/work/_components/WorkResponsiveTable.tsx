// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/work/_components/WorkResponsiveTable`
 * Purpose: Work table renderer whose mobile column set is decided by CSS before hydration and by state after it.
 * Scope: Presentation over the view's TanStack table. Owns no data or URL state.
 * Invariants:
 *   - PRESYNC_MATCHES_SYNC: before viewport sync, CSS hides exactly MOBILE_HIDDEN_COLUMNS
 *     at WORK_MOBILE_QUERY unless explicitly overridden, so hydration does not shift layout.
 *   - SKELETON_MATCHES_PAGE: loading rows equal the requested page size.
 * Side-effects: none
 * Links: ./WorkResponsiveTable.module.css, ../view.tsx, task.0035
 * @internal
 */

"use client";

import {
	DataGridTableBodyRow,
	DataGridTableViewport,
} from "@cogni/node-ui-kit/reui/data-grid/data-grid-table";
import {
	flexRender,
	type Table,
	type VisibilityState,
} from "@tanstack/react-table";
import type { CSSProperties } from "react";
import styles from "./WorkResponsiveTable.module.css";

/** Keep in sync with the `@media (max-width: 767px)` block in WorkResponsiveTable.module.css. */
export const WORK_MOBILE_QUERY = "(max-width: 767px)";

export const MOBILE_HIDDEN_COLUMNS: VisibilityState = {
	priority: false,
	rankScore: false,
	type: false,
	projectId: false,
	updatedAt: false,
	estimate: false,
};

export function WorkResponsiveTable<TData>({
	table,
	overrides,
	synced,
	isLoading,
	skeletonRows,
}: {
	readonly table: Table<TData>;
	readonly overrides: VisibilityState;
	readonly synced: boolean;
	readonly isLoading: boolean;
	readonly skeletonRows: number;
}) {
	const visible = table.getVisibleLeafColumns();
	const mobileCount = table
		.getAllLeafColumns()
		.filter(
			(column) =>
				overrides[column.id] ?? MOBILE_HIDDEN_COLUMNS[column.id] ?? true,
		).length;
	const attrs = (id: string) => ({
		"data-work-column": id,
		"data-work-override":
			overrides[id] === undefined ? undefined : String(overrides[id]),
	});
	const rows = table.getRowModel().rows;
	const message = "No work items found.";
	return (
		<DataGridTableViewport>
			<table className={styles.table} data-work-presync={!synced || undefined}>
				<colgroup>
					{visible.map((column) => (
						<col
							key={column.id}
							{...attrs(column.id)}
							style={
								{
									"--work-column-width": `${column.getSize()}px`,
								} as CSSProperties
							}
						/>
					))}
				</colgroup>
				<thead className="sticky top-0 z-10 bg-background">
					<tr>
						{table.getHeaderGroups()[0]?.headers.map((header) => (
							<th
								key={header.id}
								scope="col"
								{...attrs(header.column.id)}
								style={
									{
										"--work-column-width": `${header.column.getSize()}px`,
									} as CSSProperties
								}
								className="border-b px-2 h-8 text-left font-medium text-muted-foreground text-xs"
							>
								{header.isPlaceholder
									? null
									: flexRender(
											header.column.columnDef.header,
											header.getContext(),
										)}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{isLoading ? (
						Array.from(
							{ length: skeletonRows },
							(_, rowIndex) => `skeleton-${rowIndex}`,
						).map((rowKey) => (
							<tr key={rowKey} className="border-b">
								{visible.map((column) => (
									<td
										key={column.id}
										{...attrs(column.id)}
										className="px-2 py-1.5"
									>
										<div className="h-4 animate-pulse rounded bg-muted" />
									</td>
								))}
							</tr>
						))
					) : rows.length ? (
						rows.map((row) => (
							<DataGridTableBodyRow key={row.id} row={row}>
								{row.getVisibleCells().map((cell) => (
									<td
										key={cell.id}
										{...attrs(cell.column.id)}
										className={`px-2 py-1.5 align-middle ${cell.column.columnDef.meta?.cellClassName ?? ""}`}
									>
										{flexRender(cell.column.columnDef.cell, cell.getContext())}
									</td>
								))}
							</DataGridTableBodyRow>
						))
					) : synced ? (
						<tr>
							<td
								colSpan={Math.max(visible.length, 1)}
								className="p-6 text-center text-muted-foreground text-sm"
							>
								{message}
							</td>
						</tr>
					) : (
						<>
							<tr className={styles.desktopRow}>
								<td
									colSpan={Math.max(visible.length, 1)}
									className="p-6 text-center text-muted-foreground text-sm"
								>
									{message}
								</td>
							</tr>
							<tr className={styles.mobileRow}>
								<td
									colSpan={Math.max(mobileCount, 1)}
									className="p-6 text-center text-muted-foreground text-sm"
								>
									{message}
								</td>
							</tr>
						</>
					)}
				</tbody>
			</table>
		</DataGridTableViewport>
	);
}
