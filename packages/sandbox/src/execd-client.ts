// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni-dao/sandbox/execd-client`
 * Purpose: Minimal server-only client for the node's remote sandbox (OpenSandbox execd behind Caddy).
 * Scope: Runs one shell command via `POST /command` and folds the streamed events into one bounded result.
 *   Does not manage sessions, files or PTY, and does not know runs, folders or queues (see sandbox-shell.ts).
 * Invariants:
 *   - TOKEN_VIA_CONFIG: the execd access token comes from constructor config, never from call params,
 *     and is sent only as the `X-EXECD-ACCESS-TOKEN` header.
 *   - ONE_MERGED_OUTPUT: stdout and stderr arrive as one stream in arrival order; a long one keeps its head and tail.
 *   - BOUNDED_TIME: the HTTP request aborts `requestGraceMs` after the command's own timeout.
 * Side-effects: IO (HTTPS to the node's sandbox lease)
 * Links: services/sandbox/, https://github.com/opensandbox-group/OpenSandbox/blob/main/specs/execd-api.yaml
 * @internal
 */

export const EXECD_ACCESS_TOKEN_HEADER = "X-EXECD-ACCESS-TOKEN";

/** Output budget in characters: the first and last half are kept, the middle is dropped. */
export const OUTPUT_BUDGET_CHARS = 32 * 1024;
/** execd splits lines over 16 MiB; one event line past this is a broken stream. */
const MAX_EVENT_LINE_CHARS = 20 * 1024 * 1024;

export interface ExecdSandboxClientConfig {
  /** Sandbox origin, e.g. `https://node-template-sandbox-test.cognidao.org`. */
  readonly baseUrl: string;
  /** Shared execd access token (SANDBOX_EXECD_TOKEN). */
  readonly accessToken: string;
  /** Extra wall-clock allowed beyond the command timeout before aborting (default 10s). */
  readonly requestGraceMs?: number;
  /** Injectable fetch for tests. */
  readonly fetchImpl?: typeof fetch;
}

export interface SandboxCommandRequest {
  /** The shell text execd runs. Callers pass fixed text here and user text in `envs`. */
  readonly command: string;
  /** Command timeout enforced by execd (a safety net over the caller's own limit). */
  readonly timeoutMs: number;
  readonly envs?: Readonly<Record<string, string>>;
}

export interface SandboxCommandResult {
  /** 0 on success; the process exit status on failure; -1 when execd reports a non-numeric error. */
  readonly exitCode: number;
  /** stdout and stderr merged in arrival order; head and tail when long. */
  readonly output: string;
  readonly truncated: boolean;
  /** execd error name (e.g. `CommandExecError`) when the command failed. */
  readonly errorName: string | null;
}

export class SandboxRequestError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "SandboxRequestError";
    this.status = status;
  }
}

const DEFAULT_REQUEST_GRACE_MS = 10_000;

interface ExecdStreamEvent {
  type?: string;
  text?: string;
  error?: { ename?: string; evalue?: string };
}

/** Keeps the first and last half of what is pushed, whatever its total size. */
class HeadTailBuffer {
  private head = "";
  private tail = "";
  private total = 0;
  constructor(private readonly half: number) {}

  push(text: string): void {
    this.total += text.length;
    const room = this.half - this.head.length;
    let rest = text;
    if (room > 0) {
      this.head += text.slice(0, room);
      rest = text.slice(room);
    }
    if (rest) this.tail = (this.tail + rest).slice(-this.half);
  }

  result(): { output: string; truncated: boolean } {
    const omitted = this.total - this.head.length - this.tail.length;
    if (omitted <= 0) return { output: this.head + this.tail, truncated: false };
    return {
      output: `${this.head}\n[... ${omitted} characters omitted ...]\n${this.tail}`,
      truncated: true,
    };
  }
}

export class ExecdSandboxClient {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly requestGraceMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ExecdSandboxClientConfig) {
    if (!config.accessToken) {
      throw new Error("ExecdSandboxClient requires an access token");
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.accessToken = config.accessToken;
    this.requestGraceMs = config.requestGraceMs ?? DEFAULT_REQUEST_GRACE_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** Run one shell command to completion and return its merged, bounded output. */
  async runCommand(
    request: SandboxCommandRequest
  ): Promise<SandboxCommandResult> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      request.timeoutMs + this.requestGraceMs
    );

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/command`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          [EXECD_ACCESS_TOKEN_HEADER]: this.accessToken,
        },
        body: JSON.stringify({
          command: request.command,
          background: false,
          timeout: request.timeoutMs,
          ...(request.envs !== undefined && { envs: request.envs }),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Never echo the body: it may reflect request headers.
        throw new SandboxRequestError(
          `sandbox /command failed with HTTP ${response.status}`,
          response.status
        );
      }
      if (!response.body) {
        throw new SandboxRequestError("sandbox /command returned no body", null);
      }
      return await this.collect(response.body);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new SandboxRequestError(
          `sandbox /command exceeded ${request.timeoutMs + this.requestGraceMs}ms`,
          null
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async collect(
    body: ReadableStream<Uint8Array>
  ): Promise<SandboxCommandResult> {
    const buffer = new HeadTailBuffer(OUTPUT_BUDGET_CHARS / 2);
    let wrote = false;
    let exitCode: number | null = null;
    let errorName: string | null = null;
    let completed = false;

    const handle = (event: ExecdStreamEvent) => {
      switch (event.type) {
        case "stdout":
        case "stderr":
          buffer.push(wrote ? `\n${event.text ?? ""}` : (event.text ?? ""));
          wrote = true;
          break;
        case "error": {
          errorName = event.error?.ename ?? "Error";
          const parsed = Number.parseInt(event.error?.evalue ?? "", 10);
          exitCode = Number.isInteger(parsed) ? parsed : -1;
          completed = true;
          break;
        }
        case "execution_complete":
          completed = true;
          break;
        default:
          break;
      }
    };

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        pending += done
          ? decoder.decode()
          : decoder.decode(value, { stream: true });
        const lines = pending.split("\n");
        pending = done ? "" : (lines.pop() ?? "");
        if (pending.length > MAX_EVENT_LINE_CHARS) {
          throw new SandboxRequestError("sandbox event line is too long", null);
        }
        for (const raw of lines) {
          const event = parseEventLine(raw);
          if (event) handle(event);
        }
        if (done) break;
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    if (!completed) {
      throw new SandboxRequestError(
        "sandbox /command stream ended before completion",
        null
      );
    }
    return { exitCode: exitCode ?? 0, errorName, ...buffer.result() };
  }
}

/** execd streams one JSON object per line; tolerate an SSE `data:` prefix. */
function parseEventLine(raw: string): ExecdStreamEvent | null {
  let line = raw.trim();
  if (line.startsWith("data:")) line = line.slice(5).trim();
  if (!line.startsWith("{")) return null;
  try {
    return JSON.parse(line) as ExecdStreamEvent;
  } catch {
    return null;
  }
}
