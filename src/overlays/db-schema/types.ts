// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * Common types for DB schema introspection across drivers.
 */

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  comment: string | null;
}

export interface ForeignKeyInfo {
  column: string;
  referencesTable: string;
  referencesColumn: string;
}

export interface TableInfo {
  name: string;
  comment: string | null;
  columns: ColumnInfo[];
  primaryKey: string[];
  foreignKeys: ForeignKeyInfo[];
}

export interface SchemaSnapshot {
  dialect: "postgres" | "mysql" | "sqlite";
  tables: TableInfo[];
}

export interface IntrospectOptions {
  tables?: string[];
  excludeTables?: string[];
  includeComments?: boolean;
  /**
   * Postgres-specific: which schemas (namespaces) to introspect. If
   * omitted, defaults to `["public"]`. MySQL / SQLite drivers ignore
   * this option — they have a single implicit schema per connection.
   */
  schemas?: string[];
  /**
   * Optional diagnostic sink. When present, drivers route warnings and
   * info messages here instead of `console.*`. The dbSchema overlay
   * wires this to the overlay's `ctx.log`, which is the only logger
   * end users have configured. Tests can pass a no-op or a collector.
   */
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface Driver {
  introspect(connectionString: string, opts: IntrospectOptions): Promise<SchemaSnapshot>;
}
