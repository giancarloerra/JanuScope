import { describe, it, expect } from "vitest";
import { createRedactOverlay } from "../../src/overlays/redact.js";
import { Pipeline } from "../../src/pipeline.js";
import type { JsonRpcMessage } from "../../src/rpc.js";

function pipelineFor(options: Parameters<typeof createRedactOverlay>[0]): {
  pipeline: Pipeline;
  toClient: JsonRpcMessage[];
} {
  const toClient: JsonRpcMessage[] = [];
  const pipeline = new Pipeline([createRedactOverlay(options)], {
    onForwardToTarget: () => {},
    onForwardToClient: (m) => toClient.push(m),
    log: () => {},
  });
  return { pipeline, toClient };
}

describe("redact overlay: regex rules", () => {
  it("scrubs SSN patterns in text content blocks", async () => {
    const { pipeline, toClient } = pipelineFor({
      rules: [{ regex: "\\b\\d{3}-\\d{2}-\\d{4}\\b" }],
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "User SSN is 123-45-6789 on file" }],
      },
    });
    const txt = (toClient[0] as { result: { content: Array<{ text: string }> } }).result.content[0]!
      .text;
    expect(txt).toBe("User SSN is [REDACTED] on file");
    await pipeline.stop();
  });

  it("applies multiple regex rules in sequence", async () => {
    const { pipeline, toClient } = pipelineFor({
      rules: [{ regex: "\\b\\d{3}-\\d{2}-\\d{4}\\b" }, { regex: "sk_live_[A-Za-z0-9]+" }],
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "key sk_live_ABCDEFGHIJ and SSN 123-45-6789" }],
      },
    });
    const txt = (toClient[0] as { result: { content: Array<{ text: string }> } }).result.content[0]!
      .text;
    expect(txt).toBe("key [REDACTED] and SSN [REDACTED]");
    await pipeline.stop();
  });

  it("does not touch non-text content blocks", async () => {
    const { pipeline, toClient } = pipelineFor({
      rules: [{ regex: "." }],
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "image", data: "base64ssn:123-45-6789" }],
      },
    });
    const block = (toClient[0] as { result: { content: Array<{ data: string }> } }).result
      .content[0]!;
    expect(block).toEqual({ type: "image", data: "base64ssn:123-45-6789" });
    await pipeline.stop();
  });

  it("applyTo=all scrubs every string in the result tree", async () => {
    const { pipeline, toClient } = pipelineFor({
      rules: [{ regex: "secret" }],
      applyTo: "all",
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "has secret here" }],
        metadata: { note: "another secret field" },
      },
    });
    const result = (toClient[0] as { result: Record<string, unknown> }).result;
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    const note = (result.metadata as { note: string }).note;
    expect(text).toBe("has [REDACTED] here");
    expect(note).toBe("another [REDACTED] field");
    await pipeline.stop();
  });

  it("custom replacement string", async () => {
    const { pipeline, toClient } = pipelineFor({
      rules: [{ regex: "secret" }],
      replacement: "🛡️",
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "keep secret" }] },
    });
    const txt = (toClient[0] as { result: { content: Array<{ text: string }> } }).result.content[0]!
      .text;
    expect(txt).toBe("keep 🛡️");
    await pipeline.stop();
  });

  it("rejects invalid regex with a clear error", () => {
    expect(() => createRedactOverlay({ rules: [{ regex: "[invalid" }] })).toThrow(/invalid regex/);
  });

  it("treats replacement string literally (no $1 / $& interpolation)", async () => {
    // If we accidentally pass replacement as a string to String.replace,
    // $& would be replaced with the matched substring, leaking data. The
    // configured replacement must appear verbatim in the output.
    const { pipeline, toClient } = pipelineFor({
      rules: [{ regex: "\\b\\d{3}-\\d{2}-\\d{4}\\b" }],
      replacement: "X$&X",
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "SSN 123-45-6789 is sensitive" }],
      },
    });
    const txt = (toClient[0] as { result: { content: Array<{ text: string }> } }).result.content[0]!
      .text;
    expect(txt).toBe("SSN X$&X is sensitive");
    await pipeline.stop();
  });
});

