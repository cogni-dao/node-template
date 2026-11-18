// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/knowledge-read`
 * Purpose: AI tool for reading knowledge entries by ID or listing by domain + tags.
 * Scope: Read-only retrieval. Does not write or commit.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__knowledge_read`
 *   - EFFECT_TYPED: effect is `read_only`
 *   - HARD_BOUNDS: max 50 results for list mode
 * Side-effects: IO (database read via capability)
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/knowledge-data-plane.md
 * @public
 */

import { z } from "zod";
import { KnowledgeRowSchema } from "@cogni-dao/knowledge-store/contracts";

import type { KnowledgeCapability, KnowledgeEntry } from "../capabilities/knowledge";
import { ACCESS_REQUESTED_MESSAGE, REMOTE_ALIAS_PATTERN, RemoteKnowledgeError, type RemoteKnowledgeCapability } from "../remote-knowledge";
import { readSourceProvenance, withoutSourceProvenance } from "../source-url";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const knowledgeReadFields = {
    id: z
      .string()
      .optional()
      .describe("Get a specific entry by ID (mutually exclusive with domain)"),
    domain: z
      .string()
      .optional()
      .describe("List entries by domain (mutually exclusive with id)"),
    tags: z
      .array(z.string())
      .optional()
      .describe("Filter by tags (only with domain mode)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Max results for list mode (1-50, default 20)"),
};
const idOrDomain = { message: "Either 'id' or 'domain' is required" };

/**
 * The input without `node`: what the model sees on a node that has no link targets. STRICT: a call that carries `node` (or any unknown key) is a validation error, never a silent read
 * of this node's own store.
 */
export const KnowledgeReadLocalInputSchema = z
  .strictObject(knowledgeReadFields)
  .refine((d) => d.id || d.domain, idOrDomain);

export const KnowledgeReadInputSchema = z
  .object({
    ...knowledgeReadFields,
    node: z
      .string()
      .regex(REMOTE_ALIAS_PATTERN)
      .optional()
      .describe(
        "Alias of another node whose knowledge to read instead of this node's own. Only aliases the server lists work."
      ),
  })
  .refine((d) => d.id || d.domain, idOrDomain);
export type KnowledgeReadInput = z.infer<typeof KnowledgeReadInputSchema>;

export const KnowledgeReadEntrySchema = KnowledgeRowSchema.extend({
  sourceUrl: z.string().url().optional(),
  sourceUrlUnavailable: z.literal(true).optional(),
});

export const KnowledgeReadOutputSchema = z.object({
  mode: z.enum(["get", "list"]),
  entries: z.array(KnowledgeReadEntrySchema),
  totalFound: z.number(),
  /** Set only when this node's AI asked the named node for access: the fixed, terminal answer of a remote read the target answered 401. */
  status: z.literal("access_requested").optional(),
  node: z.string().optional(),
  message: z.string().optional(),
});
export type KnowledgeReadOutput = z.infer<typeof KnowledgeReadOutputSchema>;
export type KnowledgeReadRedacted = KnowledgeReadOutput;

// ─── Contract ────────────────────────────────────────────────────────────────

export const KNOWLEDGE_READ_NAME = "core__knowledge_read" as const;

const KNOWLEDGE_READ_DESCRIPTION =
  "Read knowledge entries from the node's knowledge store. " +
  "Use with 'id' to get a specific entry, or 'domain' to list entries (optionally filtered by tags). " +
  "Each entry includes a confidence score (0-100): 30=draft, 80=verified, 95+=hardened. ";

export const knowledgeReadContract: ToolContract<
  typeof KNOWLEDGE_READ_NAME,
  KnowledgeReadInput,
  KnowledgeReadOutput,
  KnowledgeReadRedacted
> = {
  name: KNOWLEDGE_READ_NAME,
  description: `${KNOWLEDGE_READ_DESCRIPTION}Pass 'node' (a configured node alias) to read that node's knowledge instead.`,
  effect: "read_only",
  inputSchema: KnowledgeReadInputSchema,
  outputSchema: KnowledgeReadOutputSchema,
  redact: (output) => output,
  allowlist: ["mode", "entries", "totalFound", "status", "node", "message"] as const,
};

// ─── Implementation ──────────────────────────────────────────────────────────

