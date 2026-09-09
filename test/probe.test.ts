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

function paginationFixture(
  pages: number,
  finalCursor?: unknown,
): { config: OverlayConfig; pidFile: string; requestsFile: string } {
  const directory = mkdtempSync(join(tmpdir(), "januscope-probe-pages-"));
  failureFixtures.push(directory);
  const pidFile = join(directory, "pid");
  const requestsFile = join(directory, "requests");
  const config = scriptedConfig(
    `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));` +
      `const page=Number(msg.params?.cursor??1);fs.appendFileSync(${JSON.stringify(requestsFile)},page+'\\n');` +
      `const cursor=page<${pages}?String(page+1):${JSON.stringify(finalCursor)};` +
      `send(msg.id,{tools:[{name:'page_'+page,inputSchema:{type:'object'}}],...(cursor===undefined?{}:{nextCursor:cursor})});`,
  );
  return { config, pidFile, requestsFile };
}

function serverRequestFixture(
  ids: unknown[],
  request: Record<string, unknown> = { method: "ping" },
  closeInput = false,
  malformedResponse = false,
  splitUtf8 = false,
): { config: OverlayConfig; pidFile: string; trafficFile: string } {
  const directory = mkdtempSync(join(tmpdir(), "januscope-probe-requests-"));
  failureFixtures.push(directory);
  const pidFile = join(directory, "pid");
  const trafficFile = join(directory, "traffic");
  const script = `
    const fs=require('node:fs');
    fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
    const ids=${JSON.stringify(ids)};
    const request=${JSON.stringify(request)};
    const output=process.stdout;
    const send=msg=>{
      const data=Buffer.from(JSON.stringify({jsonrpc:'2.0',...msg})+'\\n');
      const marker=data.indexOf(Buffer.from('🙂'));
      if(${splitUtf8}&&marker>=0){
        output.write(data.subarray(0,marker+2));
        setTimeout(()=>output.write(data.subarray(marker+2)),100);
      }else output.write(data);
    };
    let pending, step=0, initialized=false;
    const rl=require('node:readline').createInterface({input:process.stdin});
    rl.on('line',line=>{
      const msg=JSON.parse(line);
      fs.appendFileSync(${JSON.stringify(trafficFile)},line+'\\n');
      if(pending){
        const expected=request.method==='ping'?{result:{}}:{error:{code:-32601,message:'Method not found'}};
        if(JSON.stringify(msg)!==JSON.stringify({jsonrpc:'2.0',id:ids[step],...expected}))process.exit(16);
        clearTimeout(pending.timer);
        const response=pending.response; pending=undefined; step++;
        send(response); return;
      }
      if(msg.method==='notifications/initialized'){initialized=true;return;}
      let response;
      if(msg.method==='initialize'){
        if(JSON.stringify(msg.params.capabilities)!=='{}')process.exit(17);
        response={id:msg.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'ping-fixture',version:'1'}}};
      }else if(msg.method==='tools/list'&&initialized){
        response={id:msg.id,result:${malformedResponse ? "{}" : "{tools:[{name:msg.params?.cursor?'second':'first',inputSchema:{type:'object'}}],...(msg.params?.cursor?{}:{nextCursor:'page2'})}"}};
      }else process.exit(18);
      if(step>=ids.length)process.exit(19);
      pending={response,timer:setTimeout(()=>process.exit(20),2000)};
      if(${closeInput}){rl.close();fs.closeSync(0);}
      send({method:'notifications/message',params:{level:'info',data:'synthetic notification'}});
      send({method:'ping'});
      send({id:ids[step],...request});
    });
  `;
  const config = { target: { command: process.execPath, args: ["-e", script] } } as OverlayConfig;
  return { config, pidFile, trafficFile };
}