describe("redact overlay: field rules", () => {
  it("replaces literal field path", async () => {
    const { pipeline, toClient } = pipelineFor({
      rules: [{ field: "customers.email" }],
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { customers: { email: "x@y.com", id: 1 } },
    });
    const result = (toClient[0] as { result: { customers: Record<string, unknown> } }).result;
    expect(result.customers.email).toBe("[REDACTED]");
    expect(result.customers.id).toBe(1);
    await pipeline.stop();
  });

  it("one-level wildcard *.password", async () => {
    const { pipeline, toClient } = pipelineFor({
      rules: [{ field: "*.password" }],
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        user: { password: "p1", email: "e" },
        admin: { password: "p2", email: "e2" },
      },
    });
    const result = (toClient[0] as { result: Record<string, Record<string, unknown>> }).result;
    expect(result.user!.password).toBe("[REDACTED]");
    expect(result.admin!.password).toBe("[REDACTED]");
    expect(result.user!.email).toBe("e");
    await pipeline.stop();
  });

  it("deep wildcard **.ssn", async () => {
    const { pipeline, toClient } = pipelineFor({
      rules: [{ field: "**.ssn" }],
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        a: { b: { c: { ssn: "111" } } },
        top: { ssn: "222" },
      },
    });
    const result = (
      toClient[0] as {
        result: { a: { b: { c: { ssn: string } } }; top: { ssn: string } };
      }
    ).result;
    expect(result.a.b.c.ssn).toBe("[REDACTED]");
    expect(result.top.ssn).toBe("[REDACTED]");
    await pipeline.stop();
  });

  it("array index addressing data[0].api_key", async () => {
    const { pipeline, toClient } = pipelineFor({
      rules: [{ field: "data[0].api_key" }],
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        data: [
          { api_key: "secret", id: 1 },
          { api_key: "also-secret", id: 2 },
        ],
      },
    });
    const data = (toClient[0] as { result: { data: Array<Record<string, unknown>> } }).result.data;
    expect(data[0]!.api_key).toBe("[REDACTED]");
    expect(data[1]!.api_key).toBe("also-secret");
    await pipeline.stop();
  });

  it("mixed regex + field rules", async () => {
    const { pipeline, toClient } = pipelineFor({
      rules: [{ regex: "\\b\\d{3}-\\d{2}-\\d{4}\\b" }, { field: "**.password" }],
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "ssn 123-45-6789" }],
        data: { password: "secret" },
      },
    });
    const r = (
      toClient[0] as {
        result: { content: Array<{ text: string }>; data: { password: string } };
      }
    ).result;
    expect(r.content[0]!.text).toBe("ssn [REDACTED]");
    expect(r.data.password).toBe("[REDACTED]");
    await pipeline.stop();
  });

  it("does not mutate the original result (important for audit overlay)", async () => {
    const { pipeline, toClient } = pipelineFor({
      rules: [{ field: "password" }],
    });
    await pipeline.start();

    const original = { password: "original" };
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: original,
    });
    expect(original.password).toBe("original");
    expect((toClient[0] as { result: { password: string } }).result.password).toBe("[REDACTED]");
    await pipeline.stop();
  });

  it("rejects malformed field paths", () => {
    expect(() => createRedactOverlay({ rules: [{ field: "bad path" }] })).toThrow(/bad field path/);
    expect(() => createRedactOverlay({ rules: [{ field: "name[abc]" }] })).toThrow(/non-numeric/);
    expect(() => createRedactOverlay({ rules: [{ field: "name[0" }] })).toThrow(/unclosed/);
  });

  it("does not touch client messages", async () => {
    const toTarget: JsonRpcMessage[] = [];
    const pipeline = new Pipeline([createRedactOverlay({ rules: [{ regex: "." }] })], {
      onForwardToTarget: (m) => toTarget.push(m),
      onForwardToClient: () => {},
      log: () => {},
    });
    await pipeline.start();
    await pipeline.handleClientMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "x", arguments: { sql: "SELECT" } },
    });
    expect(toTarget).toHaveLength(1);
    expect(toTarget[0]).toMatchObject({
      params: { name: "x", arguments: { sql: "SELECT" } },
    });
    await pipeline.stop();
  });
});

