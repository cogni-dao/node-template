// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/tavily-web-search.adapter`
 * Purpose: Tavily API adapter implementing WebSearchCapability.
 * Scope: HTTP transport to Tavily search API. Does NOT define tool contracts.
 * Invariants:
 *   - AUTH_VIA_ADAPTER: API key resolved from config, never from context
 *   - STRUCTURED_RESULTS: Returns typed WebSearchResult
 *   - BOUNDED_RESPONSE: 1 MiB transport; five results and bounded serialized passages
 * Side-effects: IO (HTTP requests to api.tavily.com)
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/tool-use.md
 * @internal
 */

import {
  projectWebSearchResponse,
  type WebSearchCapability,
  type WebSearchParams,
  type WebSearchResult,
} from "@cogni/ai-tools";

import { EVENT_NAMES, makeLogger } from "@/shared/observability";

const logger = makeLogger({ component: "TavilyWebSearchAdapter" });

/**
 * Configuration for TavilyWebSearchAdapter.
 */
export interface TavilyWebSearchConfig {
  /** Tavily API key */
  apiKey: string;
  /** Request timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
}

/**
 * Tavily API adapter implementing WebSearchCapability.
 *
 * Per AUTH_VIA_ADAPTER: API key is resolved from config at construction,
 * never passed in search parameters.
 */
export class TavilyWebSearchAdapter implements WebSearchCapability {
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: TavilyWebSearchConfig) {
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 10000;
  }

  /**
   * Execute a web search via Tavily API.
   *
   * Per HARD_CAPS_ENFORCED_AT_TOOL_BOUNDARY:
   * - maxResults capped at 5 (model request is a hint, not authority)
   * - raw content is requested only when explicitly selected
   * - title truncated to 120 chars
   * - content truncated to 160 chars
   */
  async search(params: WebSearchParams): Promise<WebSearchResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    // Hard cap: max 5 results regardless of what caller requests
    const maxResults = Math.min(params.maxResults ?? 5, 5);

    try {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          api_key: this.apiKey,
          query: params.query,
          max_results: maxResults,
          topic: params.topic ?? "general",
          // Snippet-only remains the default.
          include_raw_content: params.includeRawContent === true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        controller.abort();
        logger.error(
          {
            event: EVENT_NAMES.ADAPTER_TAVILY_ERROR,
            dep: "tavily",
            reasonCode: "http_error",
            status: response.status,
          },
          EVENT_NAMES.ADAPTER_TAVILY_ERROR
        );
        throw new Error("web_search_http_error");
      }

      if (!response.body) throw new Error("web_search_invalid_response");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 1_048_576) {
          controller.abort();
          throw new Error("web_search_response_too_large");
        }
        chunks.push(part.value);
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let data: unknown;
      try {
        data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      } catch {
        throw new Error("web_search_invalid_response");
      }
      return projectWebSearchResponse(data, params.query, params.includeRawContent === true, maxResults);
    } catch (error) {
      // Log network-level errors (timeout, DNS, connection refused, etc.)
      if (error instanceof Error && error.name === "AbortError") {
        logger.error(
          {
            event: EVENT_NAMES.ADAPTER_TAVILY_ERROR,
            dep: "tavily",
            reasonCode: "timeout",
            durationMs: this.timeoutMs,
          },
          EVENT_NAMES.ADAPTER_TAVILY_ERROR
        );
      } else if (
        error instanceof Error &&
        error.message === "web_search_http_error"
      ) {
        // Already logged above, just re-throw
      } else {
        const reasonCode =
          error instanceof Error && error.message === "fetch failed"
            ? "network_error"
            : "unknown_error";
        logger.error(
          {
            event: EVENT_NAMES.ADAPTER_TAVILY_ERROR,
            dep: "tavily",
            reasonCode,
          },
          EVENT_NAMES.ADAPTER_TAVILY_ERROR
        );
      }
      if (error instanceof Error && error.message.startsWith("web_search_")) throw error;
      throw new Error(error instanceof Error && error.name === "AbortError" ? "web_search_timeout" : "web_search_unavailable");
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
