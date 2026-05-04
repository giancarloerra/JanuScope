import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  createDbSchemaOverlay,
  formatSchema,
  type SchemaSnapshot,
} from "../../src/overlays/db-schema/index.js";
import { Pipeline } from "../../src/pipeline.js";
import type { JsonRpcMessage } from "../../src/rpc.js";
import type { Driver } from "../../src/overlays/db-schema/types.js";

function setupSqliteDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcpo-dbschema-"));
  const path = join(dir, "test.db");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL,
      ssn TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL,
      total REAL NOT NULL,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );
    CREATE TABLE _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);
  db.close();
  return path;
}

function makePipeline(overlay: ReturnType<typeof createDbSchemaOverlay>): {
  pipeline: Pipeline;
  toClient: JsonRpcMessage[];
} {
  const toClient: JsonRpcMessage[] = [];
  const pipeline = new Pipeline([overlay], {
    onForwardToTarget: () => {},
    onForwardToClient: (m) => toClient.push(m),
    log: () => {},
  });
  return { pipeline, toClient };
}

describe("dbSchema overlay: SQLite introspection", () => {
  it("lists tables and columns for a SQLite DB", async () => {
    const path = setupSqliteDb();
    const overlay = createDbSchemaOverlay({
      driver: "sqlite",
      connectionString: path,
      tables: ["customers", "orders"],
    });
    const { pipeline, toClient } = makePipeline(overlay);
    await pipeline.start();

    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "query", description: "Run SQL." }] },
    });
    const resp = toClient[0] as { result: { tools: Array<{ description: string }> } };
    expect(resp.result.tools[0]!.description).toContain("Run SQL.");
    expect(resp.result.tools[0]!.description).toContain("customers");
    expect(resp.result.tools[0]!.description).toContain("orders");
    expect(resp.result.tools[0]!.description).toContain("Foreign keys");
    await pipeline.stop();
  });

  it("respects excludeTables", async () => {
    const path = setupSqliteDb();
    const overlay = createDbSchemaOverlay({
      driver: "sqlite",
      connectionString: path,
      excludeTables: ["_migrations"],
    });
    const { pipeline, toClient } = makePipeline(overlay);
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "query", description: "x" }] },
    });
    const desc = (toClient[0] as { result: { tools: Array<{ description: string }> } }).result
      .tools[0]!.description;
    expect(desc).toContain("customers");
    expect(desc).toContain("orders");
    expect(desc).not.toContain("_migrations");
    await pipeline.stop();
  });

  it("only injects into tools named in injectInto", async () => {
    const path = setupSqliteDb();
    const overlay = createDbSchemaOverlay({
      driver: "sqlite",
      connectionString: path,
      injectInto: ["query"],
    });
    const { pipeline, toClient } = makePipeline(overlay);
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          { name: "query", description: "run" },
          { name: "echo", description: "echo" },
        ],
      },
    });
    const tools = (
      toClient[0] as { result: { tools: Array<{ name: string; description: string }> } }
    ).result.tools;
    expect(tools.find((t) => t.name === "query")!.description).toContain("customers");
    expect(tools.find((t) => t.name === "echo")!.description).toBe("echo");
    await pipeline.stop();
  });

  it("uses default injectInto list when none is provided", async () => {
    const path = setupSqliteDb();
    const overlay = createDbSchemaOverlay({
      driver: "sqlite",
      connectionString: path,
    });
    const { pipeline, toClient } = makePipeline(overlay);
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          { name: "execute_sql", description: "e" },
          { name: "unrelated", description: "u" },
        ],
      },
    });
    const tools = (
      toClient[0] as { result: { tools: Array<{ name: string; description: string }> } }
    ).result.tools;
    expect(tools.find((t) => t.name === "execute_sql")!.description).toContain("customers");
    expect(tools.find((t) => t.name === "unrelated")!.description).toBe("u");
    await pipeline.stop();
  });

  it("infers driver from connectionString", async () => {
    const path = setupSqliteDb();
    const overlay = createDbSchemaOverlay({
      connectionString: path, // .db suffix -> sqlite
    });
    const { pipeline, toClient } = makePipeline(overlay);
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "query", description: "x" }] },
    });
    const desc = (toClient[0] as { result: { tools: Array<{ description: string }> } }).result
      .tools[0]!.description;
    expect(desc).toContain("customers");
    await pipeline.stop();
  });

  it("throws when driver cannot be inferred", () => {
    expect(() => createDbSchemaOverlay({ connectionString: "wat://unknown" })).toThrow(
      /cannot infer driver/,
    );
  });

  it("setup failure surfaces as a clear error", async () => {
    const overlay = createDbSchemaOverlay({
      driver: "sqlite",
      connectionString: "/path/does/not/exist.db",
    });
    const { pipeline } = makePipeline(overlay);
    await expect(pipeline.start()).rejects.toThrow(/dbSchema overlay setup failed/);
  });
});

