import { expect, it } from "vitest";
import { Pipeline, type Overlay } from "../src/pipeline.js";
import type { JsonRpcMessage } from "../src/rpc.js";

it("refuses server gate failures in the correct direction without leaking exception text", async () => {
  const toClient: JsonRpcMessage[] = [];
  const toTarget: JsonRpcMessage[] = [];
  const logs: unknown[] = [];
  const gate: Overlay = {
    name: "policy",
    kind: "gate",
    onServerMessage() {
      throw new TypeError("private-payload-in-exception");
    },
  };
  const pipeline = new Pipeline([gate], {
    onForwardToTarget: (msg) => toTarget.push(msg),
    onForwardToClient: (msg) => toClient.push(msg),
    log: (...args) => logs.push(args),
  });
  await pipeline.start();
  await pipeline.handleServerMessage({ jsonrpc: "2.0", id: 0, result: {} });
  await pipeline.handleServerMessage({ jsonrpc: "2.0", id: "", method: "sampling/createMessage" });
  await pipeline.handleServerMessage({ jsonrpc: "2.0", method: "notifications/message" });
  expect(toClient).toEqual([
    expect.objectContaining({ id: 0, error: expect.objectContaining({ code: -32603 }) }),
  ]);
  expect(toTarget).toEqual([
    expect.objectContaining({ id: "", error: expect.objectContaining({ code: -32603 }) }),
  ]);
  expect(JSON.stringify([toClient, toTarget, logs])).not.toContain("private-payload");
  await pipeline.stop();
});

it("preserves server observer failure behavior and later transformations", async () => {
  const toClient: JsonRpcMessage[] = [];
  const pipeline = new Pipeline(
    [
      {
        name: "observer",
        onServerMessage() {
          throw new Error("observer failed");
        },
      },
      {
        name: "next",
        onServerMessage(msg) {
          return { kind: "forward", msg: { ...msg, result: { checked: true } } };
        },
      },
    ],
    { onForwardToClient: (msg) => toClient.push(msg), onForwardToTarget: () => {}, log: () => {} },
  );
  await pipeline.start();
  await pipeline.handleServerMessage({ jsonrpc: "2.0", id: 1, result: {} });
  expect(toClient).toEqual([{ jsonrpc: "2.0", id: 1, result: { checked: true } }]);
  await pipeline.stop();
});
