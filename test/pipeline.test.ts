import { describe, it, expect } from "vitest";
import { Pipeline, type Overlay } from "../src/pipeline.js";
import type { JsonRpcMessage } from "../src/rpc.js";

interface Recorded {
  toTarget: JsonRpcMessage[];
  toClient: JsonRpcMessage[];
  logs: Array<{ level: string; scope: string; message: string }>;
}

function collect(): { recorded: Recorded; hooks: ConstructorParameters<typeof Pipeline>[1] } {
  const recorded: Recorded = { toTarget: [], toClient: [], logs: [] };
  return {
    recorded,
    hooks: {
      onForwardToTarget: (m) => recorded.toTarget.push(m),
      onForwardToClient: (m) => recorded.toClient.push(m),
      log: (level, scope, message) => recorded.logs.push({ level, scope, message }),
    },
  };
}

describe("pipeline: forwarding", () => {
  it("forwards unchanged when no overlays match", async () => {
    const { recorded, hooks } = collect();
    const pipeline = new Pipeline([], hooks);
    await pipeline.start();

    const msg: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "ping" };
    await pipeline.handleClientMessage(msg);

    expect(recorded.toTarget).toEqual([msg]);
    expect(recorded.toClient).toEqual([]);
  });

  it("runs client overlays in order and forwards the final result", async () => {
    const { recorded, hooks } = collect();
    const tagged: Overlay = {
      name: "tagger",
      onClientMessage(msg) {
        if ("method" in msg) {
          return { kind: "forward", msg: { ...msg, params: { tagged: true } } };
        }
        return { kind: "forward", msg };
      },
    };
    const pipeline = new Pipeline([tagged], hooks);
    await pipeline.start();

    await pipeline.handleClientMessage({ jsonrpc: "2.0", id: 1, method: "x" });

    expect(recorded.toTarget).toEqual([
      { jsonrpc: "2.0", id: 1, method: "x", params: { tagged: true } },
    ]);
  });

  it("short-circuits with respond", async () => {
    const { recorded, hooks } = collect();
    const blocker: Overlay = {
      name: "blocker",
      onClientMessage(msg) {
        if ("method" in msg) {
          return {
            kind: "respond",
            response: {
              jsonrpc: "2.0",
              id: "id" in msg ? msg.id : null,
              error: { code: -32601, message: "blocked" },
            },
          };
        }
        return { kind: "forward", msg };
      },
    };
    const pipeline = new Pipeline([blocker], hooks);
    await pipeline.start();
    await pipeline.handleClientMessage({ jsonrpc: "2.0", id: 5, method: "dangerous" });

    expect(recorded.toTarget).toEqual([]);
    expect(recorded.toClient).toEqual([
      {
        jsonrpc: "2.0",
        id: 5,
        error: { code: -32601, message: "blocked" },
      },
    ]);
  });

  it("drops messages without forwarding", async () => {
    const { recorded, hooks } = collect();
    const dropper: Overlay = {
      name: "dropper",
      onClientMessage: () => ({ kind: "drop" }),
    };
    const pipeline = new Pipeline([dropper], hooks);
    await pipeline.start();
    await pipeline.handleClientMessage({ jsonrpc: "2.0", id: 1, method: "x" });

    expect(recorded.toTarget).toEqual([]);
    expect(recorded.toClient).toEqual([]);
  });

  it("runs server overlays in registration order", async () => {
    const { recorded, hooks } = collect();
    const order: string[] = [];
    const a: Overlay = {
      name: "a",
      onServerMessage(msg) {
        order.push("a");
        return { kind: "forward", msg };
      },
    };
    const b: Overlay = {
      name: "b",
      onServerMessage(msg) {
        order.push("b");
        return { kind: "forward", msg };
      },
    };
    const pipeline = new Pipeline([a, b], hooks);
    await pipeline.start();

    await pipeline.handleServerMessage({ jsonrpc: "2.0", id: 1, result: {} });

    // Forward iteration in both directions: "a" runs before "b".
    expect(order).toEqual(["a", "b"]);
    expect(recorded.toClient).toHaveLength(1);
  });

  it("setup and teardown run in correct order", async () => {
    const { hooks } = collect();
    const calls: string[] = [];
    const a: Overlay = {
      name: "a",
      setup: () => void calls.push("setup-a"),
      teardown: () => void calls.push("teardown-a"),
    };
    const b: Overlay = {
      name: "b",
      setup: () => void calls.push("setup-b"),
      teardown: () => void calls.push("teardown-b"),
    };
    const pipeline = new Pipeline([a, b], hooks);
    await pipeline.start();
    await pipeline.stop();

    expect(calls).toEqual(["setup-a", "setup-b", "teardown-b", "teardown-a"]);
  });

  it("recovers from overlay errors and continues forwarding", async () => {
    const { recorded, hooks } = collect();
    const throwing: Overlay = {
      name: "throwing",
      onClientMessage: () => {
        throw new Error("boom");
      },
    };
    const pipeline = new Pipeline([throwing], hooks);
    await pipeline.start();

    await pipeline.handleClientMessage({ jsonrpc: "2.0", id: 1, method: "x" });

    // Failed overlay is skipped, original forwarded
    expect(recorded.toTarget).toHaveLength(1);
    expect(recorded.logs.some((l) => l.level === "error")).toBe(true);
  });

  it("stop() is idempotent", async () => {
    const { hooks } = collect();
    const pipeline = new Pipeline([], hooks);
    await pipeline.start();
    await pipeline.stop();
    await pipeline.stop();
  });

  it("gives two overlays with the same name independent state", async () => {
    // Regression: the old Map<string, …> keyed by `overlay.name` made
    // two same-named overlay instances share a state bucket, which is
    // a footgun for library users composing multiple copies of the
    // same overlay type.
    const seenA: string[] = [];
    const seenB: string[] = [];
    const makeCounter = (capture: string[]): Overlay => ({
      name: "counter",
      setup(ctx) {
        ctx.state.set("value", 0);
      },
      onClientMessage(msg, ctx) {
        const next = ((ctx.state.get("value") as number) ?? 0) + 1;
        ctx.state.set("value", next);
        capture.push(`count=${next}`);
        return { kind: "forward", msg };
      },
    });
    const { hooks } = collect();
    const pipeline = new Pipeline([makeCounter(seenA), makeCounter(seenB)], hooks);
    await pipeline.start();
    await pipeline.handleClientMessage({ jsonrpc: "2.0", id: 1, method: "x" });
    await pipeline.handleClientMessage({ jsonrpc: "2.0", id: 2, method: "x" });

    // Each overlay should have seen its own count go 1, 2.
    expect(seenA).toEqual(["count=1", "count=2"]);
    expect(seenB).toEqual(["count=1", "count=2"]);
  });

  it("fails CLOSED when a gate overlay throws on a request", async () => {
    // Regression: before the kind-based policy, a gate overlay (block,
    // sqlGuard) that crashed on a malformed payload would fail OPEN —
    // the original message forwarded to the target. That defeats the
    // entire purpose of the proxy. Now gate overlays respond with
    // -32603 InternalError and do not forward.
    const { recorded, hooks } = collect();
    const crashingGate: Overlay = {
      name: "crashing-block",
      kind: "gate",
      onClientMessage() {
        throw new Error("overlay blew up");
      },
    };
    const pipeline = new Pipeline([crashingGate], hooks);
    await pipeline.start();
    await pipeline.handleClientMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "anything" },
    });
    expect(recorded.toTarget).toHaveLength(0);
    expect(recorded.toClient).toHaveLength(1);
    const resp = recorded.toClient[0] as {
      id: number;
      error: { code: number; message: string };
    };
    expect(resp.id).toBe(7);
    expect(resp.error.code).toBe(-32603);
    expect(resp.error.message).toContain("crashing-block");
  });

  it("fails OPEN when an observer overlay throws (existing behaviour)", async () => {
    const { recorded, hooks } = collect();
    const crashingObserver: Overlay = {
      name: "crashing-audit",
      // kind: "observer" is the default
      onClientMessage() {
        throw new Error("observer blew up");
      },
    };
    const pipeline = new Pipeline([crashingObserver], hooks);
    await pipeline.start();
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "anything" },
    };
    await pipeline.handleClientMessage(msg);
    expect(recorded.toTarget).toEqual([msg]);
    expect(recorded.toClient).toHaveLength(0);
  });
});
