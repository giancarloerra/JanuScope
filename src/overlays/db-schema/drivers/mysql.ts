// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * MySQL driver: introspect via information_schema using `mysql2`.
 */

import type { Driver, IntrospectOptions, SchemaSnapshot, TableInfo } from "../types.js";

interface Mysql2Connection {
  query: <T = unknown>(sql: string, values?: unknown[]) => Promise<[T[], unknown]>;
  end: () => Promise<void>;
}

interface Mysql2PromiseApi {
  createConnection: (uri: string | object) => Promise<Mysql2Connection>;
}

interface Mysql2Module {
  default?: Mysql2PromiseApi;
  createConnection?: Mysql2PromiseApi["createConnection"];
}

export const mysqlDriver: Driver = {
  async introspect(connectionString: string, opts: IntrospectOptions): Promise<SchemaSnapshot> {
    const api = await loadMysql();
    const conn = await api.createConnection(connectionString);
    try {
      const [dbRows] = await conn.query<{ db: string }>("SELECT DATABASE() AS db");
      const database = dbRows[0]?.db;
      if (!database) {
        throw new Error("cannot introspect: connection string does not specify a database");
      }

      const [tableRows] = await conn.query<{ TABLE_NAME: string; TABLE_COMMENT: string | null }>(
        `SELECT TABLE_NAME, TABLE_COMMENT
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ?
           AND TABLE_TYPE IN ('BASE TABLE', 'VIEW')
         ORDER BY TABLE_NAME`,
        [database],
      );

      const allowed = filterTableNames(
        tableRows.map((r) => r.TABLE_NAME),
        opts,
      );

      const tables: TableInfo[] = [];
      for (const tableName of allowed) {
        const tableComment =
          tableRows.find((r) => r.TABLE_NAME === tableName)?.TABLE_COMMENT ?? null;
        const columns = await fetchColumns(conn, database, tableName, opts);
        const primaryKey = await fetchPrimaryKey(conn, database, tableName);
        const foreignKeys = await fetchForeignKeys(conn, database, tableName);
        tables.push({
          name: tableName,
          comment: tableComment && tableComment.length > 0 ? tableComment : null,
          columns,
          primaryKey,
          foreignKeys,
        });
      }
      return { dialect: "mysql", tables };
    } finally {
      await conn.end();
    }
  },
};

function filterTableNames(names: string[], opts: IntrospectOptions): string[] {
  if (opts.tables) {
    const wanted = new Set(opts.tables);
    return names.filter((n) => wanted.has(n));
  }
  if (opts.excludeTables) {
    const excluded = new Set(opts.excludeTables);
    return names.filter((n) => !excluded.has(n));
  }
  return names;
}

async function fetchColumns(
  conn: Mysql2Connection,
  db: string,
  tableName: string,
  opts: IntrospectOptions,
): Promise<TableInfo["columns"]> {
  const [rows] = await conn.query<{
    COLUMN_NAME: string;
    COLUMN_TYPE: string;
    IS_NULLABLE: "YES" | "NO";
    COLUMN_DEFAULT: string | null;
    COLUMN_COMMENT: string | null;
  }>(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [db, tableName],
  );

  return rows.map((r) => ({
    name: r.COLUMN_NAME,
    type: r.COLUMN_TYPE,
    nullable: r.IS_NULLABLE === "YES",
    defaultValue: r.COLUMN_DEFAULT,
    comment:
      opts.includeComments === false
        ? null
        : r.COLUMN_COMMENT && r.COLUMN_COMMENT.length > 0
          ? r.COLUMN_COMMENT
          : null,
  }));
}

async function fetchPrimaryKey(
  conn: Mysql2Connection,
  db: string,
  tableName: string,
): Promise<string[]> {
  const [rows] = await conn.query<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
     ORDER BY SEQ_IN_INDEX`,
    [db, tableName],
  );
  return rows.map((r) => r.COLUMN_NAME);
}

async function fetchForeignKeys(
  conn: Mysql2Connection,
  db: string,
  tableName: string,
): Promise<TableInfo["foreignKeys"]> {
  const [rows] = await conn.query<{
    COLUMN_NAME: string;
    REFERENCED_TABLE_NAME: string;
    REFERENCED_COLUMN_NAME: string;
  }>(
    `SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
     FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
     ORDER BY ORDINAL_POSITION`,
    [db, tableName],
  );
  return rows.map((r) => ({
    column: r.COLUMN_NAME,
    referencesTable: r.REFERENCED_TABLE_NAME,
    referencesColumn: r.REFERENCED_COLUMN_NAME,
  }));
}

async function loadMysql(): Promise<Mysql2PromiseApi> {
  try {
    const mod = (await import("mysql2/promise")) as unknown as Mysql2Module;
    if (mod.default) return mod.default;
    if (typeof mod.createConnection === "function") {
      return { createConnection: mod.createConnection };
    }
    throw new Error("mysql2/promise did not export createConnection");
  } catch (err) {
    if (err instanceof Error && /did not export/.test(err.message)) throw err;
    throw new Error(
      "MySQL support requires the optional dependency 'mysql2'. " +
        "Install it with: npm install mysql2",
    );
  }
}