function batchFixture(
  kind: "requests" | "responses" | "notifications",
  options: {
    override?: unknown;
    pages?: number;
    closeInput?: boolean;
    blockReply?: boolean;
    splitUtf8?: boolean;
  } = {},
): { config: OverlayConfig; pidFile: string; trafficFile: string } {
  const directory = mkdtempSync(join(tmpdir(), "januscope-probe-batch-"));
  failureFixtures.push(directory);
  const pidFile = join(directory, "pid");
  const trafficFile = join(directory, "traffic");
  const script = `
    const fs=require('node:fs'), out=process.stdout;
    fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
    const options=${JSON.stringify(options)};
    const send=msg=>{
      const data=Buffer.from(JSON.stringify(msg)+'\\n');
      const marker=data.indexOf(Buffer.from('🙂'));
      if(options.splitUtf8&&marker>=0){
        out.write(data.subarray(0,marker+2));
        setTimeout(()=>out.write(data.subarray(marker+2)),100);
      }else out.write(data);
    };
    const rl=require('node:readline').createInterface({input:process.stdin});
    let initialized=false,pending;
    rl.on('line',line=>{
      const msg=JSON.parse(line);
      fs.appendFileSync(${JSON.stringify(trafficFile)},line+'\\n');
      if(pending){
        if(JSON.stringify(msg)!==JSON.stringify(pending.replies))process.exit(31);
        clearTimeout(pending.timer);
        const response=pending.response;pending=undefined;send(response);return;
      }
      if(msg.method==='notifications/initialized'){initialized=true;return;}
      let response;
      if(msg.method==='initialize'){
        if(JSON.stringify(msg.params.capabilities)!=='{}')process.exit(32);
        response={jsonrpc:'2.0',id:msg.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'batch-fixture',version:'1'}}};
      }else if(msg.method==='tools/list'&&initialized){
        const page=Number(msg.params?.cursor??1);
        response={jsonrpc:'2.0',id:msg.id,result:{tools:[{name:'page_'+page,inputSchema:{type:'object'}}],...(page<(options.pages??2)?{nextCursor:String(page+1)}:{})}};
      }else process.exit(33);
      if('override' in options){send(options.override);setTimeout(()=>process.exit(34),2000);return;}
      const notification={jsonrpc:'2.0',method:'notifications/message',params:{level:'info',data:'synthetic notification'}};
      if(${JSON.stringify(kind)}==='notifications'){
        send([notification,{jsonrpc:'2.0',method:'ping'}]);send(response);return;
      }
      if(${JSON.stringify(kind)}==='responses'){
        send([{jsonrpc:'2.0',id:'unrelated',error:{code:-32009,message:'synthetic error'}},response,{jsonrpc:'2.0',id:msg.id+1,result:{tools:[{name:'unsolicited_future',inputSchema:{type:'object'}}]}}]);return;
      }
      const requests=[
        {jsonrpc:'2.0',id:msg.id,method:'ping'},notification,
        {jsonrpc:'2.0',id:String(msg.id),method:'ping'},
        {jsonrpc:'2.0',id:'unknown_'+msg.id,method:'synthetic/unknown'},
      ];
      if(options.splitUtf8)requests[0].id='server-🙂-'+msg.id;
      const blocked=options.blockReply&&msg.method==='tools/list';
      if(blocked)requests[0].id='x'.repeat(4*1024*1024);
      pending={
        response,
        replies:[
          {jsonrpc:'2.0',id:requests[0].id,result:{}},
          {jsonrpc:'2.0',id:String(msg.id),result:{}},
          {jsonrpc:'2.0',id:'unknown_'+msg.id,error:{code:-32601,message:'Method not found'}},
        ],
        timer:setTimeout(()=>process.exit(35),blocked?30000:2000),
      };
      if(blocked){
        rl.pause();out.write(JSON.stringify(requests)+'\\n'+JSON.stringify(response)+'\\n');return;
      }
      if(options.closeInput&&msg.method==='tools/list'){
        rl.close();fs.closeSync(0);
        out.write(JSON.stringify(requests)+'\\n'+JSON.stringify(response)+'\\n');return;
      }
      send(requests);
    });
  `;
  return {
    config: { target: { command: process.execPath, args: ["-e", script] } } as OverlayConfig,
    pidFile,
    trafficFile,
  };
}

