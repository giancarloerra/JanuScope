import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { runOverlay } from "../../src/index.js";
import type { OverlayConfig } from "../../src/config.js";
import { encodeFrame, FrameDecoder, type JsonRpcMessage } from "../../src/rpc.js";

const FAKE_SERVER = resolve(__dirname, "..", "fixtures", "fake-mcp-server.mjs");

function makeTestDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcpo-dbschema-int-"));
  const path = join(dir, "test.db");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL,
      total REAL NOT NULL,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );
  `);
  db.close();
  return path;
}

describe("integration: dbSchema + fake server", () => {
  it("injects schema into the query tool description", async () => {
    const dbPath = makeTestDb();
    const config: OverlayConfig = {
      target: { command: process.execPath, args: [FAKE_SERVER] },
      dbSchema: {
        driver: "sqlite",
        connectionString: dbPath,
        format: "markdown",
        includeComments: true,
        refresh: "startup",
      },
    };

    const clientIn = new PassThrough();
    const clientOut = new PassThrough();

    const inbox: JsonRpcMessage[] = [];
    const waiters: Array<(m: JsonRpcMessage) => void> = [];
    const decoder = new FrameDecoder(
      (msg) => {
        const w = waiters.shift();
        if (w) w(msg);
        else inbox.push(msg);
      },
      () => {},
    );
    clientOut.on("data", (chunk: Buffer) => decoder.push(chunk));

    const send = (msg: JsonRpcMessage): void => {
      clientIn.write(encodeFrame(msg));
    };
    const recv = (): Promise<JsonRpcMessage> =>
      new Promise((resolveP) => {
        const pending = inbox.shift();
        if (pending) return resolveP(pending);
        waiters.push(resolveP);
      });

    const overlayPromise = runOverlay({ config, clientIn, clientOut, log: () => {} });

    send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const resp = (await recv()) as {
      result: { tools: Array<{ name: string; description: string }> };
    };
    const queryTool = resp.result.tools.find((t) => t.name === "query");
    expect(queryTool).toBeDefined();
    expect(queryTool!.description).toContain("Database schema");
    expect(queryTool!.description).toContain("customers");
    expect(queryTool!.description).toContain("orders");
    const echoTool = resp.result.tools.find((t) => t.name === "echo");
    expect(echoTool!.description).not.toContain("Database schema");

    clientIn.end();
    await overlayPromise;
  });
});
