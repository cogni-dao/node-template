// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * TRAILER_PARITY (story.0032): `work.cite-share@1` reads the commit message that
 * `@cogni/work-items` writes, with its own copy of the parser (the metrics
 * package imports no other package). Both parsers must agree on every message.
 */
import { parsePatchCommit } from "@cogni-dao/metrics/cite-share";
import {
  formatCitesTrailer,
  parseWorkItemCommitMessage,
} from "@cogni/work-items";
import { describe, expect, it } from "vitest";

const H1 = "a".repeat(32);
const H2 = "0123456789abcdefghijklmnopqrstuv";
const ACTOR = "52d379aa-e925-4da9-8e6b-2fd62e8a10d0";
const first = `work-items: patch task.0086 by actor:${ACTOR}`;

const messages: readonly string[] = [
  first,
  `${first}\nReason: Scope moves.`,
  `${first}\nReason: Scope moves.\nCites: ${formatCitesTrailer([
    { id: "change-history-design", commit: H1 },
    { id: "metrics-expert", commit: H2, contribution: "contrib-derek-x-1" },
  ])}`,
  `${first}\nReason: r.\nCites: bad, good-atom@${H1}, Upper@${H1}, x@${"w".repeat(32)}`,
  `${first}\nReason: r.\nCites: only-bad, nope@123`,
  `${first}\nReason: see Cites: a@${H1}`,
  `${first}\nReason: r.\n Cites: a@${H1}`,
  `${first}\nReason: r.\nCites: a@${H1}\nCites: b@${H2}`,
  `${first}\nReason: \nCites: a@${H1}`,
  `${first} Cites: a@${H1}`,
  // Length boundaries of the id (256 ok, 257 not) and the inbox (200 ok, 201 not).
  `${first}\nCites: ${"a".repeat(256)}@${H1}, ${"a".repeat(257)}@${H1}`,
  `${first}\nCites: x@contrib-${"b".repeat(193)}:${H2}, x@contrib-${"b".repeat(194)}:${H2}`,
];

describe("work.cite-share@1 reads the work-items commit message", () => {
  it.each(messages.map((m, i) => [i, m] as const))(
    "agrees with parseWorkItemCommitMessage on message %i",
    (_i, message) => {
      const mine = parsePatchCommit(message);
      const theirs = parseWorkItemCommitMessage(message);
      if (theirs.actor === null) {
        expect(mine).toBeNull();
        return;
      }
      expect(mine).not.toBeNull();
      expect(mine?.cites).toEqual(theirs.cites);
      expect(mine?.hasReason).toBe(
        theirs.reason !== null && theirs.reason.length > 0,
      );
    },
  );
});
