// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/inproc/provider/events`
 * Purpose: The structured-log event names the in-process provider emits.
 * Scope: Names only. A node's event registry repeats these as equal values, and a parity test in the node pins them.
 * Invariants:
 *   - PACKAGE_OWNS_PROVIDER_EVENTS: the provider logs these exact strings; a rename is a breaking change of the package
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/publish-shared-runtime-core
 * @public
 */

export const INPROC_EVENTS = {
  /** A principal lookup or a tool authorization decision (`agent_tool.authz`). */
  AGENT_TOOL_AUTHZ: "agent_tool.authz",
  /** A run ended cleanly because a tool was denied or every write tool was withheld (`agent_run.denied`). */
  AGENT_RUN_DENIED: "agent_run.denied",
  /** A coding run stopped before its first model call (`agent_run.start_denied`). */
  AGENT_RUN_START_DENIED: "agent_run.start_denied",
  /** The shell was withheld from a run that continues (`agent_coding.shell_withheld`). */
  AGENT_CODING_SHELL_WITHHELD: "agent_coding.shell_withheld",
  /** A tool call failed inside a graph run (`ai.tool_call.error`). */
  AI_TOOL_CALL_ERROR: "ai.tool_call.error",
  /** A graph run ended with an error at the provider boundary (`adapter.langgraph_inproc.error`). */
  ADAPTER_LANGGRAPH_INPROC_ERROR: "adapter.langgraph_inproc.error",
} as const satisfies Readonly<Record<string, string>>;