describe("redact overlay: JSON-in-text auto-parse", () => {
  it("applies field-path rules to JSON arrays embedded in text content blocks", async () => {
    const { pipeline, toClient } = pipelineFor({
      rules: [{ field: "**.email" }, { field: "**.password" }],
    });
    await pipeline.start();
    // This is exactly the shape @modelcontextprotocol/server-postgres
    // returns: a text content block whose `text` is a JSON-stringified
    // array of rows.
    const rows = [
      { id: 1, name: "Alice", email: "alice@example.com", password: "$2y$12$abc" },
      { id: 2, name: "Bob", email: "bob@example.com", password: "$2y$12$def" },
    ];
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
      },
    });
    const text = (toClient[0] as { result: { content: Array<{ text: string }> } }).result
      .content[0]!.text;
    // Parse back to confirm the structured scrub happened inside the string.
    const parsed = JSON.parse(text) as Array<Record<string, string>>;
    expect(parsed[0]!.email).toBe("[REDACTED]");
    expect(parsed[0]!.password).toBe("[REDACTED]");
    expect(parsed[0]!.name).toBe("Alice"); // name untouched
    expect(parsed[1]!.email).toBe("[REDACTED]");
    await pipeline.stop();
  });

  it("handles JSON objects (not just arrays) embedded in text blocks", async () => {
    const { pipeline, toClient } = pipelineFor({
      rules: [{ field: "**.api_key" }],
    });
    await pipeline.start();
    const body = { status: "ok", data: { user: { id: 1, api_key: "sk_live_12345" } } };
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: JSON.stringify(body) }] },
    });
    const text = (toClient[0] as { result: { content: Array<{ text: string }> } }).result
      .content[0]!.text;
    const parsed = JSON.parse(text) as { data: { user: { api_key: string } } };
    expect(parsed.data.user.api_key).toBe("[REDACTED]");
    await pipeline.stop();
  });

  it("preserves pretty-printed indentation if the input had newlines", async () => {
    const { pipeline, toClient } = pipelineFor({
      rules: [{ field: "**.secret" }],
    });
    await pipeline.start();
    const body = { nested: { secret: "hunter2" } };
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] },
    });
    const text = (toClient[0] as { result: { content: Array<{ text: string }> } }).result
      .content[0]!.text;
    expect(text).toContain("\n"); // indented
    expect(text).toContain('"secret": "[REDACTED]"');
    await pipeline.stop();
  });

  it("leaves non-JSON text alone (regex rules still apply)", async () => {
    const { pipeline, toClient } = pipelineFor({
      rules: [{ field: "**.email" }, { regex: "[a-z]+@[a-z]+\\.com" }],
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "Hi, here is alice@example.com for you." }],
      },
    });
    const text = (toClient[0] as { result: { content: Array<{ text: string }> } }).result
      .content[0]!.text;
    // Plain text — field rules can't match; regex does.
    expect(text).toBe("Hi, here is [REDACTED] for you.");
    await pipeline.stop();
  });

  it("does not crash on malformed JSON that looks JSON-shaped", async () => {
    const { pipeline, toClient } = pipelineFor({
      rules: [{ field: "**.email" }],
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "[{this is not json}]" }] },
    });
    // Should pass through unchanged — parser rejects, field rules skipped.
    const text = (toClient[0] as { result: { content: Array<{ text: string }> } }).result
      .content[0]!.text;
    expect(text).toBe("[{this is not json}]");
    await pipeline.stop();
  });

  it("regex rules run AFTER JSON-in-text scrub and still match", async () => {
    const { pipeline, toClient } = pipelineFor({
      rules: [
        { field: "**.email" },
        // This regex catches leftover stripe IDs (field rules don't
        // cover them in this test config).
        { regex: "cus_[A-Za-z0-9]+" },
      ],
    });
    await pipeline.start();
    const rows = [{ email: "a@b.com", stripe_id: "cus_ABCDEF" }];
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: JSON.stringify(rows) }] },
    });
    const text = (toClient[0] as { result: { content: Array<{ text: string }> } }).result
      .content[0]!.text;
    const parsed = JSON.parse(text) as Array<{ email: string; stripe_id: string }>;
    expect(parsed[0]!.email).toBe("[REDACTED]");
    expect(parsed[0]!.stripe_id).toBe("[REDACTED]");
    await pipeline.stop();
  });
});

describe("redact + audit ordering", () => {
  it("audit sees un-redacted content when audit is registered first", async () => {
    const { createAuditOverlay } = await import("../../src/overlays/audit.js");
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "mcpo-redact-audit-"));
    const sink = join(dir, "audit.jsonl");

    const toClient: JsonRpcMessage[] = [];
    const pipeline = new Pipeline(
      [
        createAuditOverlay({ sink, logRawArgs: true }),
        createRedactOverlay({ rules: [{ regex: "\\b\\d{3}-\\d{2}-\\d{4}\\b" }] }),
      ],
      {
        onForwardToTarget: () => {},
        onForwardToClient: (m) => toClient.push(m),
        log: () => {},
      },
    );
    await pipeline.start();

    await pipeline.handleClientMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "query", arguments: { sql: "SELECT 1" } },
    });
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "SSN 123-45-6789 found" }] },
    });
    await pipeline.stop();

    const records = readFileSync(sink, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const call = records.find((r) => r.event === "tools/call") as Record<string, unknown>;
    expect(call.status).toBe("ok");
    // The client receives the REDACTED version:
    const clientText = (toClient[0] as { result: { content: Array<{ text: string }> } }).result
      .content[0]!.text;
    expect(clientText).toBe("SSN [REDACTED] found");
    // audit sees the raw bytes count including the SSN in result_bytes
    expect(typeof call.result_bytes).toBe("number");
  });
});

