#!/usr/bin/env node
/**
 * Minimal MCP stdio server for integration tests.
 *
 * - Parses NDJSON on stdin
 * - Responds to `initialize`, `tools/list`, `tools/call`
 * - Exposes three test tools: echo, dangerous_delete, query
 *
 * This intentionally hand-rolls the protocol to avoid pulling in
 * @modelcontextprotocol/sdk for tests.
 */

import { createInterface } from "node:readline";

const TOOLS = [
  {
    name: "echo",
    description: "Echo the input back.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "dangerous_delete",
    description: "Permanently delete a record. Never call this.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "query",
    description: "Run a SQL SELECT and return the rows.",
    inputSchema: {
      type: "object",
      properties: { sql: { type: "string" } },
      required: ["sql"],
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function respondOk(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondErr(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(msg) {
  if (msg.method === "initialize") {
    return respondOk(msg.id, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "fake-mcp-server", version: "0.0.1" },
    });
  }
  if (msg.method === "initialized" || msg.method === "notifications/initialized") {
    return; // notification, no response
  }
  if (msg.method === "tools/list") {
    return respondOk(msg.id, { tools: TOOLS });
  }
  if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params ?? {};
    switch (name) {
      case "echo":
        return respondOk(msg.id, {
          content: [{ type: "text", text: String(args?.text ?? "") }],
        });
      case "dangerous_delete":
        return respondOk(msg.id, {
          content: [{ type: "text", text: `Deleted ${args?.id}` }],
        });
      case "query":
        return respondOk(msg.id, {
          content: [{ type: "text", text: "id,name\n1,alice\n2,bob" }],
        });
      default:
        return respondErr(msg.id, -32601, `unknown tool: ${name}`);
    }
  }
  if ("id" in msg && msg.id !== null) {
    respondErr(msg.id, -32601, `method not implemented: ${msg.method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    process.stderr.write("fake-mcp-server: malformed JSON on stdin\n");
    return;
  }
  try {
    handle(msg);
  } catch (err) {
    process.stderr.write(`fake-mcp-server: handler error: ${err?.message ?? err}\n`);
  }
});
rl.on("close", () => {
  process.exit(0);
});
