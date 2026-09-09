// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * Spawn a target MCP, drive the standard MCP handshake
 * (`initialize` → `notifications/initialized` → `tools/list`), capture
 * the resulting tool surface, and shut the target down.
 *
 * Used by:
 *   - The `januscope approve` CLI subcommand, to capture the live
 *     tools fingerprint at the moment of approval (so the operator
 *     gets a single atomic re-baseline of both static and live
 *     layers, rather than waiting for the next actual run to TOFU
 *     the live layer).
 *   - The bench / validate-lenses tooling indirectly relies on the
 *     same handshake shape; we kept their inline implementation
 *     because it has a different result type, but the wire-level
 *     sequencing here mirrors theirs so any timing fix lands in
 *     both.
 *
 * The handshake order matters: send `initialize` and ONLY after the
 * init response arrives, send `notifications/initialized` followed by
 * `tools/list`. Slower remote MCPs (mcp-remote bridges to Atlassian /
 * Notion / Linear) drop the second/third request when fired together.
 */

import { spawn } from "node:child_process";
import type { OverlayConfig } from "./config.js";
import type { LiveTool } from "./quarantine.js";

export interface ProbeOptions {
  /**
   * Per-probe timeout in milliseconds. Covers spawn → init →
   * tools/list end-to-end. Defaults to 90s, which is what
   * validate-lenses uses; long enough for `mcp-remote` to set up
   * OAuth and HTTPS, short enough to fail visibly when something
   * else is wrong.
   */
  timeoutMs?: number;
  /** Setup diagnostics require valid envelopes and a complete paginated list.
   * Omitted by existing approval/library callers to preserve their contract. */
  verifyProtocol?: boolean;
}

export interface ProbeResult {
  tools: LiveTool[];
  serverInfo: { name: string; version: string };
}

const MIN_PROBE_TIMEOUT_MS = 15_000;

