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
    it.each([
      ' \t{"amount":1.00, "id":9007199254740993, "label":"\\u0061"}\r\n',
      'Rows:\r\n[\r\n\t{"count":1}\r\n]\r\n1 row returned',
      ' \n{ "phone": "[REDACTED]", "amount": 1.00 }\n',
    ])("preserves unchanged JSON text byte for byte with applyTo=" + applyTo, async (text) => {
      const { pipeline, toClient } = session({ rules, applyTo });
      await pipeline.start();
      const messages: JsonRpcMessage[] = [
        { jsonrpc: "2.0", id: 1, result: text },
        {
          jsonrpc: "2.0",
          id: 2,
          result: {
            content: [{ type: "text", text }],
            structuredContent: { result: [{ type: "text", text }] },
          },
        },
        { jsonrpc: "2.0", id: 3, error: { code: -32000, message: text, data: { text } } },
      ];
      for (const message of messages) await pipeline.handleServerMessage(message);
      expect(toClient).toEqual(messages);
      await pipeline.stop();
    });

    it.each([
      ' \t{ "note": "customer01@example.invalid", "count": 1.00 }\r\n',
      ' \t{ "note": "customer01\\u0040example.invalid", "count": 1.00 }\r\n',
      'Rows: { "note": "customer01\\u0040example.invalid", "count": 1.00 }\n1 row returned',
    ])(
      "redacts regex matches in JSON with no matching fields and applyTo=" + applyTo,
      async (text) => {
        const { pipeline, toClient } = session({ rules, applyTo });
        await pipeline.start();
        await pipeline.handleServerMessage({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text }] },
        });
        await pipeline.handleServerMessage({
          jsonrpc: "2.0",
          id: 2,
          error: { code: -32000, message: text, data: { text } },
        });
        const result = toClient[0] as { result: { content: Array<{ text: string }> } };
        expect(result.result.content[0]?.text).toContain('"note":"[REDACTED]"');
        expect(toClient[1]).toMatchObject({
          id: 2,
          error: { code: -32000, message: expect.stringContaining('"note":"[REDACTED]"') },
        });
        expect(JSON.stringify(toClient)).not.toContain("customer01");
        await pipeline.stop();
      },
    );

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

  it("keeps applyTo=all field redaction inside arbitrary nested strings", async () => {
    const { pipeline, toClient } = session({ rules, applyTo: "all" });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        nested: [
          '{ "phone": "private-phone", "count": 7 }',
          "[{'phone': 'private-phone', 'count': 7}]",
        ],
      },
    });
    expect(toClient[0]).toMatchObject({
      result: {
        nested: ['{"phone":"[REDACTED]","count":7}', "[{'phone': \"[REDACTED]\", 'count': 7}]"],
      },
    });
    await pipeline.stop();
  });

  it("keeps regex redaction in arbitrary nested JSON strings when field rules make no changes", async () => {
    const { pipeline, toClient } = session({ rules, applyTo: "all" });
    await pipeline.start();
    const text = ' \t{ "note": "customer01\\u0040example.invalid", "count": 1.00 }\r\n';
    await pipeline.handleServerMessage({ jsonrpc: "2.0", id: 1, result: { nested: { text } } });
    expect(toClient[0]).toMatchObject({
      result: { nested: { text: '{"note":"[REDACTED]","count":1}' } },
    });
    await pipeline.stop();
  });

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

