import { expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { Pipeline, type Overlay } from "../../src/pipeline.js";
import { encodeFrame, FrameDecoder, type JsonRpcMessage } from "../../src/rpc.js";
import { startStdioBridge, type StdioBridge } from "../../src/transport/stdio.js";

const SERVER = [
  'const readline = require("node:readline");',
  "let notifications = 0;",
  'readline.createInterface({ input: process.stdin }).on("line", line => {',
  "  const message = JSON.parse(line);",
  '  if (!("id" in message)) { notifications++; return; }',
  '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { notifications } }) + "\\n");',
  "});",
].join("\n");

it.each([
  { kind: "gate" as const, asyncFailure: false, expectedNotifications: 0 },
  { kind: "gate" as const, asyncFailure: true, expectedNotifications: 0 },
  { kind: "observer" as const, asyncFailure: false, expectedNotifications: 1 },
])(
  "$kind notification failure (async=$asyncFailure) preserves the stdio refusal contract and recovery",
  async ({ kind, asyncFailure, expectedNotifications }) => {
    const clientIn = new PassThrough();
    const clientOut = new PassThrough();
    const overlay: Overlay = {
      name: "notification-policy",
      kind,
      onClientMessage(message) {
        if ("method" in message && message.method === "notifications/initialized") {
          const error = new Error("synthetic policy failure");
          if (asyncFailure) return Promise.reject(error);
          throw error;
        }
        return { kind: "forward", msg: message };
      },
    };
    const pipeline = new Pipeline([overlay], {
      onForwardToTarget: (message) => bridge.forwardToTarget(message),
      onForwardToClient: (message) => bridge.forwardToClient(message),
      log: () => {},
    });
    await pipeline.start();
    const bridge: StdioBridge = startStdioBridge({
      target: { command: process.execPath, args: ["-e", SERVER] },
      pipeline,
      clientIn,
      clientOut,
      log: () => {},
    });
    let timer: ReturnType<typeof setTimeout>;
    const response = new Promise<JsonRpcMessage>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("stdio response deadline exceeded")), 3000);
      const decoder = new FrameDecoder(resolve, reject);
      clientOut.on("data", (chunk: Buffer) => decoder.push(chunk));
    });
    try {
      clientIn.write(encodeFrame({ jsonrpc: "2.0", method: "notifications/initialized" }));
      clientIn.write(encodeFrame({ jsonrpc: "2.0", id: 0, method: "ping" }));
      expect(await response).toEqual({
        jsonrpc: "2.0",
        id: 0,
        result: { notifications: expectedNotifications },
      });
    } finally {
      clearTimeout(timer!);
      clientIn.end();
      await bridge.stop("test complete");
      await pipeline.stop();
    }
  },
);

it("refuses a malformed request ID with a valid error and continues serving stdio requests", async () => {
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  const pipeline = new Pipeline(
    [
      {
        name: "request-policy",
        kind: "gate",
        onClientMessage(message) {
          if ("method" in message && message.method === "tools/call") {
            throw new Error("synthetic policy failure");
          }
          return { kind: "forward", msg: message };
        },
      },
    ],
    {
      onForwardToTarget: (message) => bridge.forwardToTarget(message),
      onForwardToClient: (message) => bridge.forwardToClient(message),
      log: () => {},
    },
  );
  await pipeline.start();
  const bridge: StdioBridge = startStdioBridge({
    target: { command: process.execPath, args: ["-e", SERVER] },
    pipeline,
    clientIn,
    clientOut,
    log: () => {},
  });
  let timer: ReturnType<typeof setTimeout>;
  const responses = new Promise<JsonRpcMessage[]>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("stdio response deadline exceeded")), 3000);
    const messages: JsonRpcMessage[] = [];
    const decoder = new FrameDecoder((message) => {
      messages.push(message);
      if (messages.length === 2) resolve(messages);
    }, reject);
    clientOut.on("data", (chunk: Buffer) => decoder.push(chunk));
  });
  try {
    clientIn.write('{"jsonrpc":"2.0","id":{"invalid":"id"},"method":"tools/call"}\n');
    clientIn.write(encodeFrame({ jsonrpc: "2.0", id: 0, method: "ping" }));
    expect(await responses).toEqual([
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: expect.stringContaining("request-policy") },
      },
      { jsonrpc: "2.0", id: 0, result: { notifications: 0 } },
    ]);
  } finally {
    clearTimeout(timer!);
    clientIn.end();
    await bridge.stop("test complete");
    await pipeline.stop();
  }
});
