import { describe, expect, it } from "vitest";
import { createRateLimitOverlay } from "../../src/overlays/rateLimit.js";
import { Pipeline } from "../../src/pipeline.js";
import type { JsonRpcMessage } from "../../src/rpc.js";

interface Recorded {
  toTarget: JsonRpcMessage[];
  toClient: JsonRpcMessage[];
}

function rig(
  rules: Array<{ tool: string; perMinute: number }>,
  clock?: () => number,
): { pipeline: Pipeline; rec: Recorded } {
  const rec: Recorded = { toTarget: [], toClient: [] };
  const options = clock ? { rules, now: clock } : { rules };
  const pipeline = new Pipeline([createRateLimitOverlay(options)], {
    onForwardToTarget: (m) => rec.toTarget.push(m),
    onForwardToClient: (m) => rec.toClient.push(m),
    log: () => {},
  });
  return { pipeline, rec };
}

function call(id: number, tool: string): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: tool, arguments: {} },
  };
}

describe("rateLimit overlay", () => {
  it("forwards calls under the limit", async () => {
    const { pipeline, rec } = rig([{ tool: "query", perMinute: 60 }]);
    await pipeline.start();
    for (let i = 0; i < 10; i++) {
      await pipeline.handleClientMessage(call(i, "query"));
    }
    expect(rec.toTarget).toHaveLength(10);
    expect(rec.toClient).toHaveLength(0);
  });

  it("rejects with a -32000 error once the bucket is empty", async () => {
    const now = 1_000_000;
    const clock = (): number => now;
    const { pipeline, rec } = rig([{ tool: "query", perMinute: 3 }], clock);
    await pipeline.start();

    // 3 succeed (bucket starts full at perMinute)
    for (let i = 0; i < 3; i++) await pipeline.handleClientMessage(call(i, "query"));
    // 4th fails immediately — no time has passed to refill
    await pipeline.handleClientMessage(call(99, "query"));

    expect(rec.toTarget).toHaveLength(3);
    expect(rec.toClient).toHaveLength(1);
    const err = rec.toClient[0] as {
      id: number;
      error: { code: number; message: string; data?: unknown };
    };
    expect(err.id).toBe(99);
    expect(err.error.code).toBe(-32000);
    expect(err.error.message).toMatch(/rate limit/i);
    expect(err.error.data).toMatchObject({ limit_per_minute: 3 });
  });

  it("refills tokens over time", async () => {
    let now = 0;
    const { pipeline, rec } = rig([{ tool: "query", perMinute: 60 }], () => now);
    await pipeline.start();

    // Burn through the full 60-token bucket.
    for (let i = 0; i < 60; i++) await pipeline.handleClientMessage(call(i, "query"));
    expect(rec.toTarget).toHaveLength(60);

    // Still 0 ms elapsed: 61st should fail.
    await pipeline.handleClientMessage(call(61, "query"));
    expect(rec.toTarget).toHaveLength(60);
    expect(rec.toClient).toHaveLength(1);

    // Advance 2 seconds — at 60/min = 1/sec that should refill ~2 tokens.
    now = 2_000;
    await pipeline.handleClientMessage(call(62, "query"));
    await pipeline.handleClientMessage(call(63, "query"));
    expect(rec.toTarget).toHaveLength(62);

    // A third immediate call drains the last fractional token; no refill yet.
    await pipeline.handleClientMessage(call(64, "query"));
    expect(rec.toTarget).toHaveLength(62);
    expect(rec.toClient).toHaveLength(2);
  });

  it("gives each tool its own bucket", async () => {
    const now = 0;
    const { pipeline, rec } = rig(
      [
        { tool: "query", perMinute: 2 },
        { tool: "other", perMinute: 2 },
      ],
      () => now,
    );
    await pipeline.start();

    await pipeline.handleClientMessage(call(1, "query"));
    await pipeline.handleClientMessage(call(2, "query"));
    await pipeline.handleClientMessage(call(3, "query")); // rejected
    // 'other' has its own untouched bucket.
    await pipeline.handleClientMessage(call(4, "other"));
    await pipeline.handleClientMessage(call(5, "other"));

    expect(rec.toTarget.map((m) => (m as { id: number }).id)).toEqual([1, 2, 4, 5]);
    expect(rec.toClient.map((m) => (m as { id: number }).id)).toEqual([3]);
  });

  it("first matching rule wins; every matched tool still gets its own bucket", async () => {
    const now = 0;
    const { pipeline, rec } = rig(
      [
        { tool: "sensitive_*", perMinute: 1 },
        { tool: "*", perMinute: 100 },
      ],
      () => now,
    );
    await pipeline.start();

    // sensitive_read hits the first rule (1/min) — one call passes, second fails.
    await pipeline.handleClientMessage(call(1, "sensitive_read"));
    await pipeline.handleClientMessage(call(2, "sensitive_read"));
    // other_tool hits the catch-all `*` (100/min) — plenty of budget.
    for (let i = 3; i < 50; i++) await pipeline.handleClientMessage(call(i, "other_tool"));

    const forwardedIds = rec.toTarget.map((m) => (m as { id: number }).id).sort((a, b) => a - b);
    const rejectedIds = rec.toClient.map((m) => (m as { id: number }).id);
    expect(forwardedIds).toEqual([1, ...Array.from({ length: 47 }, (_, i) => i + 3)]);
    expect(rejectedIds).toEqual([2]);
  });

  it("tools with no matching rule pass through unconstrained", async () => {
    const { pipeline, rec } = rig([{ tool: "limited", perMinute: 1 }]);
    await pipeline.start();

    for (let i = 0; i < 100; i++) await pipeline.handleClientMessage(call(i, "unlimited"));
    expect(rec.toTarget).toHaveLength(100);
    expect(rec.toClient).toHaveLength(0);
  });

  it("ignores non-tools/call messages", async () => {
    const { pipeline, rec } = rig([{ tool: "*", perMinute: 1 }]);
    await pipeline.start();

    const listReq: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const pingReq: JsonRpcMessage = { jsonrpc: "2.0", id: 2, method: "ping" };
    const notif: JsonRpcMessage = { jsonrpc: "2.0", method: "notifications/initialized" };

    await pipeline.handleClientMessage(listReq);
    await pipeline.handleClientMessage(pingReq);
    await pipeline.handleClientMessage(notif);

    expect(rec.toTarget).toHaveLength(3);
    expect(rec.toClient).toHaveLength(0);
  });

  it("passes through tools/call with malformed params (no rate-limit state touched)", async () => {
    const { pipeline, rec } = rig([{ tool: "*", perMinute: 1 }]);
    await pipeline.start();

    // Missing params, empty params, non-string name, null name: every
    // variant should forward because the overlay has no tool-name key
    // to bucket against. These cases are the target MCP's problem to
    // validate — not ours to rate-limit.
    const malformed: JsonRpcMessage[] = [
      { jsonrpc: "2.0", id: 1, method: "tools/call" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: 42 } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: null } },
    ];
    for (const m of malformed) await pipeline.handleClientMessage(m);

    expect(rec.toTarget).toHaveLength(malformed.length);
    expect(rec.toClient).toHaveLength(0);
  });

  it("accepts fractional perMinute — bucket capacity is floored at 1", async () => {
    let now = 0;
    const { pipeline, rec } = rig([{ tool: "slow", perMinute: 0.5 }], () => now);
    await pipeline.start();

    // Capacity = max(1, 0.5) = 1, so the first call succeeds.
    await pipeline.handleClientMessage(call(1, "slow"));
    expect(rec.toTarget).toHaveLength(1);
    expect(rec.toClient).toHaveLength(0);

    // No time elapsed — second call finds an empty bucket, rejected.
    await pipeline.handleClientMessage(call(2, "slow"));
    expect(rec.toTarget).toHaveLength(1);
    expect(rec.toClient).toHaveLength(1);

    // After 2 minutes at 0.5/min = 1 token refilled (and capacity caps
    // it at 1). Next call succeeds.
    now = 120_000;
    await pipeline.handleClientMessage(call(3, "slow"));
    expect(rec.toTarget).toHaveLength(2);

    // Immediately after, the bucket is empty again.
    await pipeline.handleClientMessage(call(4, "slow"));
    expect(rec.toTarget).toHaveLength(2);
    expect(rec.toClient).toHaveLength(2);
  });

  it("rejects a rule with non-positive perMinute at construction time", () => {
    expect(() => createRateLimitOverlay({ rules: [{ tool: "query", perMinute: 0 }] })).toThrow(
      /positive/,
    );
    expect(() => createRateLimitOverlay({ rules: [{ tool: "query", perMinute: -5 }] })).toThrow(
      /positive/,
    );
    expect(() =>
      createRateLimitOverlay({
        rules: [{ tool: "query", perMinute: Number.POSITIVE_INFINITY }],
      }),
    ).toThrow(/positive/);
  });

  it("is registered as a gate overlay (fails closed on handler error)", () => {
    const overlay = createRateLimitOverlay({ rules: [{ tool: "*", perMinute: 1 }] });
    expect(overlay.kind).toBe("gate");
  });
});
