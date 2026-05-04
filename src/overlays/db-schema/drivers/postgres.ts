// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * Postgres driver: introspect via information_schema + pg_catalog using
 * the `pg` package.
 *
 * The driver is imported lazily so users who don't use Postgres don't need
 * `pg` installed.
 */

import type { Driver, IntrospectOptions, SchemaSnapshot, TableInfo } from "../types.js";

interface PgClient {
  connect: () => Promise<void>;
  query: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  end: () => Promise<void>;
}

interface PgClientConstructor {
  new (config: string | { connectionString: string }): PgClient;
}

interface PgModule {
  Client: PgClientConstructor;
}

export const postgresDriver: Driver = {
  async introspect(connectionString: string, opts: IntrospectOptions): Promise<SchemaSnapshot> {
    const pg = await loadPg();
    const client = new pg.Client({ connectionString });
    await client.connect();

    // Which schemas to introspect. Defaults to `public` for backwards
    // compatibility, but multi-schema deployments (enterprise, multi-
    // tenant, Laravel with `app` namespace, analytics warehouses with
    // `core` / `analytics` etc.) can list any combination via the
    // dbSchema.schemas config option.
    const schemas = opts.schemas && opts.schemas.length > 0 ? opts.schemas : ["public"];

    try {
      const tableRows = await client.query<{
        table_schema: string;
        table_name: string;
        comment: string | null;
      }>(
        `SELECT n.nspname AS table_schema,
                c.relname  AS table_name,
                obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ANY($1::text[])
           AND c.relkind IN ('r', 'v')
         ORDER BY n.nspname, c.relname`,
        [schemas],
      );

      // Iterate rows (not names) so each surviving entry keeps its
      // schema context. Two schemas can legitimately hold a table with
      // the same name (e.g. `analytics.users` + `core.users`); looking
      // the row back up by table_name alone would silently pick one
      // arbitrarily and run the column / PK / FK queries against the
      // wrong schema.
      const allowedRows = filterTableRows(tableRows.rows, opts);

      if (allowedRows.length === 0) {
        opts.log?.(
          "warn",
          `postgres: 0 tables found in schema(s) [${schemas.join(", ")}] — ` +
            `check dbSchema.schemas config if your tables live under a different namespace.`,
        );
      }

      const tables: TableInfo[] = [];
      for (const row of allowedRows) {
        const tableName = row.table_name;
        const schemaName = row.table_schema;
        const tableComment = row.comment ?? null;
        const columns = await fetchColumns(client, tableName, schemaName, opts);
        const primaryKey = await fetchPrimaryKey(client, tableName, schemaName);
        const foreignKeys = await fetchForeignKeys(client, tableName, schemaName);
        // If the caller introspects multiple schemas and the same name
        // appears in more than one, prefix the schema so downstream
        // formatters can tell them apart.
        const qualifiedName =
          schemas.length > 1 &&
          allowedRows.some((r) => r.table_name === tableName && r.table_schema !== schemaName)
            ? `${schemaName}.${tableName}`
            : tableName;
        tables.push({
          name: qualifiedName,
          comment: tableComment,
          columns,
          primaryKey,
          foreignKeys,
        });
      }

      return { dialect: "postgres", tables };
    } finally {
      await client.end();
    }
  },
};

interface PgTableRow {
  table_schema: string;
  table_name: string;
  comment: string | null;
}

/**
 * Applies the caller's table / excludeTables filter at the row level
 * so multi-schema deployments whose schemas share table names don't
 * collapse to whichever row a later `.find()` picked first.
 */
function filterTableRows(rows: readonly PgTableRow[], opts: IntrospectOptions): PgTableRow[] {
  if (opts.tables) {
    const wanted = new Set(opts.tables);
    return rows.filter((r) => wanted.has(r.table_name));
  }
  if (opts.excludeTables) {
    const excluded = new Set(opts.excludeTables);
    return rows.filter((r) => !excluded.has(r.table_name));
  }
  return [...rows];
}

async function fetchColumns(
  client: PgClient,
  tableName: string,
  schemaName: string,
  opts: IntrospectOptions,
): Promise<TableInfo["columns"]> {
  const { rows } = await client.query<{
    column_name: string;
    data_type: string;
    is_nullable: "YES" | "NO";
    column_default: string | null;
    description: string | null;
  }>(
    `SELECT c.column_name,
            c.data_type,
            c.is_nullable,
            c.column_default,
            pg_catalog.col_description(cls.oid, c.ordinal_position::int) AS description
     FROM information_schema.columns c
     JOIN pg_class cls ON cls.relname = c.table_name
     JOIN pg_namespace n ON n.oid = cls.relnamespace AND n.nspname = c.table_schema
     WHERE c.table_schema = $2 AND c.table_name = $1
     ORDER BY c.ordinal_position`,
    [tableName, schemaName],
  );

  return rows.map((r) => ({
    name: r.column_name,
    type: r.data_type,
    nullable: r.is_nullable === "YES",
    defaultValue: r.column_default,
    comment: opts.includeComments === false ? null : r.description,
  }));
}

async function fetchPrimaryKey(
  client: PgClient,
  tableName: string,
  schemaName: string,
): Promise<string[]> {
  const { rows } = await client.query<{ column_name: string }>(
    `SELECT a.attname AS column_name
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indrelid
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $2 AND c.relname = $1 AND i.indisprimary
     ORDER BY a.attnum`,
    [tableName, schemaName],
  );
  return rows.map((r) => r.column_name);
}

async function fetchForeignKeys(
  client: PgClient,
  tableName: string,
  schemaName: string,
): Promise<TableInfo["foreignKeys"]> {
  // Correlate FK columns with their referenced columns by position so
  // composite foreign keys (a,b) -> (x,y) produce pairs a->x and b->y
  // rather than the Cartesian product produced by joining on
  // constraint_name alone.
  const { rows } = await client.query<{
    column_name: string;
    foreign_table: string;
    foreign_column: string;
  }>(
    `SELECT kcu.column_name,
            ref_kcu.table_name AS foreign_table,
            ref_kcu.column_name AS foreign_column
     FROM information_schema.table_constraints tc
     JOIN information_schema.referential_constraints rc
       ON rc.constraint_name = tc.constraint_name
      AND rc.constraint_schema = tc.table_schema
     JOIN information_schema.key_column_usage kcu
       ON kcu.constraint_name = tc.constraint_name
      AND kcu.table_schema = tc.table_schema
     JOIN information_schema.key_column_usage ref_kcu
       ON ref_kcu.constraint_name = rc.unique_constraint_name
      AND ref_kcu.constraint_schema = rc.unique_constraint_schema
      AND ref_kcu.ordinal_position = kcu.position_in_unique_constraint
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = $2
       AND tc.table_name = $1
     ORDER BY kcu.ordinal_position`,
    [tableName, schemaName],
  );

  return rows.map((r) => ({
    column: r.column_name,
    referencesTable: r.foreign_table,
    referencesColumn: r.foreign_column,
  }));
}

async function loadPg(): Promise<PgModule> {
  try {
    return (await import("pg")) as unknown as PgModule;
  } catch {
    throw new Error(
      "Postgres support requires the optional dependency 'pg'. " +
        "Install it with: npm install pg",
    );
  }
}
