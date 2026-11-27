// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/payments.intent.v1.contract`
 * Purpose: Contract for creating payment intents via HTTP API.
 * Scope: Defines request/response schemas for POST /api/v1/payments/intents; does not perform persistence or authentication.
 * Invariants: amountUsdCents must be between MIN_PAYMENT_CENTS and MAX_PAYMENT_CENTS; all outputs include on-chain transfer parameters.
 * Side-effects: none
 * Notes: From address derived from the session. The account is the caller's own unless `billingAccountId` names an org account the caller administers (identity decides).
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/payments-design.md
 * @public
 */

import { MAX_PAYMENT_CENTS, MIN_PAYMENT_CENTS } from "@cogni/node-core";
import { z } from "zod";

export const paymentIntentOperation = {
  id: "payments.intent.v1",
  summary: "Create payment intent",
  description:
    "Creates a payment intent with on-chain USDC transfer parameters for the authenticated user's wallet",
  input: z.object({
    amountUsdCents: z
      .number()
      .int()
      .min(
        MIN_PAYMENT_CENTS,
        `Minimum payment is $${MIN_PAYMENT_CENTS / 100} (${MIN_PAYMENT_CENTS} cents)`
      )
      .max(
        MAX_PAYMENT_CENTS,
        `Maximum payment is $${MAX_PAYMENT_CENTS / 100} (${MAX_PAYMENT_CENTS} cents)`
      ),
    /** An org account to fund instead of the caller's own; identity decides (org:admin only). */
    billingAccountId: z.string().min(1).max(128).optional(),
  }),
  output: z.object({
    attemptId: z.string().uuid(),
    chainId: z.number().int(),
    token: z.string(),
    to: z.string(),
    amountRaw: z.string(), // bigint as string for JSON serialization
    amountUsdCents: z.number().int(),
    expiresAt: z.string().datetime(),
  }),
} as const;

export type PaymentIntentInput = z.infer<typeof paymentIntentOperation.input>;
export type PaymentIntentOutput = z.infer<typeof paymentIntentOperation.output>;