export interface KnowledgeReadDeps {
  knowledgeCapability: KnowledgeCapability;
  readonly nodePublicOrigin?: string | undefined;
  /** Reads another node's knowledge when the call names an alias. Absent = the `node` argument is refused. */
  readonly remoteKnowledge?: RemoteKnowledgeCapability | undefined;
}

export function createKnowledgeReadImplementation(
  deps: KnowledgeReadDeps
): ToolImplementation<KnowledgeReadInput, KnowledgeReadOutput> {
  return {
    execute: async (input) => {
      if (input.node !== undefined) return executeRemote(deps, input.node, input);
      if (input.id) {
        const entry = await deps.knowledgeCapability.get(input.id);
        return {
          mode: "get" as const,
          entries: entry ? [{
            ...withoutSourceProvenance(entry),
            ...readSourceProvenance(deps.nodePublicOrigin, "knowledge", entry.id),
          }] : [],
          totalFound: entry ? 1 : 0,
        };
      }

      // After the `if (input.id)` early return, the Zod refine guarantees domain is defined
      const domain = input.domain ?? "";
      const entries = await deps.knowledgeCapability.list({
        domain,
        tags: input.tags,
        limit: input.limit ?? 20,
      });
      return {
        mode: "list" as const,
        entries: entries.map(e => ({
          ...withoutSourceProvenance(e),
          ...readSourceProvenance(deps.nodePublicOrigin, "knowledge", e.id),
        })),
        totalFound: entries.length,
      };
    },
  };
}

/** The same two modes against another node, with provenance from that node's configured origin. A missing or unknown alias is refused with a fixed message. */
async function executeRemote(
  deps: KnowledgeReadDeps,
  alias: string,
  input: KnowledgeReadInput
): Promise<KnowledgeReadOutput> {
  const remote = deps.remoteKnowledge;
  const origin = remote?.originOf(alias);
  if (!remote || origin === undefined) throw new RemoteKnowledgeError("unknown_alias", null);
  try {
    return await readRemote(remote, origin, alias, input);
  } catch (error) {
    if (error instanceof RemoteKnowledgeError && error.code === "access_requested")
      return { mode: input.id ? ("get" as const) : ("list" as const), entries: [], totalFound: 0, status: "access_requested" as const, node: alias, message: ACCESS_REQUESTED_MESSAGE };
    throw error;
  }
}

async function readRemote(
  remote: RemoteKnowledgeCapability,
  origin: string,
  alias: string,
  input: KnowledgeReadInput
): Promise<KnowledgeReadOutput> {
  const withProvenance = (e: KnowledgeEntry) => ({
    ...withoutSourceProvenance(e),
    ...readSourceProvenance(origin, "knowledge", e.id),
  });
  if (input.id) {
    const entry = await remote.get(alias, input.id);
    return { mode: "get" as const, entries: entry ? [withProvenance(entry)] : [], totalFound: entry ? 1 : 0 };
  }
  const limit = input.limit ?? 20;
  let entries = await remote.list(alias, { domain: input.domain ?? "", limit });
  const tags = input.tags;
  if (tags && tags.length > 0) entries = entries.filter((e) => tags.every((t) => e.tags?.includes(t)));
  return { mode: "list" as const, entries: entries.map(withProvenance), totalFound: entries.length };
}

export const knowledgeReadStubImplementation: ToolImplementation<
  KnowledgeReadInput,
  KnowledgeReadOutput
> = {
  execute: async () => {
    throw new Error(
      "KnowledgeCapability not configured. Knowledge store access not available."
    );
  },
};

// ─── Bound Tool ──────────────────────────────────────────────────────────────

export const knowledgeReadBoundTool: BoundTool<
  typeof KNOWLEDGE_READ_NAME,
  KnowledgeReadInput,
  KnowledgeReadOutput,
  KnowledgeReadRedacted
> = {
  contract: knowledgeReadContract,
  implementation: knowledgeReadStubImplementation,
};

/**
 * The same tool without the `node` argument, for a node with no link targets: the argument is advertised to the model only when it can work. The implementation is the same and
 * refuses an alias with no remote capability, so a model that sends `node` anyway (the schema strips it) reads this node's own store.
 */
export const knowledgeReadLocalBoundTool = {
  contract: {
    ...knowledgeReadContract,
    description: KNOWLEDGE_READ_DESCRIPTION.trimEnd(),
    inputSchema: KnowledgeReadLocalInputSchema,
  },
  implementation: knowledgeReadStubImplementation,
} as unknown as typeof knowledgeReadBoundTool;
