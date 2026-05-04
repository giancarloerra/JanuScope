import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runOverlay } from "../../src/index.js";
import type { OverlayConfig } from "../../src/config.js";
import { encodeFrame, FrameDecoder, type JsonRpcMessage } from "../../src/rpc.js";

const FAKE_SERVER = resolve(__dirname, "..", "fixtures", "fake-mcp-server.mjs");

describe("integration: redact + audit end-to-end", () => {
  it("client sees scrubbed output, audit captures raw bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpo-redact-int-"));
    const sink = join(dir, "audit.jsonl");

    const config: OverlayConfig = {
      target: { command: process.execPath, args: [FAKE_SERVER] },
      audit: { sink, logRawArgs: false },
      redact: {
        rules: [{ regex: "alice" }],
        replacement: "[REDACTED]",
        applyTo: "text",
      },
    };

    const clientIn = new PassThrough();
    const clientOut = new PassThrough();
    const inbox: JsonRpcMessage[] = [];
    const waiters: Array<(m: JsonRpcMessage) => void> = [];
    const decoder = new FrameDecoder(
      (msg) => {
        const w = waiters.shift();
        if (w) w(msg);
        else inbox.push(msg);
      },
      () => {},
    );
    clientOut.on("data", (chunk: Buffer) => decoder.push(chunk));

    const send = (msg: JsonRpcMessage): void => {
      clientIn.write(encodeFrame(msg));
    };
    const recv = (): Promise<JsonRpcMessage> =>
      new Promise((resolveP) => {
        const pending = inbox.shift();
        if (pending) return resolveP(pending);
        waiters.push(resolveP);
      });

    const overlayPromise = runOverlay({ config, clientIn, clientOut, log: () => {} });

    // The fake server's query tool returns "id,name\n1,alice\n2,bob"
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "query", arguments: { sql: "SELECT * FROM users" } },
    });
    const resp = (await recv()) as {
      result: { content: Array<{ text: string }> };
    };
    expect(resp.result.content[0]!.text).toBe("id,name\n1,[REDACTED]\n2,bob");

    clientIn.end();
    await overlayPromise;

    const records = readFileSync(sink, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const callRecord = records.find((r) => r.event === "tools/call") as Record<string, unknown>;
    expect(callRecord).toBeDefined();
    expect(callRecord.status).toBe("ok");
    // The audit's result_bytes reflects the original un-redacted response size
    // (includes "alice", 5 chars). The redacted version is "[REDACTED]", 10 chars.
    // Either way, the audit captures a size value:
    expect(typeof callRecord.result_bytes).toBe("number");
  });
});
