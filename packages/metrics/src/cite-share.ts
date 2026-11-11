// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
/**
 * `work-items-trailer@1`: a pure reader of one work-item patch commit message,
 * the text `@cogni-dao/work-items` writes (change-history-design). Line 1 is
 * `work-items: patch <id> by actor:<principal>`. An optional `Reason: <text>`
 * line and an optional `Cites: id@commit, id@contrib-x:commit` line follow.
 * Each line matches only from its start, and a reason or a cite holds no line
 * break, so neither can forge another line. This module mirrors
 * `parseWorkItemCommitMessage` and `parseCitesTrailer` in `@cogni-dao/work-items`
 * because this package imports no other package; a parity test in the node app
 * runs both on the same messages. A change to any pattern here is a version
 * bump of the rules and of the `work.cite-share@1` calculator.
 */

export const CITE_SHARE_RULES_VERSION = "work-items-trailer@1";

/** Same patterns as `@cogni-dao/work-items/cites`. */
const CITE_ID = "[a-z0-9][a-z0-9._-]{0,255}";
const CITE_CONTRIBUTION = "contrib-[a-z0-9-]{1,200}";
/** A Dolt commit hash: 32 characters of base32 (0-9, a-v). */
const CITE_COMMIT = "[0-9a-v]{32}";
const CITE_PIN = new RegExp(
	`^(${CITE_ID})@(?:(${CITE_CONTRIBUTION}):)?(${CITE_COMMIT})$`,
);
/** A work item id as the metric SQL may quote it: letters, digits, `.`, `_`, `-`. */
export const WORK_ITEM_ID = /^[A-Za-z0-9._-]{1,128}$/;
const PATCH_FIRST_LINE = /^work-items: patch ([^ ]+) by actor:([^ ]+)$/;

export interface CitePin {
	id: string;
	commit: string;
	contribution?: string;
}

export interface PatchCommit {
	/** The work item the patch changed. */
	itemId: string;
	/** A `Reason: <text>` line with text. */
	hasReason: boolean;
	/** The valid pins of the first `Cites: ` line; an entry that is not a pin is dropped. */
	cites: CitePin[];
	/** The message holds a `Cites: ` line, valid or not. */
	hasCitesLine: boolean;
}

/** `id@commit, id@contrib-x:commit` to pins; an entry that is not a pin is dropped. */
export function parseCitePins(value: string): CitePin[] {
	const pins: CitePin[] = [];
	for (const part of value.split(",")) {
		const match = CITE_PIN.exec(part.trim());
		if (!match) continue;
		const [, id, contribution, commit] = match;
		pins.push({
			id: id as string,
			commit: commit as string,
			...(contribution ? { contribution } : {}),
		});
	}
	return pins;
}

/**
 * One commit message as a work-item patch, or null when line 1 is not a patch
 * line or names an id the metric SQL may not quote.
 */
export function parsePatchCommit(message: unknown): PatchCommit | null {
	if (typeof message !== "string") return null;
	const [first = "", ...rest] = message.split("\n");
	const match = PATCH_FIRST_LINE.exec(first);
	const itemId = match?.[1];
	if (!itemId || !WORK_ITEM_ID.test(itemId)) return null;
	const reason = rest.find((line) => line.startsWith("Reason: "));
	const cites = rest.find((line) => line.startsWith("Cites: "));
	return {
		itemId,
		hasReason: reason !== undefined && reason.length > "Reason: ".length,
		cites: cites === undefined ? [] : parseCitePins(cites.slice("Cites: ".length)),
		hasCitesLine: cites !== undefined,
	};
}