describe("Python rows in response text", () => {
  function messages(text: string): JsonRpcMessage[] {
    return [
      { jsonrpc: "2.0", id: 1, result: text },
      {
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [{ type: "text", text }],
          structuredContent: { result: [{ type: "text", text }] },
        },
      },
      { jsonrpc: "2.0", id: 3, error: { code: -32000, message: text, data: { text } } },
    ];
  }

  const row = "[{'phone': 'private-phone', 'amount': Decimal('1.00'), 'label': 'braces } ]'}]";
  for (const applyTo of ["text", "fields", "all"] as ApplyTo[]) {
    it.each([
      "Rows: " + row,
      row + "\n1 row returned",
      "Rows:\r\n" + row + "\r\n1 row returned",
      "Here's the result:\n```python\n" + row + "\n```",
      "{'a', 'b'}\nRows: " + row,
      '{ "count": 1.00, "id": 9007199254740993 }\nRows: ' + row,
    ])("redacts wrapped Python rows with applyTo=" + applyTo, async (text) => {
      const { pipeline, toClient } = session({ rules, applyTo });
      await pipeline.start();
      const input = messages(text);
      for (const message of input) await pipeline.handleServerMessage(message);
      expect(toClient).toEqual(messages(text.replace("'private-phone'", '"[REDACTED]"')));
      expect(input).toEqual(messages(text));
      await pipeline.stop();
    });
  }

  it("redacts every Python row after an existing JSON span", async () => {
    const { pipeline, toClient } = session({ rules });
    await pipeline.start();
    const text =
      "{ \"count\": 1.00 }\nRows: [{'phone': 'first-private'}]\n" +
      "More rows: {'phone': 'second-private'}\n2 rows returned";
    for (const message of messages(text)) await pipeline.handleServerMessage(message);
    expect(toClient).toEqual(
      messages(
        text.replace("'first-private'", '"[REDACTED]"').replace("'second-private'", '"[REDACTED]"'),
      ),
    );
    await pipeline.stop();
  });

  it("preserves existing JSON redaction while also redacting following Python rows", async () => {
    const { pipeline, toClient } = session({ rules });
    await pipeline.start();
    const text = '{ "phone": "json-private" }\nRows: ' + row;
    for (const message of messages(text)) await pipeline.handleServerMessage(message);
    expect(toClient).toEqual(
      messages('{"phone":"[REDACTED]"}\nRows: ' + row.replace("'private-phone'", '"[REDACTED]"')),
    );
    await pipeline.stop();
  });

  it.each(['{"phone":"json-private"}', '[{"phone":"json-private"}]'])(
    "redacts JSON following Python rows",
    async (json) => {
      const { pipeline, toClient } = session({ rules });
      await pipeline.start();
      const text = "Rows: " + row + "\nMore: " + json;
      for (const message of messages(text)) await pipeline.handleServerMessage(message);
      expect(toClient).toEqual(
        messages(
          text.replace("'private-phone'", '"[REDACTED]"').replace("json-private", "[REDACTED]"),
        ),
      );
      await pipeline.stop();
    },
  );

  it.each(['{"count": 1}', '[1, 2, {"count": 3}]'])(
    "keeps JSON-compatible values inside a Python row",
    async (value) => {
      const { pipeline, toClient } = session({ rules });
      await pipeline.start();
      const text = "Rows: [{'phone': 'private-phone', 'meta': " + value + "}]\n1 row returned";
      for (const message of messages(text)) await pipeline.handleServerMessage(message);
      expect(toClient).toEqual(messages(text.replace("'private-phone'", '"[REDACTED]"')));
      await pipeline.stop();
    },
  );

  it.each([
    { regexes: ["a"] },
    { regexes: ["a", "aa"] },
    { regexes: ['J: \\{"x":"a"\\}'] },
    { regexes: ['\\] J: \\{"x":"a"\\}'] },
  ])("applies regex rules once across mixed Python, JSON and narrative", async ({ regexes }) => {
    const replacement = "aa";
    const { pipeline, toClient } = session({
      rules: [{ field: "**.phone" }, ...regexes.map((regex) => ({ regex }))],
      replacement,
    });
    await pipeline.start();
    const text = `S: [{'x': 1}] J: { "x": "a" } E`;
    let expected = `S: [{'x': 1}] J: {"x":"a"} E`;
    for (const regex of regexes)
      expected = expected.replace(new RegExp(regex, "g"), () => replacement);
    for (const message of messages(text)) await pipeline.handleServerMessage(message);
    expect(toClient).toEqual(messages(expected));
    await pipeline.stop();
  });

  it("retains escaped JSON regex matches after Python rows and literal replacements", async () => {
    const { pipeline, toClient } = session({
      rules: [{ field: "**.phone" }, { regex: "customer01@example\\.invalid" }],
      replacement: "X$&X",
    });
    await pipeline.start();
    const text = `Rows: [{'count': 1}]\nMore: { "note": "customer01\\u0040example.invalid" }`;
    for (const message of messages(text)) await pipeline.handleServerMessage(message);
    expect(toClient).toEqual(messages(`Rows: [{'count': 1}]\nMore: {"note":"X$&X"}`));
    await pipeline.stop();
  });

  it("keeps tuple and list wrappers when matching indexed fields", async () => {
    const { pipeline, toClient } = session({ rules: [{ field: "[1].phone" }] });
    await pipeline.start();
    const text = "Rows: ({'phone': 'keep'}, {'phone': 'private-phone'},)\n2 rows returned";
    for (const message of messages(text)) await pipeline.handleServerMessage(message);
    expect(toClient).toEqual(messages(text.replace("'private-phone'", '"[REDACTED]"')));
    await pipeline.stop();
  });

  it.each([
    { row: "['header', {'phone': 'private-phone'}]", field: "[1].phone" },
    { row: "('header', {'phone': 'private-phone'},)", field: "[1].phone" },
    { row: "[None, {'phone': 'private-phone'}]", field: "[1].phone" },
    { row: "[[], {'phone': 'private-phone'}]", field: "[1].phone" },
    { row: "[{}, {'phone': 'private-phone'}]", field: "[1].phone" },
    {
      row: "[[0, {'phone': 'private-phone'}], {'phone': 'keep'}]",
      field: "[0][1].phone",
    },
    {
      row: "({'rows': ['header', {'phone': 'private-phone'}]},)",
      field: "rows[1].phone",
    },
    { row: "['header', {'phone': 'private-phone'}]", field: "phone" },
    { row: "['header', {'phone': 'private-phone'}]", field: "*.phone" },
    { row: "['header', {'phone': 'private-phone'}]", field: "**.phone" },
  ])("retains the full Python container when matching $field", async ({ row, field }) => {
    const { pipeline, toClient } = session({ rules: [{ field }] });
    await pipeline.start();
    const text = "Rows: " + row + "\nResult complete";
    for (const message of messages(text)) await pipeline.handleServerMessage(message);
    expect(toClient).toEqual(messages(text.replace("'private-phone'", '"[REDACTED]"')));
    await pipeline.stop();
  });

  it.each([
    { prefix: "Notes (rows: ", suffix: ")" },
    { prefix: "Notes [rows: ", suffix: "]" },
    { prefix: "Notes (row details : ", suffix: ")" },
    { prefix: "Notes (not a literal ", suffix: ")" },
    { prefix: "Notes [not a literal ", suffix: "]" },
    { prefix: "Notes (these are rows ", suffix: ")" },
    { prefix: "[) unrelated] Rows: ", suffix: "" },
    { prefix: "(] unrelated) Rows: ", suffix: "" },
  ])(
    "preserves narrative wrappers around the actual indexed row container",
    async ({ prefix, suffix }) => {
      const { pipeline, toClient } = session({ rules: [{ field: "[1].phone" }] });
      await pipeline.start();
      const text = prefix + "['header', {'phone': 'private-phone'}]" + suffix;
      for (const message of messages(text)) await pipeline.handleServerMessage(message);
      expect(toClient).toEqual(messages(text.replace("'private-phone'", '"[REDACTED]"')));
      await pipeline.stop();
    },
  );

  it.each([
    "[), {'phone': 'private-phone'}]",
    "(], {'phone': 'private-phone'})",
    "[[), {'phone': 'private-phone'}]]",
    "[(], {'phone': 'private-phone'}]",
    "(None: {'phone': 'private-phone'})",
    "(True: {'phone': 'private-phone'})",
    "(lambda: {'phone': 'private-phone'})",
    "[item for item in [{'phone': 'private-phone'}]]",
    "(not item [{'phone': 'private-phone'}])",
    "(item is other [{'phone': 'private-phone'}])",
    "[UnknownType('x'), {'phone': 'private-phone'}]",
    "[None {'phone': 'private-phone'}]",
    "['header' {'phone': 'private-phone'}]",
    "[1 {'phone': 'private-phone'}]",
  ])("refuses literal syntax failures without flattening indexed paths", async (text) => {
    const { pipeline, toClient, logs } = session({ rules: [{ field: "[1].phone" }] });
    await pipeline.start();
    for (const message of messages(text)) await pipeline.handleServerMessage(message);
    expect(toClient).toEqual([
      expect.objectContaining({ id: 1, error: expect.objectContaining({ code: -32603 }) }),
      expect.objectContaining({ id: 2, error: expect.objectContaining({ code: -32603 }) }),
      expect.objectContaining({ id: 3, error: expect.objectContaining({ code: -32603 }) }),
    ]);
    expect(JSON.stringify([toClient, logs])).not.toContain("private-phone");
    await pipeline.handleServerMessage({ jsonrpc: "2.0", id: 4, result: "Healthy response" });
    expect(toClient[3]).toEqual({ jsonrpc: "2.0", id: 4, result: "Healthy response" });
    await pipeline.stop();
  });

  it.each([
    "{1: {'phone': 'private-phone'}}",
    "{(1, 2): {'phone': 'private-phone'}}",
    "{None: {'phone': 'private-phone'}}",
    "{True: {'phone': 'private-phone'}}",
    "{key: {'phone': 'private-phone'}}",
    "{b'phone': 'private-phone'}",
    "{Decimal('1.00'): {'phone': 'private-phone'}}",
    "{1: 'plain', 2: 'plain'}",
    "{'rows': {1: {'phone': 'private-phone'}}}",
    "['header', {1: {'phone': 'private-phone'}}]",
    "{'safe', {'phone': 'private-phone'}}",
    "{('safe', {'phone': 'private-phone'})}",
    "{'safe', {}}",
    "[item for item in [{'phone': 'private-phone'}]]",
    "{1: {'phone': 'private-phone'",
    "['header', {'phone': 'private-phone'}",
    "[(1, {'phone': 'private-phone'}]",
  ])("refuses unsupported Python dictionaries and containing structures", async (row) => {
    const { pipeline, toClient, logs } = session({ rules });
    await pipeline.start();
    const text = "Rows: " + row + "\nResult complete";
    for (const message of messages(text)) await pipeline.handleServerMessage(message);
    expect(toClient).toEqual([
      expect.objectContaining({ id: 1, error: expect.objectContaining({ code: -32603 }) }),
      expect.objectContaining({ id: 2, error: expect.objectContaining({ code: -32603 }) }),
      expect.objectContaining({ id: 3, error: expect.objectContaining({ code: -32603 }) }),
    ]);
    expect(JSON.stringify([toClient, logs])).not.toContain("private-phone");
    await pipeline.handleServerMessage({ jsonrpc: "2.0", id: 4, result: "Healthy response" });
    expect(toClient[3]).toEqual({ jsonrpc: "2.0", id: 4, result: "Healthy response" });
    await pipeline.stop();
  });

  it.each([
    "{'a', 'b'}",
    "Values: {'phone', 'private-phone'}\n2 values",
    `{'a', "{'phone': 'literal-string'}"}`,
    `Values: ["{'phone': 'literal-string'}"]`,
    `Values: ('header', "{'phone': 'literal-string'}",)`,
    `Values: [b"{'phone': 'literal-string'}", None]`,
    `Values: {(1, 2), "{'phone': 'literal-string'}"}`,
    `Values: {1, 2, 'label: value'}`,
    `Rows: [{'label': "{'phone': 'literal-string'}", 'amount': Decimal('1.00')}]\n1 row returned`,
    "Rows: [{'phone': '[REDACTED]', 'amount': Decimal('1.00')}]\n1 row returned",
  ])("preserves non-row sets, quoted examples and unmatched values", async (text) => {
    const { pipeline, toClient } = session({ rules });
    await pipeline.start();
    for (const message of messages(text)) await pipeline.handleServerMessage(message);
    expect(toClient).toEqual(messages(text));
    await pipeline.stop();
  });

  it.each([
    '{"phone":"json-private","phone":"[REDACTED]"}',
    '{"phone":"json-private","ph\\u006fne":"[REDACTED]"}',
    '{"data":{"phone":"json-private"},"data":0}',
    '[{"phone":"json-private","phone":"[REDACTED]"}]',
    '{"phone":"[REDACTED]","phone":"[REDACTED]"}',
    `Rows: [{'count': 1}]\nMore: {"phone":"json-private","phone":"[REDACTED]"}`,
  ])("refuses duplicate JSON keys instead of preserving hidden field values", async (text) => {
    const { pipeline, toClient, logs } = session({ rules });
    await pipeline.start();
    for (const message of messages(text)) await pipeline.handleServerMessage(message);
    for (const [index, response] of toClient.entries()) {
      expect(response).toMatchObject({ id: index + 1, error: { code: -32603 } });
      expect(response).not.toHaveProperty("result");
    }
    expect(toClient).toHaveLength(3);
    expect(JSON.stringify([toClient, logs])).not.toContain("json-private");
    await pipeline.handleServerMessage({ jsonrpc: "2.0", id: 4, result: "Healthy response" });
    expect(toClient[3]).toEqual({ jsonrpc: "2.0", id: 4, result: "Healthy response" });
    await pipeline.stop();
  });

  it("preserves distinct escaped JSON keys and untouched numeric spelling", async () => {
    const { pipeline, toClient } = session({ rules });
    await pipeline.start();
    const text =
      'Rows: { "label": "a", "la\\u0062el2": "b", "count": 1.00, "id": 9007199254740993 }';
    for (const message of messages(text)) await pipeline.handleServerMessage(message);
    expect(toClient).toEqual(messages(text));
    await pipeline.stop();
  });

  it.each([
    "Rows: [{'phone': 'private-phone'",
    "Rows: [[{'phone': 'private-phone'}]\n1 row returned",
    "Rows: [{'phone': 'private-phone', 'value': UnknownType('x')}]\n1 row returned",
    "Rows: [{'phone': 'private-phone', 'value': Decimal({'phone': 'hidden'})}]\n1 row returned",
    "Rows: [{'phone': 'first-private', 'phone': 'second-private'}]\n1 row returned",
    "Rows: [{'phone': 'first-private'}]\nMore: [{'phone': 'second-private'",
    '{"count":1}\nRows: ' + "[{'phone': 'private-phone'",
    "Rows: " + "[".repeat(258) + "{'phone': 'private-phone'}" + "]".repeat(258),
  ])("refuses malformed recognized rows in narrative and recovers", async (text) => {
    const { pipeline, toClient, logs } = session({ rules });
    await pipeline.start();
    for (const message of messages(text)) await pipeline.handleServerMessage(message);
    expect(toClient).toEqual([
      expect.objectContaining({ id: 1, error: expect.objectContaining({ code: -32603 }) }),
      expect.objectContaining({ id: 2, error: expect.objectContaining({ code: -32603 }) }),
      expect.objectContaining({ id: 3, error: expect.objectContaining({ code: -32603 }) }),
    ]);
    expect(JSON.stringify([toClient, logs])).not.toMatch(
      /private-phone|first-private|second-private|hidden/,
    );
    await pipeline.handleServerMessage({ jsonrpc: "2.0", id: 4, result: "Healthy response" });
    expect(toClient[3]).toEqual({ jsonrpc: "2.0", id: 4, result: "Healthy response" });
    await pipeline.stop();
  });
});
