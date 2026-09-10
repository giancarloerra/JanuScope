// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code) ? code : "unknown error";
}

/** Stop the diagnostic worker and its descendants when their supervisor is lost. */
export function stopDiagnosticProcessTree(): never {
  // checkConfig forks the worker as a dedicated POSIX process-group leader.
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(process.pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 1500,
    });
    if (result.error || result.status !== 0) {
      const detail = result.error
        ? errorCode(result.error)
        : `taskkill exit ${result.status ?? result.signal ?? "unknown"}`;
      writeSync(2, `Could not terminate the diagnostic process tree (${detail}).\n`);
    }
  } else if (process.pid > 1) {
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch (error) {
      writeSync(2, `Could not terminate the diagnostic process group (${errorCode(error)}).\n`);
    }
  }
  // process.exit would stop only the watchdog thread when called from there.
  process.kill(process.pid, "SIGKILL");
  process.exit(1);
}

/** Start an independent parent-liveness check before diagnostic work can block. */
export async function startSupervisorWatchdog(): Promise<void> {
  const source = import.meta.url.endsWith(".ts");
  const watcher = source
    ? new Worker(`require(${JSON.stringify(fileURLToPath(import.meta.url))});`, {
        eval: true,
        execArgv: ["--require", createRequire(import.meta.url).resolve("tsx/cjs")],
        workerData: process.ppid,
      })
    : new Worker(new URL(import.meta.url), { execArgv: [], workerData: process.ppid });
  await new Promise<void>((resolveReady, reject) => {
    let ready = false;
    const failed = (error: unknown): void => {
      if (!ready) reject(error);
      else {
        writeSync(2, `Diagnostic supervisor watchdog failed (${errorCode(error)}).\n`);
        stopDiagnosticProcessTree();
      }
    };
    watcher.once("message", () => {
      ready = true;
      resolveReady();
    });
    watcher.once("error", failed);
    watcher.once("exit", (code) =>
      failed(
        Object.assign(new Error("Diagnostic watchdog exited."), { code: `WATCHDOG_EXIT_${code}` }),
      ),
    );
  });
  watcher.unref();
}

if (!isMainThread) {
  const supervisorPid: unknown = workerData;
  if (
    typeof supervisorPid !== "number" ||
    !Number.isSafeInteger(supervisorPid) ||
    supervisorPid < 1
  ) {
    throw new Error("Invalid diagnostic supervisor PID");
  }
  const checkParent = (): void => {
    if (process.ppid !== supervisorPid) stopDiagnosticProcessTree();
    try {
      // Signal 0 tests parent liveness on Windows as well as POSIX.
      process.kill(supervisorPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        writeSync(2, `Could not verify diagnostic supervisor liveness (${errorCode(error)}).\n`);
      }
      stopDiagnosticProcessTree();
    }
  };
  checkParent();
  setInterval(checkParent, 100);
  parentPort!.postMessage("ready");
}
