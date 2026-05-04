import { describe, it, expect } from "vitest";
import { createBlockOverlay } from "../../src/overlays/block.js";
import { Pipeline } from "../../src/pipeline.js";
import type { JsonRpcMessage } from "../../src/rpc.js";

function makePipeline(rules: string[]): {
  pipeline: Pipeline;
  toTarget: JsonRpcMessage[];
  toClient: JsonRpcMessage[];
} {
  const toTarget: JsonRpcMessage[] = [];
  const toClient: JsonRpcMessage[] = [];
  const pipeline = new Pipeline([createBlockOverlay({ rules })], {
    onForwardToTarget: (m) => toTarget.push(m),
    onForwardToClient: (m) => toClient.push(m),
    log: () => {},
  });
  return { pipeline, toTarget, toClient };
}

describe("block overlay", () => {
  it("filters blocked tools from tools/list", async () => {
    const { pipeline, toClient } = makePipeline(["dangerous_delete"]);
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          { name: "echo", description: "e" },
          { name: "dangerous_delete", description: "d" },
          { name: "query", description: "q" },
        ],
      },
    });
    expect(toClient).toHaveLength(1);
    const result = (toClient[0] as { result: { tools: Array<{ name: string }> } }).result;
    expect(result.tools.map((t) => t.name)).toEqual(["echo", "query"]);
  });

  it("rejects tools/call for blocked tools with -32601", async () => {
    const { pipeline, toTarget, toClient } = makePipeline(["dangerous_delete"]);
    await pipeline.start();
    await pipeline.handleClientMessage({
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "dangerous_delete", arguments: {} },
    });
    expect(toTarget).toHaveLength(0);
    expect(toClient).toHaveLength(1);
    const resp = toClient[0];
    expect(resp).toMatchObject({
      jsonrpc: "2.0",
      id: 42,
      error: { code: -32601 },
    });
  });

  it("allows non-blocked calls to pass", async () => {
    const { pipeline, toTarget } = makePipeline(["dangerous_delete"]);
    await pipeline.start();
    await pipeline.handleClientMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hi" } },
    });
    expect(toTarget).toHaveLength(1);
  });

  it("supports glob matching with *", async () => {
    const { pipeline, toClient } = makePipeline(["admin_*"]);
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          { name: "admin_delete" },
          { name: "admin_create" },
          { name: "user_read" },
          { name: "something_admin" },
        ],
      },
    });
    const result = (toClient[0] as { result: { tools: Array<{ name: string }> } }).result;
    expect(result.tools.map((t) => t.name)).toEqual(["user_read", "something_admin"]);
  });

  // Regression: a glob with many consecutive `*` chars used to compile
  // to repeated `[^:]*` quantifiers, which produced catastrophic
  // polynomial backtracking on near-miss inputs (10 stars × 30 chars
  // ~ 2.3s on Node 22). Threat model: a third-party / malicious lens
  // could ship such a pattern and DoS startup. The fix collapses
  // `\*+` to `\*` before regex compilation.
  it("handles many consecutive stars without catastrophic backtracking (ReDoS regression)", async () => {
    const { pipeline, toClient } = makePipeline(["*".repeat(20)]);
    await pipeline.start();
    // Worst-case shape: long string that ends in a `:` so [^:]* can
    // never extend across it, forcing the engine to exhaust every
    // partition. With the fix this evaluates in <50ms; without it
    // the same call hangs for tens of seconds. The colon-suffixed
    // name is exactly the input that would not have matched the
    // un-collapsed regex either — we are timing the "decide the regex
    // doesn't match" path, which used to be the catastrophic one.
    const colonTarget = "a".repeat(100) + ":";
    const t0 = Date.now();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [{ name: colonTarget }, { name: "ok_tool" }],
      },
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500);
    const result = (toClient[0] as { result: { tools: Array<{ name: string }> } }).result;
    // `[^:]*` cannot cross a colon, so the colon-suffixed name is NOT
    // filtered. `ok_tool` (no colon) IS filtered. The point of the
    // test is the elapsed-time assertion above; this assertion just
    // pins the matching semantics so a future tweak that breaks them
    // fails noisily.
    expect(result.tools.map((t) => t.name)).toEqual([colonTarget]);
  });

  // Sanity: `**` and `*` and `***` should all behave identically (the
  // collapse must not change semantics for legitimate inputs).
  it("treats consecutive stars as a single star", async () => {
    const { pipeline, toClient } = makePipeline(["foo**bar"]);
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [{ name: "foo_x_bar" }, { name: "foobar" }, { name: "foo_x_baz" }],
      },
    });
    const result = (toClient[0] as { result: { tools: Array<{ name: string }> } }).result;
    expect(result.tools.map((t) => t.name)).toEqual(["foo_x_baz"]);
  });

  it("does not filter responses unrelated to tools/list", async () => {
    const { pipeline, toClient } = makePipeline(["foo"]);
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "hello" }] },
    });
    expect(toClient).toHaveLength(1);
    expect((toClient[0] as { result: unknown }).result).toEqual({
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("passes non-tools/call requests through unchanged", async () => {
    const { pipeline, toTarget } = makePipeline(["foo"]);
    await pipeline.start();
    await pipeline.handleClientMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(toTarget).toHaveLength(1);
    expect(toTarget[0]).toMatchObject({ method: "tools/list" });
  });
});