describe("dbSchema overlay: format output", () => {
  const snapshot: SchemaSnapshot = {
    dialect: "sqlite",
    tables: [
      {
        name: "users",
        comment: "App users",
        columns: [
          { name: "id", type: "integer", nullable: false, defaultValue: null, comment: null },
          { name: "email", type: "text", nullable: false, defaultValue: null, comment: "unique" },
        ],
        primaryKey: ["id"],
        foreignKeys: [],
      },
    ],
  };

  it("markdown format includes table header, columns, PK", () => {
    const md = formatSchema(snapshot, "markdown");
    expect(md).toContain("### Database schema");
    expect(md).toContain("Table: `users`");
    expect(md).toContain("App users");
    expect(md).toContain("`email`");
    expect(md).toContain("Primary key");
  });

  it("ddl format produces CREATE TABLE", () => {
    const ddl = formatSchema(snapshot, "ddl");
    expect(ddl).toContain("CREATE TABLE users");
    expect(ddl).toContain("id INTEGER NOT NULL");
    expect(ddl).toContain("PRIMARY KEY (id)");
  });

  it("compact format is concise", () => {
    const compact = formatSchema(snapshot, "compact");
    expect(compact).toContain("users(");
    expect(compact).toContain("email:text!");
    expect(compact.length).toBeLessThan(formatSchema(snapshot, "markdown").length);
  });

  it("escapes pipe chars in markdown table cells", () => {
    const snap: SchemaSnapshot = {
      dialect: "sqlite",
      tables: [
        {
          name: "t",
          comment: null,
          columns: [
            {
              name: "c",
              type: "text",
              nullable: true,
              defaultValue: "a|b",
              comment: "x|y",
            },
          ],
          primaryKey: [],
          foreignKeys: [],
        },
      ],
    };
    const md = formatSchema(snap, "markdown");
    expect(md).toContain("a\\|b");
    expect(md).toContain("x\\|y");
  });
});

describe("dbSchema overlay: driver dependency injection", () => {
  it("accepts a stub driver for testing without real DB", async () => {
    const stub: Driver = {
      async introspect() {
        return {
          dialect: "postgres",
          tables: [
            {
              name: "widgets",
              comment: "gadgets",
              columns: [
                { name: "id", type: "bigint", nullable: false, defaultValue: null, comment: null },
              ],
              primaryKey: ["id"],
              foreignKeys: [],
            },
          ],
        };
      },
    };

    const overlay = createDbSchemaOverlay({
      driver: "postgres",
      connectionString: "postgresql://unused",
      drivers: { postgres: stub },
    });
    const { pipeline, toClient } = makePipeline(overlay);
    await pipeline.start();
    await pipeline.handleServerMessage({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "query", description: "q" }] },
    });
    const desc = (toClient[0] as { result: { tools: Array<{ description: string }> } }).result
      .tools[0]!.description;
    expect(desc).toContain("widgets");
    expect(desc).toContain("gadgets");
    await pipeline.stop();
  });

  it("passes dbSchema.schemas through to the driver's IntrospectOptions", async () => {
    // Multi-schema Postgres deployments need to specify which namespaces
    // to introspect. Before 2026-04-18 the driver hardcoded `public` and
    // silently returned zero tables for any other schema. This test
    // pins that the config flows to the driver intact.
    let seenOptions: { schemas?: string[] } | null = null;
    const stub: Driver = {
      async introspect(_conn, opts) {
        seenOptions = opts;
        return { dialect: "postgres", tables: [] };
      },
    };
    const overlay = createDbSchemaOverlay({
      driver: "postgres",
      connectionString: "postgresql://unused",
      schemas: ["analytics", "core"],
      drivers: { postgres: stub },
    });
    const { pipeline } = makePipeline(overlay);
    await pipeline.start();
    await pipeline.stop();
    expect(seenOptions).not.toBeNull();
    expect(seenOptions!.schemas).toEqual(["analytics", "core"]);
  });

  it("omits schemas from IntrospectOptions when config didn't set it", async () => {
    // Backwards compatibility: drivers that predate the schemas option
    // must still receive an opts object without a spurious schemas key.
    let seenOptions: { schemas?: string[] } | null = null;
    const stub: Driver = {
      async introspect(_conn, opts) {
        seenOptions = opts;
        return { dialect: "postgres", tables: [] };
      },
    };
    const overlay = createDbSchemaOverlay({
      driver: "postgres",
      connectionString: "postgresql://unused",
      drivers: { postgres: stub },
    });
    const { pipeline } = makePipeline(overlay);
    await pipeline.start();
    await pipeline.stop();
    expect(seenOptions).not.toBeNull();
    expect("schemas" in (seenOptions as object)).toBe(false);
  });
});
