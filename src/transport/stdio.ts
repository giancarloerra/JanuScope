// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * Stdio transport: spawn the target MCP server as a child process, wire
 * its stdin/stdout to the overlay pipeline, and bridge the client (on our
 * own stdin/stdout) through.
 *
 * This module exposes primitive forwarders; the higher-level `runOverlay`
 * composes these with the Pipeline.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { encodeFrame, FrameDecoder, type JsonRpcMessage } from "../rpc.js";
import type { Pipeline } from "../pipeline.js";

export interface TargetSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export type LogFn = (
  level: "info" | "warn" | "error",
  scope: string,
  message: string,
  extra?: unknown,
) => void;

export interface StdioBridgeOptions {
  target: TargetSpec;
  pipeline: Pipeline;
  clientIn: Readable;
  clientOut: Writable;
  log: LogFn;
}

export interface StdioBridge {
  /** Forward a JSON-RPC message to the target's stdin. */
  forwardToTarget: (msg: JsonRpcMessage) => void;
  /** Forward a JSON-RPC message to the client's stdout. */
  forwardToClient: (msg: JsonRpcMessage) => void;
  /** Resolves when both the target and the client streams have closed. */
  done: Promise<void>;
  /** Trigger graceful shutdown. */
  stop: (reason: string) => Promise<void>;
}

export function startStdioBridge(options: StdioBridgeOptions): StdioBridge {
  const { target, pipeline, clientIn, clientOut, log } = options;

  const child = spawn(target.command, target.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...(target.env ?? {}) },
    ...(target.cwd ? { cwd: target.cwd } : {}),
  }) as ChildProcessWithoutNullStreams;

  let stopped = false;

  const forwardToTarget = (msg: JsonRpcMessage): void => {
    if (child.stdin.destroyed || child.stdin.writableEnded) return;
    try {
      child.stdin.write(encodeFrame(msg));
    } catch (err) {
      log("warn", "transport", "write to target failed", errorInfo(err));
    }
  };

  const forwardToClient = (msg: JsonRpcMessage): void => {
    if (clientOut.destroyed || clientOut.writableEnded) return;
    try {
      clientOut.write(encodeFrame(msg));
    } catch (err) {
      log("warn", "transport", "write to client failed", errorInfo(err));
    }
  };

  // Client → pipeline → target
  const clientDecoder = new FrameDecoder(
    (msg) => {
      void pipeline.handleClientMessage(msg).catch((err) => {
        log("error", "transport", "pipeline.handleClientMessage threw", errorInfo(err));
      });
    },
    (err, raw) => {
      log("warn", "transport", `dropping malformed client frame: ${err.message}`, { raw });
    },
  );
  clientIn.on("data", (chunk: Buffer | string) => clientDecoder.push(chunk));
  clientIn.on("end", () => {
    clientDecoder.flush();
    void stop("client_closed");
  });
  clientIn.on("error", (err: Error) => {
    log("warn", "transport", "client stdin error", errorInfo(err));
  });

  // Target → pipeline → client
  const targetDecoder = new FrameDecoder(
    (msg) => {
      void pipeline.handleServerMessage(msg).catch((err) => {
        log("error", "transport", "pipeline.handleServerMessage threw", errorInfo(err));
      });
    },
    (err, raw) => {
      log("warn", "transport", `dropping malformed target frame: ${err.message}`, { raw });
    },
  );
  child.stdout.on("data", (chunk: Buffer) => targetDecoder.push(chunk));
  child.stdout.on("end", () => {
    targetDecoder.flush();
    void stop("target_stdout_closed");
  });
  child.stdout.on("error", (err: Error) => {
    log("warn", "transport", "target stdout error", errorInfo(err));
  });

  // Forward target stderr to our own stderr so users can see logs from
  // the wrapped server.
  child.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  child.on("exit", (code, signal) => {
    log("info", "transport", `target exited (code=${code ?? "?"} signal=${signal ?? "-"})`);
    void stop("target_exit");
  });
  child.on("error", (err) => {
    log("error", "transport", "failed to spawn target", errorInfo(err));
    void stop("target_spawn_error");
  });

  // Resolve when both sides have terminated.
  let targetExited = false;
  let clientClosed = false;
  let resolveDone: (() => void) | null = null;
  const done = new Promise<void>((resolveFn) => {
    resolveDone = resolveFn;
  });
  const maybeResolve = (): void => {
    if (targetExited && clientClosed && resolveDone) {
      resolveDone();
      resolveDone = null;
    }
  };
  child.on("exit", () => {
    targetExited = true;
    maybeResolve();
  });
  clientIn.on("end", () => {
    clientClosed = true;
    maybeResolve();
  });
  clientIn.on("close", () => {
    clientClosed = true;
    maybeResolve();
  });

  async function stop(reason: string): Promise<void> {
    if (stopped) return;
    stopped = true;
    log("info", "transport", `stopping (reason=${reason})`);
    try {
      await pipeline.stop();
    } catch (err) {
      log("error", "transport", "pipeline.stop threw", errorInfo(err));
    }
    // Close target stdin so the process sees EOF.
    if (!child.stdin.destroyed) {
      try {
        child.stdin.end();
      } catch {
        /* already ended */
      }
    }
    // Escalate in three stages so we can never hang:
    //   t+2s  SIGTERM (graceful)
    //   t+5s  SIGKILL (forceful)
    //   t+10s give up, log, resolve regardless
    // The race below listens for exit / close / error — any of those
    // ends the wait. Critical when spawn() fails synchronously (bad
    // command): Node emits `error` but not always `exit`.
    const sigtermTimer = setTimeout(() => {
      try {
        if (!child.killed) {
          log("warn", "transport", "target did not exit in 2s, sending SIGTERM");
          child.kill("SIGTERM");
        }
      } catch {
        /* process may be gone already */
      }
    }, 2000);
    const sigkillTimer = setTimeout(() => {
      try {
        log("warn", "transport", "target did not exit in 5s, sending SIGKILL");
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 5000);

    const absoluteDeadline = new Promise<void>((resolveP) => setTimeout(resolveP, 10_000));
    const childTerminated = new Promise<void>((resolveP) => {
      let resolved = false;
      const resolveOnce = (): void => {
        if (resolved) return;
        resolved = true;
        resolveP();
      };
      child.once("exit", resolveOnce);
      child.once("close", resolveOnce);
      child.once("error", resolveOnce);
    });
    try {
      await Promise.race([childTerminated, absoluteDeadline]);
    } catch {
      /* both promises wrapped; unreachable */
    } finally {
      clearTimeout(sigtermTimer);
      clearTimeout(sigkillTimer);
    }
    // In the unlikely case neither side fired end/exit, resolve done.
    if (resolveDone) {
      resolveDone();
      resolveDone = null;
    }
  }

  return {
    forwardToTarget,
    forwardToClient,
    done,
    stop,
  };
}

function errorInfo(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    const info: { message: string; stack?: string } = { message: err.message };
    if (err.stack) info.stack = err.stack;
    return info;
  }
  return { message: String(err) };
}