export async function probeTarget(
  config: OverlayConfig,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  if (timeoutMs < MIN_PROBE_TIMEOUT_MS) {
    throw new Error(
      `probeTarget: timeoutMs must be >= ${MIN_PROBE_TIMEOUT_MS}ms (uvx + mcp-remote startups can take 10-12s)`,
    );
  }

  const target = config.target;
  const env = { ...process.env, ...(target.env ?? {}) };
  const child = spawn(target.command, target.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
    ...(target.cwd ? { cwd: target.cwd } : {}),
  });

  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail += chunk.toString("utf8");
    // Keep only the last few KB; some MCPs are chatty on stderr.
    if (stderrTail.length > 4096) stderrTail = stderrTail.slice(-4096);
  });

  return new Promise<ProbeResult>((resolve, reject) => {
    let resolved = false;
    let stdoutBuf = "";
    let initResponded = false;
    let serverInfo: ProbeResult["serverInfo"] = { name: "?", version: "?" };
    let toolsRequestId = 2;
    const collectedTools: LiveTool[] = [];
    const seenCursors = new Set<string>();
    const seenToolNames = new Set<string>();

    const cleanup = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      // SIGKILL backstop in case SIGTERM is ignored (rare for stdio MCPs,
      // but mcp-remote occasionally hangs in OAuth-callback states).
      const sigkillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 1500);
      sigkillTimer.unref();
    };

    const succeed = (result: ProbeResult): void => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(result);
    };

    const fail = (err: Error): void => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(err);
    };

    const protocolFailure = (
      message: string,
      code: number | string = "INVALID_MCP_RESPONSE",
    ): void => {
      clearTimeout(timer);
      fail(Object.assign(new Error(message), { code }));
    };

    const timer = setTimeout(() => {
      fail(
        new Error(
          `probe timed out after ${timeoutMs}ms (no tools/list response from target).` +
            (stderrTail.trim().length > 0 ? `\nstderr tail:\n${stderrTail.trim()}` : ""),
        ),
      );
    }, timeoutMs);
    timer.unref();

    child.on("error", (err) => {
      clearTimeout(timer);
      fail(new Error(`probe spawn failed: ${err.message}`, { cause: err }));
    });

    child.stdin?.on("error", (err: Error) => {
      clearTimeout(timer);
      fail(new Error("target input stream failed", { cause: err }));
    });
    child.stdout?.on("error", (err: Error) => {
      clearTimeout(timer);
      fail(new Error("target output stream failed", { cause: err }));
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!resolved) {
        fail(
          new Error(
            `target exited (code=${code ?? "?"}) before completing tools/list.` +
              (stderrTail.trim().length > 0 ? `\nstderr tail:\n${stderrTail.trim()}` : ""),
          ),
        );
      }
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines[lines.length - 1] ?? "";
      for (const line of lines.slice(0, -1)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg: {
          jsonrpc?: string;
          id?: number;
          result?: unknown;
          error?: { code: number; message: string };
        };
        try {
          msg = JSON.parse(trimmed) as typeof msg;
        } catch {
          if (options.verifyProtocol) {
            protocolFailure("target emitted invalid JSON");
            return;
          }
          continue;
        }
        if (options.verifyProtocol && (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0")) {
          protocolFailure("target emitted an invalid JSON-RPC envelope");
          return;
        }
        if (
          options.verifyProtocol &&
          ((msg.id === 1 && !initResponded) || msg.id === toolsRequestId) &&
          "result" in msg === "error" in msg
        ) {
          protocolFailure("target response must contain exactly one result or error");
          return;
        }
        if (
          options.verifyProtocol &&
          msg.error &&
          (typeof msg.error !== "object" ||
            !Number.isInteger(msg.error.code) ||
            typeof msg.error.message !== "string")
        ) {
          protocolFailure("target response contains an invalid error envelope");
          return;
        }
        if (msg.id === 1 && !initResponded) {
          initResponded = true;
          if (msg.error) {
            clearTimeout(timer);
            if (options.verifyProtocol) protocolFailure("initialize failed", msg.error.code);
            else fail(new Error(`initialize failed: ${msg.error.code} ${msg.error.message}`));
            return;
          }
          if (options.verifyProtocol) {
            const result = msg.result as {
              protocolVersion?: unknown;
              capabilities?: unknown;
              serverInfo?: { name?: unknown; version?: unknown };
            } | null;
            if (
              !result ||
              typeof result.protocolVersion !== "string" ||
              !result.capabilities ||
              typeof result.capabilities !== "object" ||
              Array.isArray(result.capabilities) ||
              typeof result.serverInfo?.name !== "string" ||
              typeof result.serverInfo.version !== "string"
            ) {
              protocolFailure(
                "initialize response is missing protocolVersion, capabilities or serverInfo",
              );
              return;
            }
          }
          const si = (msg.result as { serverInfo?: { name?: string; version?: string } })
            ?.serverInfo;
          if (si && typeof si.name === "string") {
            serverInfo = {
              name: si.name,
              version: typeof si.version === "string" ? si.version : "?",
            };
          }
          // notifications/initialized → tools/list AFTER init response.
          try {
            child.stdin?.write(
              JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
            );
            child.stdin?.write(
              JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n",
            );
          } catch (err) {
            clearTimeout(timer);
            fail(new Error(`failed to send tools/list: ${(err as Error).message}`, { cause: err }));
            return;
          }
          continue;
        }
        if (msg.id === toolsRequestId) {
          if (options.verifyProtocol && !initResponded) {
            protocolFailure("tools/list response arrived before initialize completed");
            return;
          }
          if (msg.error) {
            clearTimeout(timer);
            if (options.verifyProtocol) protocolFailure("tools/list failed", msg.error.code);
            else fail(new Error(`tools/list failed: ${msg.error.code} ${msg.error.message}`));
            return;
          }
          const tools = (msg.result as { tools?: unknown })?.tools;
          if (!Array.isArray(tools)) {
            clearTimeout(timer);
            fail(new Error("tools/list response had no `tools` array"));
            return;
          }
          if (options.verifyProtocol) {
            if (!tools.every(isDiagnosticTool)) {
              protocolFailure("tools/list contains an invalid tool name or inputSchema");
              return;
            }
            for (const tool of tools as LiveTool[]) {
              if (seenToolNames.has(tool.name)) {
                protocolFailure("tools/list contains duplicate tool names");
                return;
              }
              seenToolNames.add(tool.name);
            }
            collectedTools.push(...(tools as LiveTool[]));
            const cursor = (msg.result as { nextCursor?: unknown }).nextCursor;
            if (cursor !== undefined) {
              if (typeof cursor !== "string" || seenCursors.has(cursor)) {
                protocolFailure("tools/list returned an invalid or repeated pagination cursor");
                return;
              }
              seenCursors.add(cursor);
              toolsRequestId++;
              try {
                child.stdin?.write(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: toolsRequestId,
                    method: "tools/list",
                    params: { cursor },
                  }) + "\n",
                );
              } catch (err) {
                clearTimeout(timer);
                fail(new Error("failed to send paginated tools/list", { cause: err }));
                return;
              }
              continue;
            }
          }
          clearTimeout(timer);
          succeed({
            tools: options.verifyProtocol ? collectedTools : (tools as LiveTool[]),
            serverInfo,
          });
          return;
        }
      }
    });

    // Send `initialize` immediately. The buffered write doesn't reach
    // the target until it starts reading from stdin, but Node holds the
    // bytes for us. validate-lenses inserts a 12s startup delay because
    // it batches all three messages together; we don't (we wait for the
    // init response before sending the rest), so we can fire init on
    // tick 0 and let the timeout cover slow starts.
    try {
      child.stdin?.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "januscope-probe", version: "0" },
          },
        }) + "\n",
      );
    } catch (err) {
      clearTimeout(timer);
      fail(new Error(`failed to send initialize: ${(err as Error).message}`, { cause: err }));
    }
  });
}

/** Validate the MCP Tool input-schema envelope, preserving additional JSON
 * Schema keywords and boolean property schemas used by newer revisions. */
function isDiagnosticTool(value: unknown): boolean {
  const record = (node: unknown): node is Record<string, unknown> =>
    node !== null && typeof node === "object" && !Array.isArray(node);
  if (!record(value) || typeof value.name !== "string" || value.name.length === 0) return false;
  const schema = value.inputSchema;
  if (!record(schema) || schema.type !== "object") return false;
  if (
    schema.properties !== undefined &&
    (!record(schema.properties) ||
      !Object.values(schema.properties).every(
        (property) => typeof property === "boolean" || record(property),
      ))
  )
    return false;
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      !schema.required.every((name: unknown) => typeof name === "string"))
  )
    return false;
  return true;
}
