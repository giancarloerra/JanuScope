import { describe, expect, it } from "vitest";
import { createRedactOverlay, type ApplyTo } from "../../src/overlays/redact.js";
import { Pipeline } from "../../src/pipeline.js";
import type { JsonRpcMessage } from "../../src/rpc.js";

function session(options: Parameters<typeof createRedactOverlay>[0]) {
  const toClient: JsonRpcMessage[] = [];
  const toTarget: JsonRpcMessage[] = [];
  const logs: unknown[][] = [];
  const pipeline = new Pipeline([createRedactOverlay(options)], {
    onForwardToClient: (msg) => toClient.push(msg),
    onForwardToTarget: (msg) => toTarget.push(msg),
    log: (...args) => logs.push(args),
  });
  return { pipeline, toClient, toTarget, logs };
}

const rules = [
  { regex: "[a-z0-9]+@example\\.invalid" },
  { field: "**.phone" },
  { field: "**.password_hash" },
  { field: "**.auth_token" },
];

describe("redaction at response boundaries", () => {
  it("preserves embedded JSON followed by a narrative suffix", async () => {
    const { pipeline, toClient } = session({ rules });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: '{"phone":"private-phone","count":1}\n1 row returned' }],
      },
    });
    expect(toClient[0]).toMatchObject({
      result: { content: [{ text: '{"phone":"[REDACTED]","count":1}\n1 row returned' }] },
    });
    await pipeline.stop();
  });
  for (const applyTo of ["text", "fields", "all"] as ApplyTo[]) {
    it.each([0, "", null, "request-7"])(
      "scrubs JSON-RPC errors with applyTo=" + applyTo + ", preserving id=%s and code",
      async (id) => {
        const { pipeline, toClient } = session({
          rules: [...rules, { field: "data.private" }, { field: "root_secret" }],
          applyTo,
        });
        await pipeline.start();
        const original: JsonRpcMessage = {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32001,
            message: "Invalid input customer01@example.invalid",
            data: {
              private: "private-value",
              root_secret: "root-value",
              nested: { phone: "phone-value" },
              notes: ["customer02@example.invalid"],
              text: '{"password_hash":"password-value","count":7}',
            },
          },
        };
        await pipeline.handleServerMessage(original);
        expect(toClient[0]).toMatchObject({
          id,
          error: {
            code: -32001,
            message: "Invalid input [REDACTED]",
            data: {
              private: "[REDACTED]",
              root_secret: "[REDACTED]",
              nested: { phone: "[REDACTED]" },
              notes: ["[REDACTED]"],
              text: '{"password_hash":"[REDACTED]","count":7}',
            },
          },
        });
        expect(JSON.stringify(original)).toContain("private-value");
        await pipeline.stop();
      },
    );

    it("scrubs duplicated MCP text and Python rows with applyTo=" + applyTo, async () => {
      const { pipeline, toClient } = session({ rules, applyTo });
      await pipeline.start();
      const text =
        "[{'email': 'customer01@example.invalid', 'phone': '+1-202-555-0101', " +
        "'password_hash': 'synthetic-password', 'auth_token': 'synthetic-token', 'count': 7}]";
      await pipeline.handleServerMessage({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [{ type: "text", text }],
          structuredContent: { result: [{ type: "text", text, annotations: null, _meta: null }] },
          isError: false,
        },
      });
      const serialized = JSON.stringify(toClient[0]);
      for (const value of ["customer01", "+1-202", "synthetic-password", "synthetic-token"]) {
        expect(serialized).not.toContain(value);
      }
      expect(serialized.match(/REDACTED/g)).toHaveLength(8);
      expect(serialized.match(/'count': 7/g)).toHaveLength(2);
      expect(toClient[0]).toMatchObject({ result: { isError: false } });
      await pipeline.stop();
    });
  }

  it("keeps numeric error codes and ids even under a catch-all field rule", async () => {
    const { pipeline, toClient } = session({ rules: [{ field: "*" }] });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 0,
      error: { code: -32602, message: "secret", data: "secret" },
    });
    expect(toClient).toEqual([
      {
        jsonrpc: "2.0",
        id: 0,
        error: { code: -32602, message: "[REDACTED]", data: "[REDACTED]" },
      },
    ]);
    await pipeline.stop();
  });

  it("preserves PostgreSQL scalar representations and unrelated strings byte for byte", async () => {
    const { pipeline, toClient } = session({ rules });
    await pipeline.start();
    const typed =
      "Decimal('12.34'), 'day': datetime.date(2026, 2, 1), " +
      "'moment': datetime.datetime(2026, 2, 1, 12, 0, tzinfo=datetime.timezone.utc), " +
      "'uuid_value': UUID('01234567-89ab-cdef-0123-456789abcdef'), " +
      "'absent': None, 'active': True, 'numbers': [1, 2, 3], " +
      "'label': 'O\\'Brien\\\\folder', 'bytes': b'\\x00\\xff'";
    const text = "[{'amount': " + typed + ", 'details': {'phone': 'private-phone'}}]";
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text }] },
    });
    expect(toClient[0]).toMatchObject({
      result: {
        content: [{ type: "text", text: text.replace("'private-phone'", '"[REDACTED]"') }],
      },
    });
    await pipeline.stop();
  });

  it("handles escaped field names, nested arrays, indexed paths and literal replacements", async () => {
    const { pipeline, toClient } = session({
      rules: [{ field: "rows[1].phone" }, { field: "**.password_hash" }],
      replacement: "X$&X",
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 3,
      result: {
        content: [
          {
            type: "text",
            text: "{'rows': [{'phone': 'keep'}, {'ph\\u006fne': 'remove'}], 'nested': ({'password_hash': 'also-remove'},)}",
          },
        ],
      },
    });
    expect(toClient[0]).toMatchObject({
      result: {
        content: [
          {
            text: "{'rows': [{'phone': 'keep'}, {'ph\\u006fne': \"X$&X\"}], 'nested': ({'password_hash': \"X$&X\"},)}",
          },
        ],
      },
    });
    await pipeline.stop();
  });

  it.each([
    "nan",
    "inf",
    "-inf",
    "IPv4Address('192.0.2.1')",
    "IPv6Address('2001:db8::1')",
    "IPv4Interface('192.0.2.1/24')",
    "IPv6Interface('2001:db8::1/64')",
    "IPv4Network('192.0.2.0/24')",
    "IPv6Network('2001:db8::/64')",
    "Range(1, 5, '[)')",
    "Range(datetime.date(2026, 1, 1), datetime.date(2026, 2, 1), '[)')",
    "Multirange([Range(1, 5, '[)'), Range(10, 20, '[)')])",
  ])("preserves the native PostgreSQL scalar %s while redacting row fields", async (scalar) => {
    const { pipeline, toClient } = session({ rules });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [{ type: "text", text: "[{'phone': 'private-phone', 'value': " + scalar + "}]" }],
      },
    });
    expect(toClient[0]).toMatchObject({
      result: { content: [{ text: "[{'phone': \"[REDACTED]\", 'value': " + scalar + "}]" }] },
    });
    await pipeline.stop();
  });

  it.each([
    "[{'phone': 'private-phone'",
    "[{'phone': 'private-phone', 'value': UnknownType('x')}]",
    "[{'phone': 'private-phone', 'value': Decimal({'phone': 'hidden'})}]",
    "[{'phone': 'first-secret', 'phone': 'second-secret'}]",
  ])("refuses unsupported recognized rows instead of forwarding their contents", async (text) => {
    const { pipeline, toClient, logs } = session({ rules });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 4,
      result: { content: [{ type: "text", text }] },
    });
    expect(toClient[0]).toMatchObject({ id: 4, error: { code: -32603 } });
    expect(JSON.stringify([toClient, logs])).not.toMatch(
      /private-phone|first-secret|second-secret|hidden/,
    );
    await pipeline.stop();
  });

  it("refuses ambiguous envelopes and leaves requests/notifications unchanged", async () => {
    const { pipeline, toClient, toTarget } = session({ rules });
    await pipeline.start();
    const ambiguous = {
      jsonrpc: "2.0",
      id: "",
      result: { phone: "secret" },
      error: { code: -32000, message: "customer01@example.invalid" },
    } as JsonRpcMessage;
    await pipeline.handleServerMessage(ambiguous);
    expect(toClient).toEqual([
      expect.objectContaining({ id: "", error: expect.objectContaining({ code: -32603 }) }),
    ]);
    expect(toTarget).toEqual([]);
    const notification: JsonRpcMessage = {
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    };
    const request: JsonRpcMessage = { jsonrpc: "2.0", id: 9, method: "ping" };
    await pipeline.handleServerMessage(notification);
    await pipeline.handleServerMessage(request);
    expect(toClient.slice(1)).toEqual([notification, request]);
    await pipeline.stop();
  });

  it("refuses native clone failures and recovers for the next healthy response", async () => {
    const { pipeline, toClient, logs } = session({ rules });
    await pipeline.start();
    const result: Record<string, unknown> = {
      content: [{ type: "text", text: "customer01@example.invalid" }],
      // A programmatic overlay can introduce values that structuredClone
      // cannot copy. This fails deterministically without a stack-depth guess.
      uncloneable: () => "synthetic-private-value",
    };
    await pipeline.handleServerMessage({ jsonrpc: "2.0", id: 7, result });
    expect(toClient[0]).toMatchObject({ id: 7, error: { code: -32603 } });
    expect(JSON.stringify([toClient, logs])).not.toMatch(/customer01|synthetic-private/);
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 8,
      result: { content: [{ type: "text", text: "customer02@example.invalid" }] },
    });
    expect(toClient[1]).toMatchObject({ id: 8, result: { content: [{ text: "[REDACTED]" }] } });
    await pipeline.stop();
  });
});
