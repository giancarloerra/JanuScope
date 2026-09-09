import { expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sourceRequire = nodeModule.createRequire(import.meta.url);
const loader = pathToFileURL(sourceRequire.resolve("tsx")).href;
const loaderArgs =
  typeof nodeModule.register === "function"
    ? ["--import", loader]
    : ["--require", sourceRequire.resolve("tsx/cjs"), "--loader", loader];
const SOURCE = pathToFileURL(resolve("src/index.ts")).href;
const CLI = resolve("src/cli.ts");
const FAILURE = "synthetic-runtime-failure";

type HostPolicy = "exception" | "rejection" | "capture";
interface LaunchOptions {
  cli?: boolean;
  rejectionMode?: "strict" | "warn" | "none";
  hostPolicy?: HostPolicy;
  stubbornTarget?: boolean;
  throwingLogger?: boolean;
  throwingExitHandler?: boolean;
  sessions?: number;
  concurrent?: boolean;
}

async function waitUntil(check: () => boolean, label: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

function targetRunning(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid fixture target PID");
  if (process.platform === "win32") {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  }
  const status = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  if (status.error || ![0, 1].includes(status.status ?? -1) || status.stderr.trim()) {
    throw new Error("Unable to inspect fixture target process", { cause: status.error });
  }
  return status.stdout.trim() !== "" && !status.stdout.trim().startsWith("Z");
}

async function expectTargetsStopped(targets: Set<number>, label: string): Promise<void> {
  for (const pid of targets) {
    await waitUntil(() => !targetRunning(pid), label);
    // Once termination is verified, never signal this historical PID again.
    targets.delete(pid);
  }
}

async function launch(options: LaunchOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "januscope-runtime-fatal-"));
  const target = join(directory, "target.cjs");
  const preload = join(directory, "preload.mjs");
  const caller = join(directory, "caller.mjs");
  const configFile = join(directory, "config.json");
  writeFileSync(
    target,
    `const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
input.on("line", line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [], pid: process.pid } }) + "\\n");
});
${options.stubbornTarget ? 'setInterval(() => {}, 1000); process.on("SIGTERM", () => {});' : ""}
`,
  );
  writeFileSync(
    preload,
    `import { closeSync } from "node:fs";
const policy = ${JSON.stringify(options.hostPolicy)};
if (${options.throwingExitHandler ?? false}) process.on("exit", () => { throw new Error("synthetic-host-exit-failure"); });
if (policy === "exception") process.on("uncaughtException", () => process.send({ type: "handled" }));
if (policy === "rejection") process.on("unhandledRejection", () => process.send({ type: "handled" }));
if (policy === "capture") process.setUncaughtExceptionCaptureCallback(() => process.send({ type: "handled" }));
process.on("message", message => {
  if (message.type !== "fail") return;
  if (message.closeStderr) closeSync(process.stderr.fd);
  setImmediate(() => {
    if (message.kind === "rejection") Promise.reject(new Error(${JSON.stringify(FAILURE)}));
    else throw new Error(${JSON.stringify(FAILURE)});
  });
  setTimeout(() => process.send({ type: "survived" }), 30);
});
`,
  );
  const config = { target: { command: process.execPath, args: [target] } };
  writeFileSync(configFile, JSON.stringify(config));
  writeFileSync(
    caller,
    `import { runOverlay } from ${JSON.stringify(SOURCE)};
import { PassThrough } from "node:stream";
const eventNames = ["SIGINT", "SIGTERM", "unhandledRejection", "uncaughtException", "uncaughtExceptionMonitor", "exit"];
const before = eventNames.map(name => process.rawListeners(name));
const listenersPreserved = () => eventNames.every((name, index) => {
  const current = process.rawListeners(name);
  return current.length === before[index].length && current.every((value, position) => value === before[index][position]);
});
const pending = [];
for (let round = 0; round < ${options.sessions ?? 1}; round++) {
  const run = async () => {
  const clientIn = new PassThrough({ autoDestroy: false });
  const clientOut = new PassThrough({ autoDestroy: false });
  process.stdin.pipe(clientIn, { end: false });
  clientOut.on("data", chunk => process.stdout.write(chunk));
  const close = message => { if (message.type === "close" && (message.round === undefined || message.round === round)) clientIn.end(); };
  process.on("message", close);
  await runOverlay({ config: ${JSON.stringify(config)}, clientIn, clientOut${options.throwingLogger ? ', log: (level) => { if (level === "error") throw new Error("synthetic-logger-failure"); }' : ""} });
  process.stdin.unpipe(clientIn);
  process.off("message", close);
  process.send({ type: "returned", round, listenersPreserved: listenersPreserved(), outputEnded: clientOut.writableEnded, outputDestroyed: clientOut.destroyed, inputDestroyed: clientIn.destroyed });
  };
  if (${options.concurrent ?? false}) pending.push(run());
  else await run();
}
await Promise.all(pending);
// The embedding host, rather than runOverlay, owns the process lifetime.
process.on("message", message => { if (message.type === "host-exit") process.exit(0); });
process.send({ type: "host-alive", listenersPreserved: listenersPreserved() });
`,
  );
  const args = [
    ...loaderArgs,
    ...(options.rejectionMode ? [`--unhandled-rejections=${options.rejectionMode}`] : []),
    "--import",
    pathToFileURL(preload).href,
    ...(options.cli ? [CLI, "--config", configFile] : [caller]),
  ];
  const child = spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      HOME: directory,
      USERPROFILE: directory,
      NODE_OPTIONS: "",
      JANUSCOPE_QUIET: "1",
    },
  });
  const messages: Array<Record<string, unknown>> = [];
  const responses: Array<{ id: number; result: { pid: number } }> = [];
  const targets = new Set<number>();
  let stderr = "";
  let stdout = "";
  let closed = false;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.on("message", (message) => messages.push(message as Record<string, unknown>));
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    let newline: number;
    while ((newline = stdout.indexOf("\n")) >= 0) {
      const response = JSON.parse(stdout.slice(0, newline)) as {
        id: number;
        result: { pid: number };
      };
      stdout = stdout.slice(newline + 1);
      responses.push(response);
      if (!Number.isSafeInteger(response.result.pid) || response.result.pid <= 1)
        throw new Error("Invalid target PID");
      targets.add(response.result.pid);
    }
  });
  child.on("error", (error) => {
    stderr += `spawn failure: ${error.message}`;
  });
  child.on("exit", (code, signal) => {
    exit = { code, signal };
  });
  child.on("close", () => {
    closed = true;
  });
  let requestId = 0;
  return {
    child,
    messages,
    targets,
    get stderr() {
      return stderr;
    },
    get exit() {
      return exit;
    },
    get closed() {
      return closed;
    },
    async request(expectedResponses = 1) {
      const id = ++requestId;
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" }) + "\n");
      await waitUntil(
        () => responses.filter((response) => response.id === id).length === expectedResponses,
        `target response (${stderr})`,
      );
    },
    async cleanup() {
      if (!closed) {
        child.kill("SIGKILL");
        await waitUntil(() => closed, "fixture host exit");
      }
      for (const pid of targets) {
        if (targetRunning(pid)) process.kill(pid, "SIGKILL");
        await waitUntil(() => !targetRunning(pid), "fixture target exit");
        targets.delete(pid);
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function fail(child: ChildProcess, kind: "exception" | "rejection", closeStderr = false): void {
  child.send!({ type: "fail", kind, closeStderr });
}

it.each([
  { kind: "exception" as const },
  { kind: "rejection" as const },
  { kind: "rejection" as const, rejectionMode: "strict" as const },
  { kind: "exception" as const, cli: true },
  { kind: "rejection" as const, cli: true },
  { kind: "exception" as const, throwingLogger: true },
  { kind: "exception" as const, closeStderr: true },
  { kind: "exception" as const, sessions: 2, concurrent: true },
  { kind: "exception" as const, throwingExitHandler: true },
  { kind: "exception" as const, throwingExitHandler: true, sessions: 2, concurrent: true },
])("terminates a fatal $kind without leaving the wrapped target alive (%j)", async (variant) => {
  const fixture = await launch({ ...variant, stubbornTarget: true });
  try {
    await fixture.request("sessions" in variant ? variant.sessions : 1);
    fail(fixture.child, variant.kind, "closeStderr" in variant);
    await waitUntil(() => fixture.closed, "fatal host exit");
    expect(fixture.exit).toEqual({ code: 1, signal: null });
    expect(fixture.messages.some((message) => message.type === "survived")).toBe(false);
    if (!("closeStderr" in variant)) {
      expect(fixture.stderr).toContain(`[januscope:runtime]`);
      expect(fixture.stderr).toContain(
        variant.kind === "rejection" ? "unhandledRejection" : "uncaughtException",
      );
      expect(fixture.stderr).toContain(FAILURE);
    }
    await expectTargetsStopped(fixture.targets, "fatal target exit");
  } finally {
    await fixture.cleanup();
  }
});

it.each([
  { kind: "exception" as const, hostPolicy: "exception" as const },
  { kind: "exception" as const, hostPolicy: "capture" as const },
  { kind: "exception" as const, hostPolicy: "exception" as const, throwingLogger: true },
  { kind: "rejection" as const, hostPolicy: "rejection" as const },
  { kind: "rejection" as const, rejectionMode: "warn" as const },
  { kind: "rejection" as const, rejectionMode: "none" as const },
])("preserves explicit host error policy and caller-owned streams (%j)", async (variant) => {
  const fixture = await launch(variant);
  try {
    await fixture.request();
    fail(fixture.child, variant.kind);
    await waitUntil(
      () => fixture.messages.some((message) => message.type === "survived"),
      "host error policy",
    );
    expect(fixture.exit).toBeUndefined();
    if ("hostPolicy" in variant)
      expect(fixture.messages.some((message) => message.type === "handled")).toBe(true);
    await fixture.request();
    fixture.child.send!({ type: "close" });
    await waitUntil(
      () => fixture.messages.some((message) => message.type === "host-alive"),
      "library return",
    );
    expect(fixture.messages.find((message) => message.type === "returned")).toMatchObject({
      listenersPreserved: true,
      outputEnded: false,
      outputDestroyed: false,
      inputDestroyed: false,
    });
    fixture.child.send!({ type: "host-exit" });
    await waitUntil(() => fixture.closed, "host-owned exit");
    expect(fixture.exit).toEqual({ code: 0, signal: null });
  } finally {
    await fixture.cleanup();
  }
});

it("removes only its own runtime listeners across repeated library sessions", async () => {
  const fixture = await launch({ sessions: 2, hostPolicy: "exception" });
  try {
    for (let round = 0; round < 2; round++) {
      await fixture.request();
      fixture.child.send!({ type: "close" });
      await waitUntil(
        () =>
          fixture.messages.some(
            (message) => message.type === "returned" && message.round === round,
          ),
        "session return",
      );
    }
    const returned = fixture.messages.filter((message) => message.type === "returned");
    expect(returned).toHaveLength(2);
    expect(returned.every((message) => message.listenersPreserved === true)).toBe(true);
    fixture.child.send!({ type: "host-exit" });
    await waitUntil(() => fixture.closed, "host-owned exit");
  } finally {
    await fixture.cleanup();
  }
});

it("keeps concurrent library sessions independent and restores host listeners", async () => {
  const fixture = await launch({ sessions: 2, concurrent: true, hostPolicy: "exception" });
  try {
    await fixture.request(2);
    expect(fixture.targets.size).toBe(2);
    fixture.child.send!({ type: "close", round: 0 });
    await waitUntil(
      () => fixture.messages.some((message) => message.type === "returned" && message.round === 0),
      "first session return",
    );
    fail(fixture.child, "exception");
    await waitUntil(
      () => fixture.messages.some((message) => message.type === "survived"),
      "remaining host session",
    );
    await fixture.request();
    fixture.child.send!({ type: "close", round: 1 });
    await waitUntil(
      () => fixture.messages.some((message) => message.type === "host-alive"),
      "both sessions returned",
    );
    expect(fixture.messages.find((message) => message.type === "host-alive")).toMatchObject({
      listenersPreserved: true,
    });
    fixture.child.send!({ type: "host-exit" });
    await waitUntil(() => fixture.closed, "host-owned exit");
    expect(fixture.exit).toEqual({ code: 0, signal: null });
  } finally {
    await fixture.cleanup();
  }
});

for (const reason of ["EOF", "SIGINT", "SIGTERM"] as const) {
  // Windows child.kill emulates these signals as unconditional termination,
  // so it cannot exercise the graceful signal handlers tested here on POSIX.
  const check = process.platform === "win32" && reason !== "EOF" ? it.skip : it;
  check(`preserves ordinary CLI shutdown on ${reason}`, async () => {
    const fixture = await launch({ cli: true });
    try {
      await fixture.request();
      if (reason === "EOF") fixture.child.stdin!.end();
      else fixture.child.kill(reason);
      await waitUntil(() => fixture.closed, "ordinary CLI exit");
      expect(fixture.exit).toEqual({ code: 0, signal: null });
      await expectTargetsStopped(fixture.targets, "ordinary target exit");
    } finally {
      await fixture.cleanup();
    }
  });
}
