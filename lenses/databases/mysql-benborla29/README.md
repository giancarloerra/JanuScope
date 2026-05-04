---
mcp: "@benborla29/mcp-server-mysql"
mcpUrl: https://github.com/benborla/mcp-server-mysql
testedVersion: "2.x"
testedAt: "2026-04-19"
maintainer: "@giancarloerra"
category: databases
status: probed
tags: [mysql, sql, readonly, schema-injection]
---

# MySQL (@benborla29/mcp-server-mysql) — JanuScope Lens

Wraps [`@benborla29/mcp-server-mysql`](https://github.com/benborla/mcp-server-mysql), the most widely-used community MySQL MCP. Exposes a single `mysql_query` tool; mutations are controlled at the MCP layer via `ALLOW_INSERT_OPERATION` / `ALLOW_UPDATE_OPERATION` / `ALLOW_DELETE_OPERATION` / `ALLOW_DDL_OPERATION` env vars (all hardcoded to `false` by this lens). Proxy-layer enforcement is `sqlGuard` on `mysql_query`; the additional write-verb literals in the block list are forward-looking entries for forks that expose tool-level writes.

## What this lens does

Unlike the official Postgres MCP, this server exposes **write-capable tools by default**, so `block` does real work here. All five overlays are used:

- **`block`** — rejects every write-capable tool (`mysql_insert`, `mysql_update`, `mysql_delete`, `mysql_execute`, `create_table`, `drop_table`, etc.)
- **`instructions`** — appends read-only policy text
- **`dbSchema`** — pre-injects the MySQL schema into the `mysql_query` tool description
- **`redact`** — scrubs SSNs, Stripe keys, and `email` / `password` fields
- **`audit`** — JSONL log to `~/mcp-audit-mysql.jsonl`

## Tool names this lens assumes

| Tool                                                          | Kind                  | Treatment                    |
| ------------------------------------------------------------- | --------------------- | ---------------------------- |
| `mysql_query`                                                 | read                  | `dbSchema.injectInto` target |
| `mysql_insert`                                                | write                 | **blocked**                  |
| `mysql_update`                                                | write                 | **blocked**                  |
| `mysql_delete`                                                | write                 | **blocked**                  |
| `mysql_execute`                                               | write (arbitrary SQL) | **blocked**                  |
| `create_table`, `drop_table`, `alter_table`, `truncate_table` | DDL                   | **blocked**                  |

If the MCP version you run exposes other write surfaces — run `tools/list` and add them to `block` with a matching glob if needed. The defensive `"admin_*"` glob already covers any admin-namespaced additions.

## Prerequisites

- **Read-only MySQL user at the data path** (layer 3, mandatory for production). `CREATE USER 'lens_ro'@'%' IDENTIFIED BY '...'; GRANT SELECT ON yourdb.* TO 'lens_ro'@'%';` and use those credentials in `MYSQL_USER` / `MYSQL_PASS`. JanuScope's block list, sqlGuard, the `ALLOW_*_OPERATION=false` flags, and the SURFACE BOUNDARY policy are layers 1 and 2 (defence in depth); only the user-level grants physically prevent writes if the agent host runs `mysql`, `mysqldump`, or another tool surface against the same DB. See [SECURITY.md](../../../SECURITY.md#three-layer-model) for the full model.

## Customising

Required environment variables:

| Variable                   | Purpose                                        |
| -------------------------- | ---------------------------------------------- |
| `MYSQL_HOST`, `MYSQL_PORT` | Connection target                              |
| `MYSQL_USER`, `MYSQL_PASS` | Credentials (use a read-only role if possible) |
| `MYSQL_DB`                 | Database name                                  |

Notes:

- This lens assumes the MCP reads its connection from env vars (its default). If you've wrapped it differently, adapt `target.env`.
- `dbSchema.connectionString` rebuilds a `mysql://` URL from the same env vars so the schema introspector can connect directly — it does not share the MCP's connection.

## Usage

```json
{
  "mcpServers": {
    "analytics_mysql": {
      "command": "januscope",
      "args": ["--config", "/absolute/path/to/mysql-benborla29/config.yaml"]
    }
  }
}
```

## Changelog

- **2026-04-19** — Re-probed against live `tools/list`.
- **2026-04-17** — Initial contribution (@giancarloerra).