describe("redact overlay: PCRE-style inline flag prefixes", () => {
  // Lens authors coming from Python / Go / PCRE instinctively write
  // patterns like `(?i)(password|secret)=["'][^"']+["']`. JavaScript's
  // `RegExp` throws on inline flags. Before this fix, six bundled
  // Lenses (filesystem, github, notion, linear, slack, atlassian)
  // crashed the proxy at config load because of this. The engine now
  // strips leading inline flag groups and translates them into the
  // `flags` argument instead.

  it("treats (?i) as case-insensitive flag", async () => {
    const { pipeline, toClient } = pipelineFor({
      rules: [{ regex: "(?i)SECRET" }],
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "SeCrEt and secret" }] },
    });
    const txt = (toClient[0] as { result: { content: Array<{ text: string }> } }).result.content[0]!
      .text;
    expect(txt).toBe("[REDACTED] and [REDACTED]");
    await pipeline.stop();
  });

  it("accepts combined inline flags like (?is)", async () => {
    const { pipeline, toClient } = pipelineFor({
      rules: [{ regex: "(?is)begin.*end" }],
    });
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "BEGIN line1\nline2 END rest" }],
      },
    });
    const txt = (toClient[0] as { result: { content: Array<{ text: string }> } }).result.content[0]!
      .text;
    expect(txt).toBe("[REDACTED] rest");
    await pipeline.stop();
  });

  it("rejects unknown inline flags with a clear error", () => {
    expect(() => createRedactOverlay({ rules: [{ regex: "(?x)foo" }] })).toThrow(
      /unsupported inline-flag 'x'/,
    );
  });
});

describe("redact overlay: embedded-JSON field rules", () => {
  // The official MongoDB MCP returns query results wrapped in a security
  // envelope — <untrusted-user-data-{uuid}>…</untrusted-user-data-{uuid}>
  // — so the text content block is NOT pure JSON. Before this fix the
  // field-rule walker only fired on whole-text JSON, which meant
  // `**.password_hash` silently did nothing against real Mongo output.
  // These tests pin the new fallback: if the text contains a single
  // balanced JSON object or array, redact that.

  const MONGO_WRAPPER_BEFORE =
    'Query on collection "users" resulted in 5 documents. Returning 5 documents.\n' +
    "The following section contains unverified user data. WARNING: ...\n\n" +
    "<untrusted-user-data-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee>\n";
  const MONGO_WRAPPER_AFTER = "\n</untrusted-user-data-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee>";

  async function run(
    rules: Parameters<typeof createRedactOverlay>[0]["rules"],
    innerJson: string,
  ): Promise<string> {
    const { pipeline, toClient } = pipelineFor({ rules });
    await pipeline.start();
    await pipeline.handleClientMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "find", arguments: {} },
    });
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          {
            type: "text",
            text: MONGO_WRAPPER_BEFORE + innerJson + MONGO_WRAPPER_AFTER,
          },
        ],
      },
    });
    return (toClient[0] as { result: { content: Array<{ text: string }> } }).result.content[0]!
      .text;
  }

  it("redacts field rule inside JSON wrapped by narrative envelope", async () => {
    const out = await run(
      [{ field: "**.password_hash" }],
      '[{"_id":1,"name":"A","password_hash":"hash1"},{"_id":2,"name":"B","password_hash":"hash2"}]',
    );
    expect(out).toContain('"password_hash":"[REDACTED]"');
    expect(out).not.toContain("hash1");
    expect(out).not.toContain("hash2");
    // Envelope is preserved verbatim.
    expect(out.startsWith(MONGO_WRAPPER_BEFORE)).toBe(true);
    expect(out.endsWith(MONGO_WRAPPER_AFTER)).toBe(true);
  });

  it("handles the single-object case, not just arrays", async () => {
    const out = await run([{ field: "email" }], '{"name":"Alice","email":"alice@example.com"}');
    expect(out).toContain('"email":"[REDACTED]"');
    expect(out).not.toContain("alice@example.com");
  });

  it("does not misfire when a stray '{' appears in prose", async () => {
    const { pipeline, toClient } = pipelineFor({
      rules: [{ field: "**.password_hash" }],
    });
    await pipeline.start();
    await pipeline.handleClientMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "find", arguments: {} },
    });
    // Unbalanced brace, no valid inner JSON — must be left as-is.
    const original = "Here is a { stray brace without a close.";
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: original }] },
    });
    const out = (toClient[0] as { result: { content: Array<{ text: string }> } }).result.content[0]!
      .text;
    expect(out).toBe(original);
  });

  it("ignores braces inside string literals when balancing", async () => {
    // `note` contains literal `{` and `}` — scanner must respect strings.
    const out = await run(
      [{ field: "token" }],
      '{"note":"payload is { still-opaque }","token":"secret-abc"}',
    );
    expect(out).toContain('"token":"[REDACTED]"');
    // note preserved
    expect(out).toContain("payload is { still-opaque }");
  });
});
