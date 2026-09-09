// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { fork, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface CheckItem {
  name: string;
  status: "pass" | "fail" | "info";
  message: string;
}

export interface CheckReport {
  ok: boolean;
  checks: CheckItem[];
  tools?: { allowed: string[]; blocked: string[] };
  policy?: {
    sqlGuard: { tools: string[]; mode: string; readOnly: boolean } | null;
    redact: { rules: number; applyTo: string } | null;
    audit: boolean;
    approvalRequired: boolean;
  };
}

export interface CheckOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Run configuration loading, database setup and the MCP handshake in a
 * separate process. The deadline also covers blocked SDKs and synchronous
 * startup work; cancellation kills its process group, including the target.
 */
export async function checkConfig(
  configArgument: string,
  options: CheckOptions = {},
): Promise<CheckReport> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error("--timeout must be an integer between 1 and 2147483647ms");
  }
  const failed = (name: string, message: string, checks: CheckItem[] = []): CheckReport => ({
    ok: false,
    checks: [...checks, { name, status: "fail", message }],
  });
  if (options.signal?.aborted) return failed("cancelled", "Setup check cancelled.");

  const source = import.meta.url.endsWith(".ts");
  const worker = fork(
    fileURLToPath(new URL(source ? "./check-worker.ts" : "./check-worker.js", import.meta.url)),
    [configArgument],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      execArgv: source ? ["--import", import.meta.resolve("tsx")] : [],
    },
  );

  return new Promise<CheckReport>((resolveReport) => {
    let settled = false;
    let checks: CheckItem[] = [];
    let phase = "configuration";
    const finish = async (report: CheckReport): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const cleanupError = await stopWorker(worker);
      if (cleanupError) report = failed("cleanup", cleanupError, report.checks);
      resolveReport(report);
    };
    const onAbort = (): void => {
      void finish(failed("cancelled", `Setup check cancelled during ${phase}.`, checks));
    };
    const timer = setTimeout(() => {
      void finish(
        failed("timeout", `Setup check timed out after ${timeoutMs}ms during ${phase}.`, checks),
      );
    }, timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    worker.on(
      "message",
      (message: { phase?: string; checks?: CheckItem[]; report?: CheckReport }) => {
        if (message.phase) phase = message.phase;
        if (message.checks) checks = message.checks;
        if (message.report) void finish(message.report);
      },
    );
    worker.on("error", (error: NodeJS.ErrnoException) => {
      const code = /^[A-Z_]+$/.test(error.code ?? "") ? ` (${error.code})` : "";
      void finish(failed("worker", `Could not start diagnostic worker${code}.`, checks));
    });
    worker.on("exit", (code, signal) => {
      if (!settled) {
        void finish(
          failed(
            "worker",
            `Diagnostic worker exited during ${phase} (code ${code ?? signal ?? "unknown"}).`,
            checks,
          ),
        );
      }
    });
  });
}

async function stopWorker(worker: ChildProcess): Promise<string | null> {
  if (!worker.pid) return null;
  if (process.platform === "win32") {
    return new Promise((resolveStop) => {
      const killer = spawn("taskkill", ["/PID", String(worker.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      const timer = setTimeout(() => {
        killer.kill();
        resolveStop("taskkill timed out while stopping the diagnostic process tree.");
      }, 1500);
      killer.on("error", () => {
        clearTimeout(timer);
        resolveStop("Could not run taskkill to stop the diagnostic process tree.");
      });
      killer.on("exit", (code) => {
        clearTimeout(timer);
        resolveStop(
          code === 0 || worker.exitCode !== null || worker.signalCode !== null
            ? null
            : "taskkill could not stop the diagnostic process tree.",
        );
      });
    });
  }
  const signalGroup = (signal: NodeJS.Signals): string | null => {
    try {
      process.kill(-worker.pid!, signal);
      return null;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH"
        ? null
        : `Could not send ${signal} to the diagnostic process group.`;
    }
  };
  const termError = signalGroup("SIGTERM");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  return signalGroup("SIGKILL") ?? termError;
}

export function renderCheckReport(report: CheckReport): string {
  const lines = [report.ok ? "Setup check passed." : "Setup check failed."];
  for (const check of report.checks)
    lines.push(`${check.status.toUpperCase()} ${check.name}: ${check.message}`);
  if (report.tools) {
    lines.push(`Allowed tools: ${report.tools.allowed.join(", ") || "(none)"}`);
    lines.push(`Blocked tools: ${report.tools.blocked.join(", ") || "(none)"}`);
  }
  if (report.policy) {
    const { sqlGuard, redact, audit, approvalRequired } = report.policy;
    lines.push(
      sqlGuard
        ? `SQL guard: ${sqlGuard.mode}, readOnly=${sqlGuard.readOnly}, tools=${sqlGuard.tools.join(", ")}`
        : "SQL guard: not configured.",
    );
    lines.push(
      redact
        ? `Redaction: ${redact.rules} rule(s), applyTo=${redact.applyTo}.`
        : "Redaction: not configured.",
    );
    lines.push(
      `Audit: ${audit ? "configured" : "not configured"}; no audit records written by this check.`,
    );
    lines.push(
      `Approval: ${approvalRequired ? "required by configuration" : "not required by configuration"}; approval state was not changed or validated.`,
    );
  }
  lines.push(
    "The checker sends no tools/call requests. Target startup may download packages, write caches, or request authentication.",
  );
  return lines.join("\n") + "\n";
}
