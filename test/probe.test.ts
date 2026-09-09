import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { probeTarget } from "../src/probe.js";
import type { OverlayConfig } from "../src/config.js";

const FIXTURE = join(process.cwd(), "test", "fixtures", "fake-mcp-server.mjs");

function fixtureConfig(overrides: Partial<OverlayConfig["target"]> = {}): OverlayConfig {
  return {
    target: { command: "node", args: [FIXTURE], ...overrides },
  } as OverlayConfig;
}

describe("probeTarget", () => {
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
