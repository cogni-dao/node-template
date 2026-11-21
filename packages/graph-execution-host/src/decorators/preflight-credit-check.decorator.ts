// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/graph-execution-host/decorators/preflight-credit-check`
 * Purpose: Decorator that wraps GraphExecutorPort with pre-execution credit validation.
 * Scope: Checks provider policy and credit balance before starting the inner executor.
 * Invariants:
 *   - CREDITS_ENFORCED_AT_EXECUTION_PORT: all execution paths get credit check automatically
 *   - PREFLIGHT_BEFORE_EXECUTION: credit check completes before the inner executor starts
 *   - POLICY_VIA_PROVIDER: billing policy comes from PlatformCreditChecker, not string matching
 *   - PURE_LIBRARY: no env vars, no process lifecycle
 * Side-effects: IO (via injected checkFn → accountService.getBalance)
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/multi-provider-llm.md
 * @public
 */

import type { AiEvent } from "@cogni/ai-core";
import type {
  ExecutionContext,
  GraphExecutorPort,
  GraphRunRequest,
  GraphRunResult
} from "@cogni/graph-execution-core";

import type { LoggerPort } from "../ports/logger.port";
import type {
  PlatformCreditChecker,
  PreflightCreditCheckFn
} from "../ports/preflight-credit-check";

/**
 * Decorator that wraps GraphExecutorPort with pre-execution credit validation.
 *
 * Runs an injected credit check function before starting the inner executor.
 * If credits are insufficient, throws InsufficientCreditsPortError before
 * any LLM execution occurs.
 *
 * Uses PlatformCreditChecker to determine if the model's provider requires
 * platform credits. BYO providers (codex, ollama) skip the check entirely.
 */
export class PreflightCreditCheckDecorator implements GraphExecutorPort {
  constructor(
    private readonly inner: GraphExecutorPort,
    private readonly checkFn: PreflightCreditCheckFn,
    private readonly billingAccountId: string,
    private readonly checker: PlatformCreditChecker,
    _log: LoggerPort
  ) {}

  runGraph(req: GraphRunRequest, ctx?: ExecutionContext): GraphRunResult {
    const resultPromise = (async () => {
      const provider = this.checker.resolve(req.modelRef.providerKey);
      if (await provider.requiresPlatformCredits(req.modelRef)) {
        await this.checkFn(
          this.billingAccountId,
          req.modelRef.modelId,
          req.messages
        );
      }
      return this.inner.runGraph(req, ctx);
    })();

    const final = resultPromise.then((result) => result.final);
    // Stream-only callers still observe the error through the stream, while
    // final-only callers can await the original rejection normally.
    void final.catch(() => {});

    return {
      stream: this.wrapWithPreflight(resultPromise),
      final
    };
  }

  private async *wrapWithPreflight(
    resultPromise: Promise<GraphRunResult>
  ): AsyncIterable<AiEvent> {
    const result = await resultPromise;
    yield* result.stream;
  }
}
