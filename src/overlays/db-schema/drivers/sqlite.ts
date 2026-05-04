// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * SQLite driver: introspect via `better-sqlite3` using PRAGMA statements.
 *
 * Connection strings accepted:
 *   sqlite:///absolute/path/db.sqlite
 *   sqlite:/absolute/path/db.sqlite
 *   sqlite::memory:
 *   plain file path /tmp/x.db
 */

import type { Driver, IntrospectOptions, SchemaSnapshot, TableInfo } from "../types.js";

interface SqliteDatabase {
  prepare: (sql: string) => {
    all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown;
  };
  close: () => void;
}

interface SqliteConstructor {
  new (path: string, options?: { readonly?: boolean }): SqliteDatabase;
}

interface SqliteModule {
  default: SqliteConstructor;
}

export const sqliteDriver: Driver = {
  async introspect(connectionString: string, opts: IntrospectOptions): Promise<SchemaSnapshot> {
    const { default: Database } = await loadSqlite();
    const path = parseConnectionString(connectionString);
    const db = new Database(path, { readonly: true });

    try {
      const tables = listTables(db, opts);
      return { dialect: "sqlite", tables };
    } finally {
      db.close();
    }
  },
};

function parseConnectionString(connectionString: string): string {
  if (connectionString === ":memory:" || connectionString === "sqlite::memory:") {
    return ":memory:";
  }
  if (connectionString.startsWith("sqlite:///")) {
    return "/" + connectionString.slice("sqlite:///".length);
  }
  if (connectionString.startsWith("sqlite://")) {
    return connectionString.slice("sqlite://".length);
  }
  if (connectionString.startsWith("sqlite:")) {
    return connectionString.slice("sqlite:".length);
  }
  return connectionString;
}

function listTables(db: SqliteDatabase, opts: IntrospectOptions): TableInfo[] {
  const allRows = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all() as Array<{ name: string }>;

  const allowed = filterTableNames(
    allRows.map((r) => r.name),
    opts,
  );

  return allowed.map((name) => introspectTable(db, name));
}

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

function introspectTable(db: SqliteDatabase, name: string): TableInfo {
  const info = db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>;

  const columns = info.map((c) => ({
    name: c.name,
    type: c.type,
    nullable: c.notnull === 0,
    defaultValue: c.dflt_value,
    comment: null,
  }));

  const primaryKey = info
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);

  const fkRows = db.prepare(`PRAGMA foreign_key_list(${quoteIdent(name)})`).all() as Array<{
    from: string;
    table: string;
    to: string;
  }>;

  const foreignKeys = fkRows.map((fk) => ({
    column: fk.from,
    referencesTable: fk.table,
    referencesColumn: fk.to,
  }));

  return { name, comment: null, columns, primaryKey, foreignKeys };
}

/**
 * Quote a SQLite identifier by wrapping in double quotes and doubling any
 * internal quote marks. PRAGMA can take a quoted identifier.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function loadSqlite(): Promise<SqliteModule> {
  try {
    // Lazy import so users who don't use SQLite don't need the dep at runtime.
    return (await import("better-sqlite3")) as unknown as SqliteModule;
  } catch {
    throw new Error(
      "SQLite support requires the optional dependency 'better-sqlite3'. " +
        "Install it with: npm install better-sqlite3",
    );
  }
}
