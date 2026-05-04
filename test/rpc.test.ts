import { describe, it, expect } from "vitest";
import {
  encodeFrame,
  FrameDecoder,
  isErrorResponse,
  isNotification,
  isRequest,
  isResponse,
  isSuccess,
  makeErrorResponse,
  RpcErrorCode,
  type JsonRpcMessage,
} from "../src/rpc.js";

describe("rpc: type guards", () => {
  it("identifies requests", () => {
    const msg: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect(isRequest(msg)).toBe(true);
    expect(isNotification(msg)).toBe(false);
    expect(isResponse(msg)).toBe(false);
  });

  it("identifies notifications", () => {
    const msg: JsonRpcMessage = { jsonrpc: "2.0", method: "notifications/cancel" };
    expect(isNotification(msg)).toBe(true);
    expect(isRequest(msg)).toBe(false);
  });

  it("identifies success responses", () => {
    const msg: JsonRpcMessage = { jsonrpc: "2.0", id: 1, result: { ok: true } };
    expect(isResponse(msg)).toBe(true);
    expect(isSuccess(msg)).toBe(true);
    expect(isErrorResponse(msg)).toBe(false);
  });

  it("identifies error responses", () => {
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32600, message: "bad" },
    };
    expect(isResponse(msg)).toBe(true);
    expect(isErrorResponse(msg)).toBe(true);
    expect(isSuccess(msg)).toBe(false);
  });
});

describe("rpc: makeErrorResponse", () => {
  it("builds a valid error envelope", () => {
    const err = makeErrorResponse(42, RpcErrorCode.MethodNotFound, "nope");
    expect(err).toEqual({
      jsonrpc: "2.0",
      id: 42,
      error: { code: -32601, message: "nope" },
    });
  });

  it("includes data when provided", () => {
    const err = makeErrorResponse("req-1", -32000, "custom", { hint: "x" });
    expect(err.error.data).toEqual({ hint: "x" });
  });
});

describe("rpc: encodeFrame", () => {
  it("serializes with trailing newline", () => {
    const frame = encodeFrame({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(frame.endsWith("\n")).toBe(true);
    expect(JSON.parse(frame.trim())).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" });
  });
});

describe("rpc: FrameDecoder", () => {
  it("emits one message per complete line", () => {
    const messages: JsonRpcMessage[] = [];
    const errors: Error[] = [];
    const decoder = new FrameDecoder(
      (msg) => messages.push(msg),
      (err) => errors.push(err),
    );

    decoder.push('{"jsonrpc":"2.0","id":1,"method":"a"}\n');
    decoder.push('{"jsonrpc":"2.0","id":2,"method":"b"}\n');

    expect(messages).toHaveLength(2);
    expect(errors).toHaveLength(0);
    expect(messages[0]).toMatchObject({ id: 1 });
    expect(messages[1]).toMatchObject({ id: 2 });
  });

  it("handles messages split across chunks", () => {
    const messages: JsonRpcMessage[] = [];
    const decoder = new FrameDecoder(
      (msg) => messages.push(msg),
      () => {},
    );

    decoder.push('{"jsonrpc":"2.0",');
    decoder.push('"id":1,"method":"split"}');
    decoder.push("\n");

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ method: "split" });
  });

  it("skips blank lines", () => {
    const messages: JsonRpcMessage[] = [];
    const errors: Error[] = [];
    const decoder = new FrameDecoder(
      (msg) => messages.push(msg),
      (err) => errors.push(err),
    );

    decoder.push('\n\n{"jsonrpc":"2.0","id":1,"method":"x"}\n\n');

    expect(messages).toHaveLength(1);
    expect(errors).toHaveLength(0);
  });

  it("reports malformed JSON without crashing", () => {
    const messages: JsonRpcMessage[] = [];
    const errors: Error[] = [];
    const decoder = new FrameDecoder(
      (msg) => messages.push(msg),
      (err) => errors.push(err),
    );

    decoder.push("not json\n");
    decoder.push('{"jsonrpc":"2.0","id":1,"method":"ok"}\n');

    expect(messages).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 1 });
  });

  it("rejects non-JSON-RPC envelopes", () => {
    const errors: Error[] = [];
    const decoder = new FrameDecoder(
      () => {},
      (err) => errors.push(err),
    );
    decoder.push('{"hello":"world"}\n');
    decoder.push('{"jsonrpc":"1.0","id":1}\n');
    expect(errors).toHaveLength(2);
  });

  it("accepts Buffer chunks", () => {
    const messages: JsonRpcMessage[] = [];
    const decoder = new FrameDecoder(
      (msg) => messages.push(msg),
      () => {},
    );
    decoder.push(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"buf"}\n', "utf8"));
    expect(messages).toHaveLength(1);
  });

  it("flush emits a final line without newline", () => {
    const messages: JsonRpcMessage[] = [];
    const decoder = new FrameDecoder(
      (msg) => messages.push(msg),
      () => {},
    );
    decoder.push('{"jsonrpc":"2.0","id":1,"method":"final"}');
    decoder.flush();
    expect(messages).toHaveLength(1);
  });

  it("flush is a no-op on an empty buffer", () => {
    const messages: JsonRpcMessage[] = [];
    const errors: Error[] = [];
    const decoder = new FrameDecoder(
      (msg) => messages.push(msg),
      (err) => errors.push(err),
    );
    decoder.flush();
    expect(messages).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});
