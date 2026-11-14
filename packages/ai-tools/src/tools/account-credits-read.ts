// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tools/account-credits-read`
 * Purpose: AI tool that reads the credit balance of the account the run acts on. The tool twin of `GET /api/v1/accounts/{accountId}/credits`
 *   (SAME_DOOR): the same `account:read` scope, the same grant, the same denial.
 * Scope: Read-only. It is the one read tool that declares `requires`, because its authority is an owner's grant on an account (kind `account`),
 *   not the graph lock alone.
 * Invariants:
 *   - TOOL_ID_NAMESPACED: ID is `core__account_credits_read`
 *   - EFFECT_TYPED: effect is `read_only`
 *   - ACCOUNT_KIND_REQUIRES: `requires.kind` is `account`; the guard offers and runs the tool only for a principal with a live account row for the run's account.
 *   - NO_ACCOUNT_ARGUMENT: the input is empty; the account comes from the run.
 * Side-effects: IO (reads one account via the capability)
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

import { z } from "zod";

import type { AccountCreditsCapability } from "../capabilities/account-credits";
import type { BoundTool, ToolContract, ToolImplementation } from "../types";

export const AccountCreditsReadInputSchema = z.object({}).strict();
export type AccountCreditsReadInput = z.infer<typeof AccountCreditsReadInputSchema>;

export const AccountCreditsReadOutputSchema = z.object({
  billingAccountId: z.string(),
  balanceCredits: z.number(),
});
export type AccountCreditsReadOutput = z.infer<typeof AccountCreditsReadOutputSchema>;
export type AccountCreditsReadRedacted = AccountCreditsReadOutput;

export const ACCOUNT_CREDITS_READ_NAME = "core__account_credits_read" as const;

export const accountCreditsReadContract: ToolContract<
  typeof ACCOUNT_CREDITS_READ_NAME,
  AccountCreditsReadInput,
  AccountCreditsReadOutput,
  AccountCreditsReadRedacted
> = {
  name: ACCOUNT_CREDITS_READ_NAME,
  description:
    "Read the credit balance of the account this run acts on. It works only after the account owner has turned this permission On for you; " +
    "otherwise it is not offered. Takes no input.",
  effect: "read_only",
  requires: {
    scope: "account:read",
    kind: "account",
    subject: "member",
    label: "Read your credit balance",
    description: "See the credit balance of the account it acts for.",
  },
  inputSchema: AccountCreditsReadInputSchema,
  outputSchema: AccountCreditsReadOutputSchema,
  redact: (output) => output,
  allowlist: ["billingAccountId", "balanceCredits"] as const,
};

export interface AccountCreditsReadDeps {
  readonly accountCreditsCapability: AccountCreditsCapability;
}

export function createAccountCreditsReadImplementation(
  deps: AccountCreditsReadDeps
): ToolImplementation<AccountCreditsReadInput, AccountCreditsReadOutput> {
  return {
    execute: async (): Promise<AccountCreditsReadOutput> => {
      const info = await deps.accountCreditsCapability.read();
      // A non-disclosing miss: the same answer for "no grant", "ended grant" and "no such account".
      if (!info) throw new Error("account_not_found");
      return { billingAccountId: info.billingAccountId, balanceCredits: info.balanceCredits };
    },
  };
}

export const accountCreditsReadStubImplementation: ToolImplementation<
  AccountCreditsReadInput,
  AccountCreditsReadOutput
> = {
  execute: async (): Promise<AccountCreditsReadOutput> => {
    throw new Error("AccountCreditsCapability not configured.");
  },
};

export const accountCreditsReadBoundTool: BoundTool<
  typeof ACCOUNT_CREDITS_READ_NAME,
  AccountCreditsReadInput,
  AccountCreditsReadOutput,
  AccountCreditsReadRedacted
> = {
  contract: accountCreditsReadContract,
  implementation: accountCreditsReadStubImplementation,
};
