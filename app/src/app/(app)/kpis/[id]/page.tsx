// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
import { redirect } from "next/navigation";
export default async function KpiPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<{ observation?: string }>;
}) {
	const { id } = await params;
	const observation = (await searchParams).observation;
	redirect(
		`/knowledge/${encodeURIComponent(id)}${observation ? `?observation=${encodeURIComponent(observation)}` : ""}`,
	);
}
