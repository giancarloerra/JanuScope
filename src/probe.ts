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
      fail(new Error(`probe spawn failed: ${err.message}`));
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
        let msg: { id?: number; result?: unknown; error?: { code: number; message: string } };
        try {
          msg = JSON.parse(trimmed) as typeof msg;
        } catch {
          continue;
        }
        if (msg.id === 1 && !initResponded) {
          initResponded = true;
          if (msg.error) {
            clearTimeout(timer);
            fail(new Error(`initialize failed: ${msg.error.code} ${msg.error.message}`));
            return;
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
            fail(new Error(`failed to send tools/list: ${(err as Error).message}`));
          }
          continue;
        }
        if (msg.id === 2) {
          clearTimeout(timer);
          if (msg.error) {
            fail(new Error(`tools/list failed: ${msg.error.code} ${msg.error.message}`));
            return;
          }
          const tools = (msg.result as { tools?: unknown })?.tools;
          if (!Array.isArray(tools)) {
            fail(new Error("tools/list response had no `tools` array"));
            return;
          }
          succeed({ tools: tools as LiveTool[], serverInfo });
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
      fail(new Error(`failed to send initialize: ${(err as Error).message}`));
    }
  });
}
