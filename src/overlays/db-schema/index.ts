// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * `dbSchema` overlay.
 *
 * At startup: connect to the configured DB, introspect the schema, format
 * it, and cache the string in overlay state. At runtime: on every
 * `tools/list` response, append the cached schema to the description of
 * tools named in `injectInto`.
 */

import type { Overlay } from "../../pipeline.js";
import { isSuccess, type JsonRpcMessage, type JsonRpcSuccess } from "../../rpc.js";
import { formatSchema, type SchemaFormat } from "./format.js";
import type { Driver, IntrospectOptions, SchemaSnapshot } from "./types.js";
import { postgresDriver } from "./drivers/postgres.js";
import { mysqlDriver } from "./drivers/mysql.js";
import { sqliteDriver } from "./drivers/sqlite.js";

export interface DbSchemaOverlayOptions {
  driver?: "postgres" | "mysql" | "sqlite";
  connectionString: string;
  tables?: string[];
  excludeTables?: string[];
  /**
   * Postgres only: which schemas (namespaces) to introspect. Defaults
   * to `["public"]` when omitted. Ignored by MySQL / SQLite drivers.
   */
  schemas?: string[];
  injectInto?: string[];
  format?: SchemaFormat;
  includeComments?: boolean;
  /** Dependency injection for tests. */
  drivers?: Partial<Record<"postgres" | "mysql" | "sqlite", Driver>>;
}

const DEFAULT_INJECT_INTO = [
  "query",
  "execute",
  "execute_sql",
  "search",
  "pg_query",
  "mysql_query",
  "sql",
];

const SCHEMA_KEY = "formattedSchema";

interface ToolLike {
  name: string;
  description?: string;
  [key: string]: unknown;
}

export function createDbSchemaOverlay(options: DbSchemaOverlayOptions): Overlay {
  const driverName = options.driver ?? inferDriver(options.connectionString);
  if (!driverName) {
    throw new Error(`dbSchema: cannot infer driver from connectionString; set 'driver' explicitly`);
  }

  const registry = {
    postgres: options.drivers?.postgres ?? postgresDriver,
    mysql: options.drivers?.mysql ?? mysqlDriver,
    sqlite: options.drivers?.sqlite ?? sqliteDriver,
  };
  const driver = registry[driverName];

  const injectInto = new Set(options.injectInto ?? DEFAULT_INJECT_INTO);
  const format: SchemaFormat = options.format ?? "markdown";

  const introspectOpts: IntrospectOptions = {
    ...(options.tables ? { tables: options.tables } : {}),
    ...(options.excludeTables ? { excludeTables: options.excludeTables } : {}),
    ...(options.includeComments !== undefined ? { includeComments: options.includeComments } : {}),
    ...(options.schemas ? { schemas: options.schemas } : {}),
  };

  return {
    name: "dbSchema",

    async setup(ctx) {
      try {
        // Route driver-side warnings through the overlay's log sink so
        // users see them alongside the rest of the januscope output
        // instead of bypassing it via console.* (important for hosts
        // that redirect stderr or ship it to a different collector).
        const snapshot: SchemaSnapshot = await driver.introspect(options.connectionString, {
          ...introspectOpts,
          log: (level, message) => ctx.log(level, message),
        });
        const formatted = formatSchema(snapshot, format);
        ctx.state.set(SCHEMA_KEY, formatted);
        ctx.log(
          "info",
          `introspected ${snapshot.tables.length} table(s) (driver=${driverName}, format=${format})`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`dbSchema overlay setup failed: ${message}`, { cause: err });
      }
    },

    onServerMessage(msg, ctx) {
      if (!isToolsListResult(msg)) {
        return { kind: "forward", msg };
      }
      const formatted = ctx.state.get(SCHEMA_KEY);
      if (typeof formatted !== "string" || formatted.length === 0) {
        return { kind: "forward", msg };
      }
      const rewritten = msg.result.tools.map((t) =>
        injectInto.has(t.name) ? appendSchema(t, formatted) : t,
      );
      const newResult: Record<string, unknown> = { ...msg.result, tools: rewritten };
      const out: JsonRpcSuccess = { ...msg, result: newResult };
      return { kind: "forward", msg: out };
    },
  };
}

function appendSchema(tool: ToolLike, schemaBlock: string): ToolLike {
  const existing = typeof tool.description === "string" ? tool.description.trimEnd() : "";
  const description = existing.length > 0 ? `${existing}\n\n${schemaBlock}` : schemaBlock;
  return { ...tool, description };
}

function isToolsListResult(msg: JsonRpcMessage): msg is JsonRpcSuccess & {
  result: { tools: ToolLike[] };
} {
  if (!isSuccess(msg)) return false;
  const result = msg.result;
  if (!result || typeof result !== "object") return false;
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return false;
  return tools.every((t) => t && typeof t === "object" && typeof (t as ToolLike).name === "string");
}

function inferDriver(connectionString: string): "postgres" | "mysql" | "sqlite" | null {
  if (/^postgres(ql)?:\/\//i.test(connectionString)) return "postgres";
  if (/^mysql:\/\//i.test(connectionString)) return "mysql";
  if (/^sqlite:/i.test(connectionString) || connectionString === ":memory:") return "sqlite";
  // Absolute path or file path fallback for SQLite
  if (/\.(db|sqlite|sqlite3)$/i.test(connectionString)) return "sqlite";
  return null;
}

// Re-export types and format for consumers
export type { SchemaSnapshot, TableInfo, ColumnInfo, ForeignKeyInfo } from "./types.js";
export { formatSchema } from "./format.js";
export type { SchemaFormat } from "./format.js";
