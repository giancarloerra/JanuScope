import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeTarget } from "../src/probe.js";
import type { OverlayConfig } from "../src/config.js";

const FIXTURE = join(process.cwd(), "test", "fixtures", "fake-mcp-server.mjs");
const failureFixtures: string[] = [];

/** Read a fixture child's PID without allowing process-group IDs or PID 1. */
function readFixturePid(pidFile: string): number {
  const value = readFileSync(pidFile, "utf8").trim();
  const pid = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error("invalid fixture PID file");
  }
  return pid;
}

function stopFixtureTarget(pidFile: string): void {
  try {
    process.kill(readFixturePid(pidFile), "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of failureFixtures.splice(0)) {
    const pidFile = join(directory, "pid");
    if (existsSync(pidFile)) {
      stopFixtureTarget(pidFile);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

function paginationFailureFixture(closeInput: boolean): { config: OverlayConfig; pidFile: string } {
  const directory = mkdtempSync(join(tmpdir(), "januscope-probe-channel-"));
  failureFixtures.push(directory);
  const pidFile = join(directory, "pid");
  const page = "send(msg.id,{tools:[],nextCursor:'page2'});";
  const config = scriptedConfig(
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);` +
      (closeInput ? `process.stdin.destroy();require('node:fs').closeSync(0);${page}` : page),
  );
  return { config, pidFile };
}

async function expectTargetStopped(pidFile: string): Promise<void> {
  const pid = readFixturePid(pidFile);
  await expect
    .poll(
      () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
          throw error;
        }
      },
      { timeout: 3000 },
    )
    .toBe(true);
}

function fixtureConfig(overrides: Partial<OverlayConfig["target"]> = {}): OverlayConfig {
  return {
    target: { command: "node", args: [FIXTURE], ...overrides },
  } as OverlayConfig;
}

describe("probeTarget", () => {
  it("rejects malformed PID files before cleanup or stopped-target checks can signal a process", async () => {
    const directory = mkdtempSync(join(tmpdir(), "januscope-probe-pid-"));
    const pidFile = join(directory, "pid");
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      for (const invalid of [
        "",
        " ",
        "0",
        "-1",
        "1",
        "1.5",
        "bad-pid",
        "Infinity",
        "9007199254740992",
      ]) {
        writeFileSync(pidFile, invalid);
        expect(() => stopFixtureTarget(pidFile)).toThrow("invalid fixture PID file");
        await expect(expectTargetStopped(pidFile)).rejects.toThrow("invalid fixture PID file");
      }
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("drives initialize → notifications/initialized → tools/list and returns the tool list", async () => {
    const result = await probeTarget(fixtureConfig(), { timeoutMs: 30_000 });
    expect(result.serverInfo.name).toBe("fake-mcp-server");
    expect(result.serverInfo.version).toBe("0.0.1");
    expect(result.tools.map((t) => t.name).sort()).toEqual(["dangerous_delete", "echo", "query"]);
  });

  it("surfaces a clear error when the target binary doesn't exist", async () => {
    await expect(
      probeTarget({ target: { command: "/definitely/no/such/binary" } } as OverlayConfig, {
        timeoutMs: 15_000,
      }),
    ).rejects.toThrow(/probe spawn failed|target exited/);
  });

  it("rejects probe timeouts shorter than the floor (uvx / mcp-remote start-up windows)", async () => {
    await expect(probeTarget(fixtureConfig(), { timeoutMs: 1000 })).rejects.toThrow(
      /must be >= 15000ms/,
    );
  });

  // The probe is supposed to clean up the spawned target whether it
  // resolves or rejects. We can't easily inspect process tables in a
  // portable test, but if the SIGTERM path leaks a child the next
  // call will pile up file descriptors and eventually fail. Running
  // five probes in a row catches the obvious leak.
  it("can be invoked repeatedly without resource leaks", async () => {
    for (let i = 0; i < 5; i++) {
      const result = await probeTarget(fixtureConfig(), { timeoutMs: 30_000 });
      expect(result.tools).toHaveLength(3);
    }
  });
});

function scriptedConfig(body: string): OverlayConfig {
  const script = `const rl=require('node:readline').createInterface({input:process.stdin});let initialized=false;const send=(id,result)=>console.log(JSON.stringify({jsonrpc:'2.0',id,result}));rl.on('line',line=>{const msg=JSON.parse(line);if(msg.method==='initialize'){send(msg.id,{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'diagnostic-fixture',version:'1'}});return;}if(msg.method==='notifications/initialized'){initialized=true;return;}if(msg.method!=='tools/list'||!initialized)process.exit(13);${body}});`;
  return { target: { command: process.execPath, args: ["-e", script] } } as OverlayConfig;
}

describe("probeTarget diagnostic protocol verification", () => {
  it("preserves handshake order, calls no tools, and collects every tools/list page", async () => {
    const config = scriptedConfig(
      `if(msg.params?.cursor==='page2')send(msg.id,{tools:[{name:'second',inputSchema:{type:'object'}}]});else send(msg.id,{tools:[{name:'first',inputSchema:{type:'object'}}],nextCursor:'page2'});`,
    );
    const result = await probeTarget(config, { verifyProtocol: true, timeoutMs: 15_000 });
    expect(result.tools.map((tool) => tool.name)).toEqual(["first", "second"]);
    // Existing callers retain the original one-page probe contract.
    const legacy = await probeTarget(config, { timeoutMs: 15_000 });
    expect(legacy.tools.map((tool) => tool.name)).toEqual(["first"]);
  });

  it("refuses a repeated cursor instead of reporting an incomplete list", async () => {
    await expect(
      probeTarget(scriptedConfig(`send(msg.id,{tools:[],nextCursor:'again'});`), {
        verifyProtocol: true,
        timeoutMs: 15_000,
      }),
    ).rejects.toMatchObject({ code: "INVALID_MCP_RESPONSE" });
  });

  it.each([{}, { tools: null }, { tools: {} }])(
    "categorizes missing tool arrays without changing legacy failures (%j)",
    async (result) => {
      const config = scriptedConfig(`send(msg.id,${JSON.stringify(result)});`);
      await expect(
        probeTarget(config, { verifyProtocol: true, timeoutMs: 15_000 }),
      ).rejects.toMatchObject({
        code: "INVALID_MCP_RESPONSE",
        message: "tools/list response had no `tools` array",
      });
      const legacy = probeTarget(config, { timeoutMs: 15_000 });
      await expect(legacy).rejects.toMatchObject({
        message: "tools/list response had no `tools` array",
      });
      await expect(legacy).rejects.not.toHaveProperty("code");
    },
  );

  it("categorizes missing arrays on later pages instead of accepting an incomplete list", async () => {
    const config = scriptedConfig(
      `send(msg.id,msg.params?.cursor?{}:{tools:[],nextCursor:'page2'});`,
    );
    await expect(
      probeTarget(config, { verifyProtocol: true, timeoutMs: 15_000 }),
    ).rejects.toMatchObject({ code: "INVALID_MCP_RESPONSE" });
    expect((await probeTarget(config, { timeoutMs: 15_000 })).tools).toEqual([]);
  });

  it("retains a synchronous pagination write failure and stops the real target", async () => {
    const fixture = paginationFailureFixture(false);
    const cause = Object.assign(new Error("synthetic write failure"), { code: "EPIPE" });
    const originalWrite = Socket.prototype.write;
    vi.spyOn(Socket.prototype, "write").mockImplementation(function (
      this: Socket,
      ...args: Parameters<typeof Socket.prototype.write>
    ) {
      const chunk = args[0];
      if (typeof chunk === "string" && chunk.includes('"params":{"cursor":"page2"}')) {
        throw cause;
      }
      return originalWrite.apply(this, args);
    });
    await expect(
      probeTarget(fixture.config, { verifyProtocol: true, timeoutMs: 15_000 }),
    ).rejects.toMatchObject({ message: "failed to send paginated tools/list", cause });
    await expectTargetStopped(fixture.pidFile);
  });

  it("retains the real broken-pipe cause when the target closes stdin before pagination", async () => {
    const fixture = paginationFailureFixture(true);
    await expect(
      probeTarget(fixture.config, { verifyProtocol: true, timeoutMs: 15_000 }),
    ).rejects.toMatchObject({
      message: "target input stream failed",
      cause: { code: "EPIPE" },
    });
    await expectTargetStopped(fixture.pidFile);
  });

  it("refuses invalid tool entries and preserves safe JSON-RPC error codes", async () => {
    await expect(
      probeTarget(scriptedConfig(`send(msg.id,{tools:[{name:42}]});`), {
        verifyProtocol: true,
        timeoutMs: 15_000,
      }),
    ).rejects.toMatchObject({ code: "INVALID_MCP_RESPONSE" });
    await expect(
      probeTarget(
        scriptedConfig(
          `console.log(JSON.stringify({jsonrpc:'2.0',id:msg.id,error:{code:-32007,message:'SYNTHETIC_SECRET'}}));`,
        ),
        { verifyProtocol: true, timeoutMs: 15_000 },
      ),
    ).rejects.toMatchObject({ code: -32007, message: "tools/list failed" });
  });

  it("refuses malformed initialize responses", async () => {
    const config = {
      target: {
        command: process.execPath,
        args: [
          "-e",
          `process.stdin.once('data',()=>console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{}})));`,
        ],
      },
    } as OverlayConfig;
    await expect(
      probeTarget(config, { verifyProtocol: true, timeoutMs: 15_000 }),
    ).rejects.toMatchObject({ code: "INVALID_MCP_RESPONSE" });
  });

  it.each([
    undefined,
    null,
    [],
    { type: "string" },
    { type: "object", properties: [] },
    { type: "object", required: [3] },
  ])("refuses malformed inputSchema envelopes (%j)", async (inputSchema) => {
    const config = scriptedConfig(
      `send(msg.id,${JSON.stringify({ tools: [{ name: "broken", inputSchema }] })});`,
    );
    await expect(
      probeTarget(config, { verifyProtocol: true, timeoutMs: 15_000 }),
    ).rejects.toMatchObject({ code: "INVALID_MCP_RESPONSE" });
    expect((await probeTarget(config, { timeoutMs: 15_000 })).tools).toHaveLength(1);
  });

  it("refuses duplicate tool names across pages", async () => {
    const config = scriptedConfig(
      `send(msg.id,{tools:[{name:'duplicate',inputSchema:{type:'object'}}],...(msg.params?.cursor?{}:{nextCursor:'again'})});`,
    );
    await expect(
      probeTarget(config, { verifyProtocol: true, timeoutMs: 15_000 }),
    ).rejects.toMatchObject({ code: "INVALID_MCP_RESPONSE" });
  });
});
