---
mcp: "Microsoft.DataApiBuilder (DAB) v1.7+ MCP"
mcpUrl: https://github.com/Azure/data-api-builder
testedVersion: "1.7.93"
testedAt: "2026-05-05"
maintainer: "@giancarloerra"
category: databases
status: probed
tags: [mssql, azure-sql, sqlserver, dab, readonly]
---

# Microsoft SQL Server / Azure SQL (via Data API builder) — JanuScope Lens

Wraps [Data API builder (DAB)](https://github.com/Azure/data-api-builder) v1.7+
running in MCP-stdio mode. DAB is Microsoft's open-source CRUD engine for
SQL-family backends; from version 1.7 it ships an MCP server that exposes
configured entities as a small DML toolset.

DAB supports **Azure SQL, SQL Server, Synapse SQLDW, Cosmos DB, PostgreSQL,
and MySQL** as backends — this lens works with any of them, since the MCP
surface is the same regardless of the underlying engine.

## What this lens does

- **`block`** — hides every write-shaped DML tool: `create_record`,
  `update_record`, `delete_record`, and `execute_entity` (which runs
  stored-procedure entities and is treated as write because a SP can
  mutate anything the schema permits).
- **`instructions`** — read-only banner reminding the LLM to call
  `describe_entities` first, then `read_records` for queries.
- **`redact`** — field-path rules for common PII (email, password,
  apiKey, token, ssn, creditCard) plus value-shape fallbacks for
  US SSN and PAN-shaped digit runs.
- **`audit`** — JSONL compliance log at `~/mcp-audit-mssql.jsonl`.

No `sqlGuard` and no `dbSchema`: DAB does NOT expose raw SQL (its design
explicitly rejects NL2SQL in favour of NL2DAB), and `describe_entities`
is the canonical metadata path baked into the MCP itself.

## Tool names this lens assumes

Probed against DAB 1.7.93 with stdio transport on 2026-05-05:

| Tool                | Kind  | Treatment                                |
| ------------------- | ----- | ---------------------------------------- |
| `describe_entities` | read  | passes through                           |
| `read_records`      | read  | passes through                           |
| `aggregate_records` | read  | passes through (when DAB has it enabled) |
| `create_record`     | write | **blocked**                              |
| `update_record`     | write | **blocked**                              |
| `delete_record`     | write | **blocked**                              |
| `execute_entity`    | write | **blocked**                              |

## Prerequisites

- **DAB CLI** installed (.NET 8+ required):
  ```bash
  dotnet tool install -g Microsoft.DataApiBuilder
  ```
- **A working `dab-config.json`** in your working directory (or a path
  passed via `--config`), with entities and **per-role permissions
  defined**. JanuScope's `block` is layer 1; DAB's role-based
  permissions are layer 2; the underlying SQL user's GRANTs are
  layer 3. See [SECURITY.md](../../../SECURITY.md#three-layer-model).
- **A read-only SQL user at the data path** is the strongest backstop.
  In SQL Server: `CREATE LOGIN ai_readonly ...; GRANT SELECT ON SCHEMA::dbo TO ai_readonly;`
  Use that login in your DAB connection string.

## Customising

DAB reads its connection string from the `dab-config.json` file (or
`@env('VAR_NAME')` references inside it). JanuScope does not rename or
relay the connection details; whatever DAB itself reads, it keeps
reading. There are no MCP-specific env vars beyond DAB's own.

Common DAB env vars you may set in your MCP-client config (these are
DAB's, not the lens's):

| Variable                                                                              | Purpose                                              |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `DAB_ENVIRONMENT`                                                                     | Picks `dab-config.<env>.json` instead of the default |
| Anything used in your dab-config.json via `@env('...')` (DB connection strings, etc.) | Read by DAB via .env / process env                   |

## Usage

```json
{
  "mcpServers": {
    "mssql": {
      "command": "januscope",
      "args": ["--config", "mssql-azure-dab"],
      "cwd": "/path/to/your/dab-project",
      "env": {
        "DAB_ENVIRONMENT": "Production"
      }
    }
  }
}
```

`cwd` should be the directory containing your `dab-config.json`.
Alternatively, embed `--config /abs/path/to/dab-config.json` in the
lens's `target.args` if you prefer to keep DAB's config out of the
working directory.

## Probe transcript (2026-05-05)

A live `tools/list` against `dab start --mcp-stdio` returned the seven
tools listed above against a Customers entity in Azure SQL Edge
(Docker). The tools/list response was used verbatim to populate this
file's tool table — if a future DAB release renames or adds tools, the
lens will continue to block any tool whose name matches the existing
write-shaped names, but a re-probe is the right way to confirm the
surface hasn't drifted.

## Changelog

- **2026-05-05** — Initial contribution (@giancarloerra). Probed against
  DAB 1.7.93 + Azure SQL Edge 1.0.7 (linux/arm64) on Docker Desktop.
