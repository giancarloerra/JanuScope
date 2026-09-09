import { afterEach, describe, expect, it } from "vitest";
import { fork, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { CheckReport } from "../src/check.js";

const CLI = resolve("src/cli.ts");
const WORKER = resolve("src/check-worker.ts");
const FIXTURE = resolve("test/fixtures/fake-mcp-server.mjs");
const temporary: string[] = [];
const workerGroups: number[] = [];
afterEach(() => {
  for (const pid of workerGroups.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function trackWorkerGroup(pid: unknown): number {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error("Invalid diagnostic fixture worker PID");
  }
  workerGroups.push(pid);
  return pid;
}

async function expectWorkerTreeStopped(workerPid: number, targetPids?: string): Promise<void> {
  const recorded: unknown = targetPids ? JSON.parse(readFileSync(targetPids, "utf8")) : [];
  if (
    !Array.isArray(recorded) ||
    recorded.length !== (targetPids ? 2 : 0) ||
    !recorded.every(
      (pid: unknown) => typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1,
    )
  ) {
    throw new Error("Invalid diagnostic fixture target PIDs");
  }
  const pids = [workerPid, ...recorded];
  await expect
    .poll(
      () =>
        pids.every((pid) => {
          const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
            encoding: "utf8",
          });
          if (result.error) throw result.error;
          if ((result.status !== 0 && result.status !== 1) || result.stderr.trim() !== "") {
            throw new Error("Could not inspect diagnostic fixture process state");
          }
          const status = result.stdout.trim();
          return status === "" || status.startsWith("Z");
        }),
      { timeout: 3000 },
    )
    .toBe(true);
  // Once termination is verified, do not signal a stale process-group ID again.
  const tracked = workerGroups.indexOf(workerPid);
  if (tracked !== -1) workerGroups.splice(tracked, 1);
}

function configFile(overrides: Record<string, unknown> = {}): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "januscope-check-test-"));
  temporary.push(directory);
  const path = join(directory, "config.json");
  writeFileSync(
    path,
    JSON.stringify({ target: { command: process.execPath, args: [FIXTURE] }, ...overrides }),
  );
  return { directory, path };
}

function invoke(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const child = spawn(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), CLI, "check", ...args],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolveResult, reject) => {
      const deadline = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("CLI did not exit within test deadline"));
      }, 8000);
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(deadline);
        resolveResult({ code, stdout, stderr });
      });
    },
  );
  return { child, result };
}

async function check(path: string, timeout = "5000", env = process.env) {
  const result = await invoke(["--config", path, "--timeout", timeout, "--json"], {
    ...env,
    HOME: dirname(path),
  }).result;
  if (!result.stdout)
    throw new Error(`CLI exited ${result.code} before producing a report: ${result.stderr}`);
  return { ...result, report: JSON.parse(result.stdout) as CheckReport };
}

function approvalMetadata(directory: string): string {
  const path = join(directory, ".januscope", "approved.json");
  if (!existsSync(path)) return "absent";
  const stat = statSync(path);
  return `${stat.size}:${stat.mtimeMs}`;
}

function assertProcessesStopped(path: string): void {
  const pids = JSON.parse(readFileSync(path, "utf8")) as number[];
  for (const pid of pids) {
    const status = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    }).stdout.trim();
    // A container's PID 1 may retain an already terminated zombie briefly.
    expect(status === "" || status.startsWith("Z")).toBe(true);
  }
}

