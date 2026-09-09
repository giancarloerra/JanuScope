import { expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { runOverlay } from "../../src/index.js";
import { encodeFrame, FrameDecoder, type JsonRpcMessage } from "../../src/rpc.js";

const SERVER = [
  'const readline = require("node:readline");',
  'readline.createInterface({ input: process.stdin }).on("line", line => {',
  "  const request = JSON.parse(line);",
  '  if (!("id" in request) || !request.method) return;',
  "  const mode = request.params?.arguments?.mode;",
  '  if (mode === "redaction-failure") {',
  // The envelope is valid JSON. Its truncated Python row deterministically
  // fails inside redaction, independently of the runtime's stack limit.
  `    const text = "[{'phone': 'synthetic-private-phone'";`,
  '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text }] } }) + "\\n");',
  "    return;",
  "  }",
  '  const body = mode === "error"',
  '    ? { error: { code: -32001, message: "synthetic-private@example.invalid", data: { phone: "synthetic-private-phone" } } }',
  '    : { result: { content: [{ type: "text", text: "synthetic-private@example.invalid" }], isError: mode === "tool-error" } };',
  '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...body }) + "\\n");',
  "});",
].join("\n");

it("refuses redaction failures over MCP stdio and continues serving healthy responses", async () => {
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  const inbox: JsonRpcMessage[] = [];
  const waiters: Array<(msg: JsonRpcMessage) => void> = [];
  const logs: unknown[] = [];
  const decoder = new FrameDecoder(
    (msg) => {
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else inbox.push(msg);
    },
    (error) => {
      throw error;
    },
  );
  clientOut.on("data", (chunk: Buffer) => decoder.push(chunk));
  const receive = (): Promise<JsonRpcMessage> =>
    new Promise((resolve, reject) => {
      const pending = inbox.shift();
      if (pending) return resolve(pending);
      const timer = setTimeout(() => reject(new Error("MCP response deadline exceeded")), 3000);
      waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  const running = runOverlay({
    config: {
      target: { command: process.execPath, args: ["-e", SERVER] },
      redact: { rules: [{ regex: "synthetic-private@example\\.invalid" }, { field: "**.phone" }] },
    },
    clientIn,
    clientOut,
    log: (...args) => logs.push(args),
  });
  try {
    for (const [id, mode] of [
      [0, "error"],
      [1, "redaction-failure"],
      [2, "tool-error"],
      [3, "healthy"],
    ] as const) {
      clientIn.write(
        encodeFrame({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "query", arguments: { mode } },
        }),
      );
      const response = await receive();
      expect(response).toMatchObject({ jsonrpc: "2.0", id });
      if (mode === "error") {
        expect(response).toMatchObject({
          error: {
            code: -32001,
            message: "[REDACTED]",
            data: { phone: "[REDACTED]" },
          },
        });
      } else if (mode === "redaction-failure") {
        expect(response).toMatchObject({ error: { code: -32603 } });
        expect(response).not.toHaveProperty("result");
      } else {
        expect(response).toMatchObject({
          result: {
            content: [{ type: "text", text: "[REDACTED]" }],
            isError: mode === "tool-error",
          },
        });
      }
      expect(JSON.stringify(response)).not.toContain("synthetic-private");
    }
    expect(JSON.stringify(logs)).not.toContain("synthetic-private");
  } finally {
    clientIn.end();
    await running;
  }
}, 15000);
