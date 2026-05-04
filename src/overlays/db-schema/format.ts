// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * Formatters for a SchemaSnapshot. Each format is an independent function
 * that takes a snapshot and returns a string suitable for splicing into a
 * tool description.
 */

import type { SchemaSnapshot, TableInfo } from "./types.js";

export type SchemaFormat = "markdown" | "ddl" | "compact";

export function formatSchema(snapshot: SchemaSnapshot, format: SchemaFormat): string {
  switch (format) {
    case "markdown":
      return formatMarkdown(snapshot);
    case "ddl":
      return formatDdl(snapshot);
    case "compact":
      return formatCompact(snapshot);
  }
}

function formatMarkdown(snapshot: SchemaSnapshot): string {
  const lines: string[] = ["### Database schema", ""];
  for (const table of snapshot.tables) {
    lines.push(`#### Table: \`${table.name}\``);
    if (table.comment) {
      lines.push(table.comment, "");
    } else {
      lines.push("");
    }
    lines.push("| Column | Type | Null | Default | Comment |");
    lines.push("|--------|------|------|---------|---------|");
    for (const col of table.columns) {
      const nullable = col.nullable ? "YES" : "NO";
      const def = col.defaultValue ?? "";
      const comment = col.comment ?? "";
      lines.push(
        `| \`${col.name}\` | ${col.type} | ${nullable} | ${escapeCell(def)} | ${escapeCell(comment)} |`,
      );
    }
    if (table.primaryKey.length > 0) {
      lines.push("", `**Primary key:** \`${table.primaryKey.join(", ")}\``);
    }
    if (table.foreignKeys.length > 0) {
      const fks = table.foreignKeys
        .map((fk) => `\`${fk.column}\` → \`${fk.referencesTable}.${fk.referencesColumn}\``)
        .join("; ");
      lines.push(`**Foreign keys:** ${fks}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function formatDdl(snapshot: SchemaSnapshot): string {
  return snapshot.tables.map(tableDdl).join("\n\n");
}

function tableDdl(table: TableInfo): string {
  const colLines = table.columns.map((col) => {
    const nullable = col.nullable ? "" : " NOT NULL";
    const def = col.defaultValue ? ` DEFAULT ${col.defaultValue}` : "";
    return `  ${col.name} ${col.type.toUpperCase()}${nullable}${def}`;
  });
  const pk = table.primaryKey.length > 0 ? [`  PRIMARY KEY (${table.primaryKey.join(", ")})`] : [];
  const fks = table.foreignKeys.map(
    (fk) => `  FOREIGN KEY (${fk.column}) REFERENCES ${fk.referencesTable}(${fk.referencesColumn})`,
  );
  const body = [...colLines, ...pk, ...fks].join(",\n");
  return `CREATE TABLE ${table.name} (\n${body}\n);`;
}

function formatCompact(snapshot: SchemaSnapshot): string {
  const lines = snapshot.tables.map((table) => {
    const fkByCol = new Map<string, string>();
    for (const fk of table.foreignKeys) {
      fkByCol.set(fk.column, `${fk.referencesTable}.${fk.referencesColumn}`);
    }
    const pkSet = new Set(table.primaryKey);
    const parts = table.columns.map((col) => {
      const nullMark = col.nullable ? "" : "!";
      const pkMark = pkSet.has(col.name) ? "🔑" : "";
      const fkTarget = fkByCol.get(col.name);
      const fkPart = fkTarget ? `→${fkTarget}` : "";
      return `${col.name}${pkMark}:${col.type}${nullMark}${fkPart}`;
    });
    return `${table.name}(${parts.join(", ")})`;
  });
  return lines.join("\n");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