const HANGING_TARGET = `const fs=require('node:fs');const cp=require('node:child_process');const descendant=cp.spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],JSON.stringify([process.pid,descendant.pid]));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;

describe("check CLI real process boundaries", () => {
  it("reports real tools and configured policies without calls, audit writes or approval changes", async () => {
    const fixture = configFile();
    const audit = join(fixture.directory, "audit.jsonl");
    writeFileSync(
      fixture.path,
      JSON.stringify({
        target: { command: process.execPath, args: [FIXTURE] },
        firstRun: "approve",
        audit: { sink: audit },
        block: ["dangerous_*", "defensive_future_*"],
        sqlGuard: { tools: ["query"] },
        redact: { rules: [{ regex: "SYNTHETIC_SENTINEL" }] },
      }),
    );
    const before = approvalMetadata(fixture.directory);
    const result = await check(fixture.path);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.report.ok).toBe(true);
    expect(result.report.tools).toEqual({
      allowed: ["echo", "query"],
      blocked: ["dangerous_delete"],
    });
    expect(result.report.policy?.audit).toBe(true);
    expect(result.report.policy?.approvalRequired).toBe(true);
    expect(result.report.checks).toContainEqual(
      expect.objectContaining({ name: "block rules", status: "info" }),
    );
    expect(existsSync(audit)).toBe(false);
    expect(approvalMetadata(fixture.directory)).toBe(before);
  });

  it.each([undefined, ""])(
    "refuses missing or empty required environment values before startup (%s)",
    async (value) => {
      const fixture = configFile({
        target: {
          command: process.execPath,
          args: [FIXTURE],
          env: { DATABASE_URL: "${JANUSCOPE_CHECK_REQUIRED_TEST}" },
        },
      });
      const env = { ...process.env };
      if (value === undefined) delete env.JANUSCOPE_CHECK_REQUIRED_TEST;
      else env.JANUSCOPE_CHECK_REQUIRED_TEST = value;
      const result = await check(fixture.path, "5000", env);
      expect(result.code).toBe(1);
      expect(result.report.checks).toEqual([
        expect.objectContaining({
          name: "configuration",
          status: "fail",
          message: expect.stringContaining("JANUSCOPE_CHECK_REQUIRED_TEST"),
        }),
      ]);
    },
  );

  it("validates env-substituted enum values using the production loader contract", async () => {
    const fixture = configFile({
      redact: { rules: [{ regex: "synthetic" }], applyTo: "${JANUSCOPE_CHECK_MODE_TEST}" },
    });
    const result = await check(fixture.path, "5000", {
      ...process.env,
      JANUSCOPE_CHECK_MODE_TEST: "text",
    });
    expect(result.report.ok).toBe(true);
    expect(result.report.policy?.redact?.applyTo).toBe("text");
  });

  it.each([
    { command: "/definitely/no/check-binary" },
    { command: process.execPath, args: [FIXTURE], cwd: "/definitely/no/check-directory" },
  ])("reports executable and cwd failures at the prerequisite boundary", async (target) => {
    const result = await check(configFile({ target }).path);
    expect(result.code).toBe(1);
    expect(result.report.checks.at(-1)).toMatchObject({
      name: "target prerequisites",
      status: "fail",
      message: expect.stringContaining("ENOENT"),
    });
  });

  it("uses the target's explicit PATH and working directory when resolving its executable", async () => {
    const fixture = configFile();
    writeFileSync(
      fixture.path,
      JSON.stringify({
        target: {
          command: basename(process.execPath),
          args: [FIXTURE],
          cwd: fixture.directory,
          env: { PATH: dirname(process.execPath) },
        },
      }),
    );
    expect((await check(fixture.path)).report.ok).toBe(true);
  });

  it("does not report success when a configured critical tool is absent", async () => {
    const result = await check(configFile({ sqlGuard: { tools: ["misspelled_query"] } }).path);
    expect(result.code).toBe(1);
    expect(result.report.checks).toContainEqual(
      expect.objectContaining({ name: "sqlGuard.tools", status: "fail" }),
    );
    expect(result.report.tools?.allowed).toContain("query");
  });

  it("uses config-relative context files and rejects missing or empty sources", async () => {
    const fixture = configFile({
      contextInjection: { injectInto: ["query"], textFile: "./context.md" },
    });
    writeFileSync(join(fixture.directory, "context.md"), "Use the configured project schema.");
    expect((await check(fixture.path)).report.ok).toBe(true);
    writeFileSync(join(fixture.directory, "context.md"), "  ");
    expect((await check(fixture.path)).report.ok).toBe(false);
    rmSync(join(fixture.directory, "context.md"));
    const missing = await check(fixture.path);
    expect(missing.report.ok).toBe(false);
    expect(missing.report.checks.at(-1)?.message).toContain("ENOENT");
  });

  it("retains safe RPC codes without printing upstream errors or stderr containing secrets", async () => {
    const code = `process.stdin.once('data',()=>{process.stderr.write('PRIVATE_TEST_SENTINEL');console.log(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32001,message:'PRIVATE_TEST_SENTINEL'}}));});`;
    const result = await check(
      configFile({ target: { command: process.execPath, args: ["-e", code] } }).path,
    );
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).not.toContain("PRIVATE_TEST_SENTINEL");
    expect(result.report.checks.at(-1)?.message).toContain("-32001");
  });

  it("reports a pagination channel failure with its safe cause and no partial tool surface", async () => {
    const code = `const send=(id,result)=>console.log(JSON.stringify({jsonrpc:'2.0',id,result}));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const msg=JSON.parse(line);if(msg.method==='initialize')send(msg.id,{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'closed-input',version:'1'}});else if(msg.method==='tools/list'){process.stderr.write('PRIVATE_TEST_SENTINEL');process.stdin.destroy();require('node:fs').closeSync(0);send(msg.id,{tools:[{name:'partial',inputSchema:{type:'object'}}],nextCursor:'page2'});setInterval(()=>{},1000);}});`;
    const result = await check(
      configFile({ target: { command: process.execPath, args: ["-e", code] } }).path,
    );
    expect(result.code).toBe(1);
    expect(result.report.ok).toBe(false);
    expect(result.report.checks.at(-1)).toMatchObject({
      name: "MCP handshake",
      status: "fail",
      message: expect.stringContaining("EPIPE"),
    });
    expect(result.report.tools).toBeUndefined();
    expect(result.stdout + result.stderr).not.toContain("PRIVATE_TEST_SENTINEL");
  });

  it.each([undefined, ["diagnostic_nonpublic"]])(
    "reaches real database startup with configured schemas %j and redacts connection failures",
    async (schemas) => {
      const fixture = configFile({
        dbSchema: {
          driver: "postgres",
          connectionString: "postgresql://diagnostic:PRIVATE_TEST_SENTINEL@127.0.0.1:1/diagnostic",
          injectInto: ["query"],
          ...(schemas ? { schemas } : {}),
        },
      });
      const result = await check(fixture.path);
      expect(result.code).toBe(1);
      expect(result.report.checks.at(-1)).toMatchObject({
        name: "dbSchema startup",
        status: "fail",
        message: expect.stringContaining("ECONNREFUSED"),
      });
      expect(result.stdout + result.stderr).not.toContain("PRIVATE_TEST_SENTINEL");
      expect(result.report.checks.some((item) => item.name === "MCP handshake")).toBe(false);
    },
  );

  it.runIf(process.platform !== "win32")(
    "bounds a hung target and kills descendants that ignore SIGTERM",
    async () => {
      const fixture = configFile();
      const pids = join(fixture.directory, "pids.json");
      writeFileSync(
        fixture.path,
        JSON.stringify({
          target: { command: process.execPath, args: ["-e", HANGING_TARGET, pids] },
        }),
      );
      const start = Date.now();
      const result = await check(fixture.path, "1800");
      expect(result.code).toBe(1);
      expect(result.report.checks.at(-1)?.name).toBe("timeout");
      expect(Date.now() - start).toBeLessThan(4000);
      assertProcessesStopped(pids);
    },
  );

  it.runIf(process.platform !== "win32")(
    "bounds synchronous config reads before target startup",
    async () => {
      const fixture = configFile();
      rmSync(fixture.path);
      const fifo = spawnSync("mkfifo", [fixture.path], { encoding: "utf8" });
      expect(fifo.status).toBe(0);
      const started = Date.now();
      const result = await check(fixture.path, "1000");
      expect(result.code).toBe(1);
      expect(result.report.checks.at(-1)).toMatchObject({
        name: "timeout",
        message: expect.stringContaining("configuration"),
      });
      expect(Date.now() - started).toBeLessThan(3000);
    },
  );

  it.runIf(process.platform !== "win32").each(["SIGINT", "SIGTERM"] as const)(
    "cancels on %s and stops the process tree",
    async (signal) => {
      const fixture = configFile();
      const pids = join(fixture.directory, "pids.json");
      writeFileSync(
        fixture.path,
        JSON.stringify({
          target: { command: process.execPath, args: ["-e", HANGING_TARGET, pids] },
        }),
      );
      const invocation = invoke(["--config", fixture.path, "--timeout", "6000", "--json"]);
      const deadline = Date.now() + 4000;
      while (!existsSync(pids) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 20));
      expect(existsSync(pids)).toBe(true);
      invocation.child.kill(signal);
      const result = await invocation.result;
      expect(result.code).toBe(signal === "SIGINT" ? 130 : 143);
      expect((JSON.parse(result.stdout) as CheckReport).checks.at(-1)?.name).toBe("cancelled");
      assertProcessesStopped(pids);
    },
  );

  it.runIf(process.platform !== "win32")(
    "cleans up stubborn target descendants after a successful check",
    async () => {
      const fixture = configFile();
      const pids = join(fixture.directory, "pids.json");
      const handshake = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'stubborn',version:'1'}}}));else if(m.method==='tools/list')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'query',inputSchema:{type:'object'}}]}}));});`;
      writeFileSync(
        fixture.path,
        JSON.stringify({
          target: { command: process.execPath, args: ["-e", HANGING_TARGET + handshake, pids] },
        }),
      );
      const result = await check(fixture.path);
      expect(result.code).toBe(0);
      assertProcessesStopped(pids);
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps cleanup under supervisor control until IPC disconnects after a successful report",
    async () => {
      const fixture = configFile();
      const pids = join(fixture.directory, "pids.json");
      const handshake = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'stubborn',version:'1'}}}));else if(m.method==='tools/list')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'query',inputSchema:{type:'object'}}]}}));});`;
      writeFileSync(
        fixture.path,
        JSON.stringify({
          target: { command: process.execPath, args: ["-e", HANGING_TARGET + handshake, pids] },
        }),
      );
      const worker = fork(WORKER, [fixture.path], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        execArgv: ["--import", import.meta.resolve("tsx")],
        env: { ...process.env, HOME: fixture.directory },
      });
      const workerPid = trackWorkerGroup(worker.pid);
      const report = await new Promise<CheckReport>((resolveReport, reject) => {
        worker.on("message", (message: { report?: CheckReport }) => {
          if (message.report) resolveReport(message.report);
        });
        worker.once("error", reject);
        worker.once("exit", () => reject(new Error("Diagnostic worker exited before reporting")));
      });
      expect(report.ok).toBe(true);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
      expect(worker.connected).toBe(true);
      expect(worker.exitCode).toBeNull();
      expect(worker.signalCode).toBeNull();
      worker.disconnect();
      await expectWorkerTreeStopped(workerPid, pids);
    },
  );

  it.runIf(process.platform !== "win32")(
    "stops the detached worker and stubborn descendants when its supervisor is killed mid-handshake",
    async () => {
      const fixture = configFile();
      const pids = join(fixture.directory, "pids.json");
      writeFileSync(
        fixture.path,
        JSON.stringify({
          target: { command: process.execPath, args: ["-e", HANGING_TARGET, pids] },
        }),
      );
      const supervisorCode = `const {fork}=require('node:child_process');const worker=fork(process.argv[1],[process.argv[2]],{detached:true,stdio:['ignore','ignore','ignore','ipc'],execArgv:['--import',process.argv[3]]});process.send({workerPid:worker.pid});worker.on('message',()=>{});`;
      const supervisor = spawn(
        process.execPath,
        ["-e", supervisorCode, WORKER, fixture.path, import.meta.resolve("tsx")],
        {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: { ...process.env, HOME: fixture.directory },
        },
      );
      try {
        const workerPid = await new Promise<number>((resolvePid, reject) => {
          supervisor.once("message", (message: { workerPid?: unknown }) => {
            try {
              resolvePid(trackWorkerGroup(message.workerPid));
            } catch (error) {
              reject(error);
            }
          });
          supervisor.once("error", reject);
          supervisor.once("exit", () => reject(new Error("Fixture supervisor exited early")));
        });
        await expect.poll(() => existsSync(pids), { timeout: 4000 }).toBe(true);
        const exited = new Promise<void>((resolveExit) =>
          supervisor.once("exit", () => resolveExit()),
        );
        supervisor.kill("SIGKILL");
        await exited;
        await expectWorkerTreeStopped(workerPid, pids);
      } finally {
        supervisor.kill("SIGKILL");
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "stops a worker blocked in a synchronous FIFO read when its supervisor is killed",
    async () => {
      const fixture = configFile();
      rmSync(fixture.path);
      expect(spawnSync("mkfifo", [fixture.path]).status).toBe(0);
      const supervisorCode = `const {fork}=require('node:child_process');const worker=fork(process.argv[1],[process.argv[2]],{detached:true,stdio:['ignore','ignore','ignore','ipc'],execArgv:['--import',process.argv[3]]});process.send({workerPid:worker.pid});worker.on('message',message=>{if(message.phase)process.send({phase:message.phase});});`;
      const supervisor = spawn(
        process.execPath,
        ["-e", supervisorCode, WORKER, fixture.path, import.meta.resolve("tsx")],
        {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: { ...process.env, HOME: fixture.directory },
        },
      );
      try {
        const configured = new Promise<void>((resolvePhase) => {
          supervisor.on("message", (message: { phase?: string }) => {
            if (message.phase === "configuration") resolvePhase();
          });
        });
        const workerPid = await new Promise<number>((resolvePid, reject) => {
          supervisor.once("message", (message: { workerPid?: unknown }) => {
            try {
              resolvePid(trackWorkerGroup(message.workerPid));
            } catch (error) {
              reject(error);
            }
          });
          supervisor.once("error", reject);
          supervisor.once("exit", () => reject(new Error("Fixture supervisor exited early")));
        });
        await configured;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
        const exited = new Promise<void>((resolveExit) =>
          supervisor.once("exit", () => resolveExit()),
        );
        supervisor.kill("SIGKILL");
        await exited;
        await expectWorkerTreeStopped(workerPid);
      } finally {
        supervisor.kill("SIGKILL");
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "exits before target startup when IPC is already disconnected during module loading",
    async () => {
      const fixture = configFile();
      const started = join(fixture.directory, "target-started");
      writeFileSync(
        fixture.path,
        JSON.stringify({
          target: {
            command: process.execPath,
            args: ["-e", "require('node:fs').writeFileSync(process.argv[1],'started');", started],
          },
        }),
      );
      const worker = fork(WORKER, [fixture.path], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        execArgv: ["--import", import.meta.resolve("tsx")],
        env: { ...process.env, HOME: fixture.directory },
      });
      const workerPid = trackWorkerGroup(worker.pid);
      worker.disconnect();
      await expectWorkerTreeStopped(workerPid);
      expect(existsSync(started)).toBe(false);
    },
  );

  it("supports repeated checks and strict timeout argument parsing", async () => {
    const fixture = configFile();
    for (let i = 0; i < 3; i++) expect((await check(fixture.path)).report.ok).toBe(true);
    for (const timeout of ["0", "-1", "10oops", "1.5", "2147483648"]) {
      const result = await invoke(["--config", fixture.path, "--timeout", timeout]).result;
      expect(result.code).toBe(2);
    }
  });
});