async function expectPagesRequested(
  fixture: { pidFile: string; requestsFile: string },
  pages: number,
): Promise<void> {
  await expectTargetStopped(fixture.pidFile);
  rmSync(fixture.pidFile);
  expect(readFileSync(fixture.requestsFile, "utf8")).toBe(
    Array.from({ length: pages }, (_, i) => `${i + 1}\n`).join(""),
  );
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

describe.each([true, false])(
  "probeTarget JSON-RPC batches (verifyProtocol=%s)",
  (verifyProtocol) => {
    it("preserves batched Unicode request IDs split across UTF-8 output chunks", async () => {
      const fixture = batchFixture("requests", { splitUtf8: true });
      const result = await probeTarget(fixture.config, { verifyProtocol, timeoutMs: 15_000 });
      expect(result.tools.map((tool) => tool.name)).toEqual(
        verifyProtocol ? ["page_1", "page_2"] : ["page_1"],
      );
      await expectTargetStopped(fixture.pidFile);
      rmSync(fixture.pidFile);
    });

    it.each(["requests", "responses", "notifications"] as const)(
      "handles %s batches without accepting future responses",
      async (kind) => {
        const fixture = batchFixture(kind);
        const result = await probeTarget(fixture.config, { verifyProtocol, timeoutMs: 15_000 });
        expect(result.serverInfo).toEqual({ name: "batch-fixture", version: "1" });
        expect(result.tools.map((tool) => tool.name)).toEqual(
          verifyProtocol ? ["page_1", "page_2"] : ["page_1"],
        );
        await expectTargetStopped(fixture.pidFile);
        rmSync(fixture.pidFile);
        const traffic = readFileSync(fixture.trafficFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as unknown);
        const replies = traffic.filter(Array.isArray);
        expect(replies).toHaveLength(kind === "requests" ? (verifyProtocol ? 3 : 2) : 0);
        for (const reply of replies) expect(reply).toHaveLength(3);
      },
    );

    it.each(
      [
        [],
        [null],
        [[]],
        [1],
        [
          { jsonrpc: "2.0", id: 1, result: {} },
          { jsonrpc: "2.0", id: "server", method: "ping" },
        ],
        [{ jsonrpc: "2.0", id: null, method: "ping" }],
        [
          { jsonrpc: "2.0", id: 1, method: "ping" },
          { jsonrpc: "2.0", id: 1, method: "ping" },
        ],
        [{ jsonrpc: "2.0", id: 1, result: {}, error: { code: -32001, message: "synthetic" } }],
        [{ jsonrpc: "2.0", id: 1, error: { code: "invalid", message: "synthetic" } }],
        [{ jsonrpc: "2.0", id: 1, result: [] }],
        [
          { jsonrpc: "2.0", id: 1, result: {} },
          { jsonrpc: "2.0", id: 1, result: {} },
        ],
      ].map((batch) => ({ batch })),
    )("refuses malformed batches without partial success (%j)", async ({ batch }) => {
      const fixture = batchFixture("responses", { override: batch });
      await expect(
        probeTarget(fixture.config, { verifyProtocol, timeoutMs: 15_000 }),
      ).rejects.toMatchObject({ code: "INVALID_MCP_RESPONSE" });
      await expectTargetStopped(fixture.pidFile);
      rmSync(fixture.pidFile);
      expect(readFileSync(fixture.trafficFile, "utf8").trim().split("\n")).toHaveLength(1);
    });
  },
);

it.each([99, 100])("accepts a complete %i-page tool list returned in batches", async (pages) => {
  const fixture = batchFixture("responses", { pages });
  const result = await probeTarget(fixture.config, { verifyProtocol: true, timeoutMs: 15_000 });
  expect(result.tools.map((tool) => tool.name)).toEqual(
    Array.from({ length: pages }, (_, i) => `page_${i + 1}`),
  );
  await expectTargetStopped(fixture.pidFile);
  rmSync(fixture.pidFile);
});

it("retains the diagnostic page limit when every response is batched", async () => {
  const fixture = batchFixture("responses", { pages: 101 });
  await expect(
    probeTarget(fixture.config, { verifyProtocol: true, timeoutMs: 15_000 }),
  ).rejects.toMatchObject({ code: "MCP_PAGE_LIMIT_EXCEEDED" });
  await expectTargetStopped(fixture.pidFile);
  rmSync(fixture.pidFile);
  const traffic = readFileSync(fixture.trafficFile, "utf8").trim().split("\n");
  expect(traffic).toHaveLength(102);
});

it("retains synchronous grouped-reply write errors and stops the target", async () => {
  const fixture = batchFixture("requests");
  const cause = Object.assign(new Error("synthetic batch write failure"), { code: "EPIPE" });
  const originalWrite = Socket.prototype.write;
  vi.spyOn(Socket.prototype, "write").mockImplementation(function (
    this: Socket,
    ...args: Parameters<typeof Socket.prototype.write>
  ) {
    const chunk = args[0];
    if (typeof chunk === "string" && chunk.startsWith('[{"jsonrpc":"2.0","id":1,"result":{}')) {
      throw cause;
    }
    return originalWrite.apply(this, args);
  });
  await expect(
    probeTarget(fixture.config, { verifyProtocol: true, timeoutMs: 15_000 }),
  ).rejects.toMatchObject({ message: "failed to reply to target request", cause });
  await expectTargetStopped(fixture.pidFile);
  rmSync(fixture.pidFile);
});

it("keeps the probe deadline active while a grouped reply is blocked by target backpressure", async () => {
  const fixture = batchFixture("requests", { blockReply: true, pages: 1 });
  await expect(
    probeTarget(fixture.config, { verifyProtocol: true, timeoutMs: 15_000 }),
  ).rejects.toThrow("probe timed out after 15000ms");
  await expectTargetStopped(fixture.pidFile);
  rmSync(fixture.pidFile);
}, 25000);

it("refuses a real grouped-reply EPIPE before a following final response can report success", async () => {
  const fixture = batchFixture("requests", { closeInput: true, pages: 1 });
  await expect(
    probeTarget(fixture.config, { verifyProtocol: true, timeoutMs: 15_000 }),
  ).rejects.toMatchObject({
    message: "target input stream failed",
    cause: { code: "EPIPE" },
  });
  await expectTargetStopped(fixture.pidFile);
  rmSync(fixture.pidFile);
});

it.each([true, false])(
  "preserves singleton Unicode request IDs split across UTF-8 output chunks (verifyProtocol=%s)",
  async (verifyProtocol) => {
    const ids = ["server-🙂-1", "server-🙂-2", "server-🙂-3"].slice(0, verifyProtocol ? 3 : 2);
    const fixture = serverRequestFixture(ids, { method: "ping" }, false, false, true);
    const result = await probeTarget(fixture.config, { verifyProtocol, timeoutMs: 15_000 });
    expect(result.tools.map((tool) => tool.name)).toEqual(
      verifyProtocol ? ["first", "second"] : ["first"],
    );
    await expectTargetStopped(fixture.pidFile);
    rmSync(fixture.pidFile);
  },
);

describe("probeTarget diagnostic protocol verification", () => {
  it.each([
    { ids: [1, 2, 3], verifyProtocol: true },
    { ids: ["1", "2", "3"], verifyProtocol: true },
    { ids: [0, -1, ""], verifyProtocol: true },
    { ids: [1, 2], verifyProtocol: false },
    { ids: ["1", "2"], verifyProtocol: false },
  ])(
    "answers server pings without confusing request IDs or answering notifications (%j)",
    async ({ ids, verifyProtocol }) => {
      const fixture = serverRequestFixture(ids);
      const result = await probeTarget(fixture.config, { verifyProtocol, timeoutMs: 15_000 });
      expect(result.serverInfo).toEqual({ name: "ping-fixture", version: "1" });
      expect(result.tools.map((tool) => tool.name)).toEqual(
        verifyProtocol ? ["first", "second"] : ["first"],
      );
      await expectTargetStopped(fixture.pidFile);
      rmSync(fixture.pidFile);
      const traffic = readFileSync(fixture.trafficFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(traffic.filter((message) => !("method" in message))).toEqual(
        ids.map((id) => ({ jsonrpc: "2.0", id, result: {} })),
      );
    },
  );

  it.each(["roots/list", "sampling/createMessage"])(
    "rejects unadvertised server requests without confusing colliding IDs (%s)",
    async (method) => {
      const fixture = serverRequestFixture([1, 2, 3], { method });
      const result = await probeTarget(fixture.config, {
        verifyProtocol: true,
        timeoutMs: 15_000,
      });
      expect(result.tools.map((tool) => tool.name)).toEqual(["first", "second"]);
      await expectTargetStopped(fixture.pidFile);
      rmSync(fixture.pidFile);
      const traffic = readFileSync(fixture.trafficFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(traffic.filter((message) => !("method" in message))).toEqual(
        [1, 2, 3].map((id) => ({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Method not found" },
        })),
      );
    },
  );

  it.each([
    { method: "ping", id: null },
    { method: "ping", id: 1.5 },
    { method: "ping", id: {} },
    { method: 42 },
    { method: "ping", result: {} },
    { method: "ping", error: { code: -32001, message: "synthetic error" } },
    { method: "ping", params: null },
    { method: "ping", params: [] },
  ])(
    "refuses malformed server requests instead of treating them as responses (%j)",
    async (request) => {
      const fixture = serverRequestFixture([1], request);
      await expect(
        probeTarget(fixture.config, { verifyProtocol: true, timeoutMs: 15_000 }),
      ).rejects.toMatchObject({
        code: "INVALID_MCP_RESPONSE",
        message: "target emitted an invalid JSON-RPC request or notification",
      });
      await expectTargetStopped(fixture.pidFile);
      rmSync(fixture.pidFile);
      expect(readFileSync(fixture.trafficFile, "utf8").trim().split("\n")).toHaveLength(1);
    },
  );

  it("still refuses a malformed tools response after answering a server ping", async () => {
    const fixture = serverRequestFixture([1, 2], { method: "ping" }, false, true);
    await expect(
      probeTarget(fixture.config, { verifyProtocol: true, timeoutMs: 15_000 }),
    ).rejects.toMatchObject({
      code: "INVALID_MCP_RESPONSE",
      message: "tools/list response had no `tools` array",
    });
    await expectTargetStopped(fixture.pidFile);
    rmSync(fixture.pidFile);
  });

  it("retains a synchronous ping reply failure and stops the real target", async () => {
    const fixture = serverRequestFixture(["synthetic-write-ping"]);
    const cause = Object.assign(new Error("synthetic write failure"), { code: "EPIPE" });
    const originalWrite = Socket.prototype.write;
    vi.spyOn(Socket.prototype, "write").mockImplementation(function (
      this: Socket,
      ...args: Parameters<typeof Socket.prototype.write>
    ) {
      const chunk = args[0];
      if (typeof chunk === "string" && chunk.includes('"id":"synthetic-write-ping","result":{}')) {
        throw cause;
      }
      return originalWrite.apply(this, args);
    });
    await expect(
      probeTarget(fixture.config, { verifyProtocol: true, timeoutMs: 15_000 }),
    ).rejects.toMatchObject({ message: "failed to reply to target request", cause });
    await expectTargetStopped(fixture.pidFile);
    rmSync(fixture.pidFile);
  });

  it("retains the real broken-pipe cause when the target closes stdin before a ping reply", async () => {
    const fixture = serverRequestFixture([1], { method: "ping" }, true);
    await expect(
      probeTarget(fixture.config, { verifyProtocol: true, timeoutMs: 15_000 }),
    ).rejects.toMatchObject({
      message: "target input stream failed",
      cause: { code: "EPIPE" },
    });
    await expectTargetStopped(fixture.pidFile);
    rmSync(fixture.pidFile);
  });

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

  it.each([99, 100])("accepts a complete %i-page diagnostic tool list", async (pages) => {
    const fixture = paginationFixture(pages);
    const result = await probeTarget(fixture.config, {
      verifyProtocol: true,
      timeoutMs: 15_000,
    });
    expect(result.tools.map((tool) => tool.name)).toEqual(
      Array.from({ length: pages }, (_, i) => `page_${i + 1}`),
    );
    await expectPagesRequested(fixture, pages);
  });

  it("refuses more than 100 diagnostic pages without requesting page 101 or returning partial tools", async () => {
    const fixture = paginationFixture(101);
    await expect(
      probeTarget(fixture.config, { verifyProtocol: true, timeoutMs: 15_000 }),
    ).rejects.toMatchObject({
      code: "MCP_PAGE_LIMIT_EXCEEDED",
      message:
        "tools/list exceeds the diagnostic limit of 100 pages; configure the target to return fewer pages",
    });
    await expectPagesRequested(fixture, 100);
  });

  it.each([42, "2"])(
    "preserves invalid or repeated cursor failures on page 100 (%j)",
    async (cursor) => {
      const fixture = paginationFixture(100, cursor);
      await expect(
        probeTarget(fixture.config, { verifyProtocol: true, timeoutMs: 15_000 }),
      ).rejects.toMatchObject({
        code: "INVALID_MCP_RESPONSE",
        message: "tools/list returned an invalid or repeated pagination cursor",
      });
      await expectPagesRequested(fixture, 100);
    },
  );

  it("retains the legacy single-page result for a target with more than 100 pages", async () => {
    const fixture = paginationFixture(101);
    const result = await probeTarget(fixture.config, {
      verifyProtocol: false,
      timeoutMs: 15_000,
    });
    expect(result.tools.map((tool) => tool.name)).toEqual(["page_1"]);
    await expectPagesRequested(fixture, 1);
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
