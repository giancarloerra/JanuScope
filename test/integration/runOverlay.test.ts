import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runOverlay } from "../../src/index.js";
import type { OverlayConfig } from "../../src/config.js";
import { encodeFrame, FrameDecoder, type JsonRpcMessage } from "../../src/rpc.js";

const FAKE_SERVER = resolve(__dirname, "..", "fixtures", "fake-mcp-server.mjs");

/**
 * Drive the overlay end-to-end: we act as the "client", writing frames into
 * the overlay's stdin and reading frames from its stdout.
 */
async function withOverlaySession(
  config: OverlayConfig,
  script: (
    send: (msg: JsonRpcMessage) => void,
    recv: () => Promise<JsonRpcMessage>,
  ) => Promise<void>,
): Promise<void> {
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();

  const inbox: JsonRpcMessage[] = [];
  const waiters: Array<(msg: JsonRpcMessage) => void> = [];
  const decoder = new FrameDecoder(
    (msg) => {
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else inbox.push(msg);
    },
    () => {},
  );
  clientOut.on("data", (chunk: Buffer) => decoder.push(chunk));

  const send = (msg: JsonRpcMessage): void => {
    clientIn.write(encodeFrame(msg));
  };
  const recv = (): Promise<JsonRpcMessage> =>
    new Promise((resolvePromise) => {
      const pending = inbox.shift();
      if (pending) {
        resolvePromise(pending);
        return;
      }
      waiters.push(resolvePromise);
    });

  const overlayPromise = runOverlay({
    config,
    clientIn,
    clientOut,
    log: () => {},
  });

  try {
    await script(send, recv);
  } finally {
    clientIn.end();
    await overlayPromise;
  }
}

describe("integration: runOverlay with fake server", () => {
  it("forwards tools/list through unchanged with no overlays", async () => {
    const config: OverlayConfig = {
      target: { command: process.execPath, args: [FAKE_SERVER] },
    };
    await withOverlaySession(config, async (send, recv) => {
      send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const resp = (await recv()) as { result: { tools: Array<{ name: string }> } };
      expect(resp.result.tools.map((t) => t.name).sort()).toEqual([
        "dangerous_delete",
        "echo",
        "query",
      ]);
    });
  });

  it("block overlay removes dangerous_delete from tools/list", async () => {
    const config: OverlayConfig = {
      target: { command: process.execPath, args: [FAKE_SERVER] },
      block: ["dangerous_delete"],
    };
    await withOverlaySession(config, async (send, recv) => {
      send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const resp = (await recv()) as { result: { tools: Array<{ name: string }> } };
      expect(resp.result.tools.map((t) => t.name).sort()).toEqual(["echo", "query"]);
    });
  });

  it("block overlay rejects tools/call for dangerous_delete without target", async () => {
    const config: OverlayConfig = {
      target: { command: process.execPath, args: [FAKE_SERVER] },
      block: ["dangerous_delete"],
    };
    await withOverlaySession(config, async (send, recv) => {
      send({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "dangerous_delete", arguments: { id: "x" } },
      });
      const resp = await recv();
      expect(resp).toMatchObject({
        jsonrpc: "2.0",
        id: 9,
        error: { code: -32601 },
      });
    });
  });

  it("instructions overlay appends policy to each tool description", async () => {
    const config: OverlayConfig = {
      target: { command: process.execPath, args: [FAKE_SERVER] },
      instructions: "READ-ONLY.",
    };
    await withOverlaySession(config, async (send, recv) => {
      send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const resp = (await recv()) as { result: { tools: Array<{ description: string }> } };
      for (const tool of resp.result.tools) {
        expect(tool.description.endsWith("READ-ONLY.")).toBe(true);
      }
    });
  });

  it("audit overlay writes a record per call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpo-int-"));
    const sink = join(dir, "audit.jsonl");
    const config: OverlayConfig = {
      target: { command: process.execPath, args: [FAKE_SERVER] },
      audit: { sink, logRawArgs: false },
    };
    await withOverlaySession(config, async (send, recv) => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hi" } },
      });
      await recv();
    });

    const lines = readFileSync(sink, "utf8").trim().split("\n");
    const records = lines.map((l) => JSON.parse(l));
    expect(records.some((r) => r.event === "startup")).toBe(true);
    expect(records.find((r) => r.event === "tools/call" && r.tool === "echo")).toBeDefined();
    expect(records.some((r) => r.event === "shutdown")).toBe(true);
  });

  it("echo still works when instructions + audit are combined", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpo-int-"));
    const sink = join(dir, "audit.jsonl");
    const config: OverlayConfig = {
      target: { command: process.execPath, args: [FAKE_SERVER] },
      instructions: "READ-ONLY.",
      audit: { sink },
    };
    await withOverlaySession(config, async (send, recv) => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "stacked" } },
      });
      const resp = (await recv()) as { result: { content: Array<{ text: string }> } };
      expect(resp.result.content[0]!.text).toBe("stacked");
    });
  });
});
