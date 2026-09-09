import { expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { runOverlay } from "../../src/index.js";
import { encodeFrame, FrameDecoder, type JsonRpcMessage } from "../../src/rpc.js";

const UNCHANGED_JSON = ' \t{ "count": 1.00, "id": 9007199254740993 }\r\n';
const WRAPPED_PYTHON =
  "Rows: [{'phone': 'synthetic-private-phone', 'amount': Decimal('1.00')}]\n1 row returned";
const REDACTED_WRAPPED_PYTHON =
  "Rows: [{'phone': \"[REDACTED]\", 'amount': Decimal('1.00')}]\n1 row returned";
const PYTHON_SET = "Values: {'alpha', 'beta'}\n2 values returned";
const JSON_AFTER_PYTHON =
  '\n{ "phone": "synthetic-private-phone", "contact": "synthetic-private\\u0040example.invalid", "count": 1.00 }';
const REGEX_JSON_AFTER_PYTHON =
  '\n{ "contact": "synthetic-private\\u0040example.invalid", "count": 1.00 }';
const DUPLICATE_JSON: Record<string, string> = {
  "json-duplicate": '{"phone":"synthetic-private-phone","phone":"[REDACTED]"}',
  "json-duplicate-nested": '{"row":{"phone":"synthetic-private-phone"},"row":null}',
  "json-duplicate-escaped": '{"ph\\u006fne":"synthetic-private-phone","phone":"[REDACTED]"}',
};

const SERVER = [
  'const readline = require("node:readline");',
  'readline.createInterface({ input: process.stdin }).on("line", line => {',
  "  const request = JSON.parse(line);",
  '  if (!("id" in request) || !request.method) return;',
  "  const mode = request.params?.arguments?.mode;",
  `  const duplicate = ${JSON.stringify(DUPLICATE_JSON)}[mode];`,
  "  if (duplicate) {",
  '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: duplicate }] } }) + "\\n");',
  "    return;",
  "  }",
  '  if (mode === "redaction-failure") {',
  // The envelope is valid JSON. Its truncated Python row deterministically
  // fails inside redaction, independently of the runtime's stack limit.
  `    const text = "[{'phone': 'synthetic-private-phone'";`,
  '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text }] } }) + "\\n");',
  "    return;",
  "  }",
  '  if (mode === "unchanged-json") {',
  `    const text = ${JSON.stringify(UNCHANGED_JSON)};`,
  '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text }] } }) + "\\n");',
  "    return;",
  "  }",
  '  if (mode?.startsWith("python-")) {',
  `    let text = ${JSON.stringify(WRAPPED_PYTHON)};`,
  `    if (mode === "python-mixed") text = ${JSON.stringify(UNCHANGED_JSON)} + text;`,
  `    if (mode === "python-json-after") text += ${JSON.stringify(JSON_AFTER_PYTHON)};`,
  `    if (mode === "python-json-regex") text += ${JSON.stringify(REGEX_JSON_AFTER_PYTHON)};`,
  `    if (mode === "python-set") text = ${JSON.stringify(PYTHON_SET)};`,
  "    if (mode === \"python-failure\") text = \"Rows: [{'phone': 'synthetic-private-phone'\";",
  '    const body = mode === "python-error"',
  "      ? { error: { code: -32002, message: text, data: { details: text } } }",
  '      : { result: { content: [{ type: "text", text }] } };',
  '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...body }) + "\\n");',
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
      [4, "unchanged-json"],
      [5, "python-wrapped"],
      [6, "python-error"],
      [7, "python-mixed"],
      [8, "python-failure"],
      [9, "python-set"],
      [10, "python-wrapped"],
      [11, "python-json-after"],
      [12, "python-json-regex"],
      [13, "json-duplicate"],
      [14, "json-duplicate-nested"],
      [15, "json-duplicate-escaped"],
      [16, "healthy"],
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
      } else if (
        mode === "redaction-failure" ||
        mode === "python-failure" ||
        mode.startsWith("json-duplicate")
      ) {
        expect(response).toMatchObject({ error: { code: -32603 } });
        expect(response).not.toHaveProperty("result");
      } else if (mode === "unchanged-json") {
        expect(response).toMatchObject({
          result: { content: [{ type: "text", text: UNCHANGED_JSON }] },
        });
      } else if (mode === "python-error") {
        expect(response).toMatchObject({
          error: {
            code: -32002,
            message: REDACTED_WRAPPED_PYTHON,
            data: { details: REDACTED_WRAPPED_PYTHON },
          },
        });
      } else if (mode === "python-json-after" || mode === "python-json-regex") {
        const suffix =
          mode === "python-json-after"
            ? '\n{"phone":"[REDACTED]","contact":"[REDACTED]","count":1}'
            : '\n{"contact":"[REDACTED]","count":1}';
        expect(response).toMatchObject({
          result: { content: [{ type: "text", text: REDACTED_WRAPPED_PYTHON + suffix }] },
        });
      } else if (mode.startsWith("python-")) {
        const text =
          mode === "python-mixed"
            ? UNCHANGED_JSON + REDACTED_WRAPPED_PYTHON
            : mode === "python-set"
              ? PYTHON_SET
              : REDACTED_WRAPPED_PYTHON;
        expect(response).toMatchObject({ result: { content: [{ type: "text", text }] } });
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
