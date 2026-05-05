---
mcp: "Oracle SQLcl MCP Server (built into SQLcl 25.4+)"
mcpUrl: https://docs.oracle.com/en/database/oracle/sql-developer-command-line/26.1/sqcug/using-oracle-sqlcl-mcp-server.html
testedVersion: "SQLcl 26.1.0.0 / sqlcl-mcp-server 1.0.0"
testedAt: "2026-05-05"
maintainer: "@giancarloerra"
category: databases
status: probed
tags: [oracle, sqlcl, jdbc, readonly]
---

# Oracle Database (via Oracle SQLcl MCP) — JanuScope Lens

Wraps the [Oracle SQLcl](https://www.oracle.com/database/sqldeveloper/technologies/sqlcl/)
built-in MCP server (SQLcl 25.4+). SQLcl is Oracle's command-line client
for Oracle Database; from version 25.4 it ships an MCP server that
exposes saved connections, schema metadata, and SQL execution as MCP
tools.

This lens locks the surface to read-only by:

1. **Blocking `run-sqlcl`** — the SQLcl meta-command tool can execute
   `HOST` (shell escape), `SPOOL`, `SCRIPT/START`, and other client-side
   primitives that have nothing to do with an LLM data path. Hidden
   from the surface entirely.
2. **`sqlGuard`-ing `run-sql`** — the SQL execution tool accepts any
   SQL string. JanuScope's keyword guard rejects statements containing
   `INSERT / UPDATE / DELETE / DROP / CREATE / ALTER / TRUNCATE / GRANT /
MERGE / RENAME / etc.`, letting `SELECT` and `WITH ... SELECT`
   queries through.
3. **Redacting PII** in result frames (CSV from `run-sql`, JSON from
   `schema-information`).
4. **Auditing** every tool call to `~/mcp-audit-oracle.jsonl`.

## What this lens does

- **`block`** — `run-sqlcl` (SQLcl meta-commands incl shell escape).
- **`sqlGuard`** — `run-sql` only, `sqlArg: sql`, `readOnly: true`.
- **`instructions`** — read-only banner reminding the LLM to use
  `list-connections` → `connect` → `schema-information` → `run-sql`.
- **`redact`** — field-path rules on common PII field names (lower
  AND upper case for Oracle's default UPPERCASE identifier folding)
  plus value-shape regexes for SSN and PAN-shaped digit runs.
- **`audit`** — JSONL compliance log at `~/mcp-audit-oracle.jsonl`.

No `dbSchema`: SQLcl's own `schema-information` tool exposes the same
data on demand and is the canonical path the MCP advertises to clients.

## Tool names this lens assumes

Probed against SQLcl 26.1 / sqlcl-mcp-server 1.0.0 on 2026-05-05:

| Tool                       | Kind            | Treatment       |
| -------------------------- | --------------- | --------------- |
| `list-connections`         | read (metadata) | passes through  |
| `connect`                  | state           | passes through  |
| `disconnect`               | state           | passes through  |
| `schema-information`       | read (metadata) | passes through  |
| `dbtools-get-tool-request` | read (status)   | passes through  |
| `run-sql`                  | arbitrary SQL   | **sqlGuard ed** |
| `run-sqlcl`                | arbitrary CLI   | **blocked**     |

## Prerequisites

1. **Oracle SQLcl 25.4 or later** on PATH (the lens spawns `sql -mcp`):
   - Download: <https://www.oracle.com/database/sqldeveloper/technologies/sqlcl/download/>
   - Or direct: `https://download.oracle.com/otn_software/java/sqldeveloper/sqlcl-latest.zip`
   - Unzip and put `<sqlcl-dir>/bin` on PATH.
   - Verify: `sql -V` should print `SQLcl: Release 25.4 Production` or
     newer.
2. **A SQLcl named connection** for the database the LLM may read:
   ```bash
   sql /nolog
   SQL> connect -save my-readonly-conn -savepwd readonly_user/<pwd>@//host:port/SERVICE
   SQL> exit
   ```
   The MCP's `list-connections` tool will return `my-readonly-conn`;
   the LLM uses `connect my-readonly-conn` before running queries.
3. **A read-only Oracle user at the data path** (layer 3, mandatory
   for production). The `sqlGuard` overlay rejects writes at the
   proxy, but the database role is the only thing that physically
   prevents writes if anything else (SQLDeveloper, sqlplus, a CI
   job) connects to the same DB. Provision the user with `CREATE
SESSION` and `SELECT` on the schemas the LLM should see; do not
   grant `INSERT / UPDATE / DELETE / CREATE` even on the lens's own
   workspace. See [SECURITY.md](../../../SECURITY.md#three-layer-model).

## Customising

SQLcl reads its connection definitions from your local SQLcl
configuration (managed via `connmgr`). JanuScope does not relay or
rename any credentials — whatever SQLcl saves locally, it keeps using.
There are no MCP-specific environment variables.

If you need to point SQLcl at a non-default config directory, set
`SQLCL_HOME` or `JAVA_TOOL_OPTIONS` per Oracle's docs; both pass
through to the spawned target unchanged.

## Usage

```json
{
  "mcpServers": {
    "oracle-db": {
      "command": "januscope",
      "args": ["--config", "oracle-db-sqlcl"]
    }
  }
}
```

The lens spawns `sql -mcp` directly; SQLcl picks up the saved
connection from your user-level SQLcl config.

## Probe transcript (2026-05-05)

A live `tools/list` against `sql -mcp` returned the seven tools shown
in the table above. The probe was driven against Oracle Database 26ai
Free Release 23.26.1.0.0 running in `gvenzl/oracle-free` on Docker
Desktop. The lens config blocks `run-sqlcl` outright and applies
keyword-level write guards to `run-sql`, leaving `list-connections`,
`connect`, `disconnect`, `schema-information`, `dbtools-get-tool-request`,
and the read-only-shaped `run-sql` available to the LLM.

## Note on the protocol-version handshake

SQLcl 26.1's MCP server speaks MCP protocol `2024-11-05` rather than
the latest `2025-06-18`. JanuScope is protocol-agnostic and does not
re-negotiate the version. If your MCP client requests `2025-06-18`,
SQLcl downgrades the response to `2024-11-05` with a
`WARNING: Client requested unsupported protocol version` log line on
stderr. This is benign — JanuScope drops the stderr line and the
session proceeds normally on the older protocol.

## Changelog

- **2026-05-05** — Initial contribution (@giancarloerra). Probed
  against SQLcl 26.1.0.0 + Oracle Database 26ai Free Release
  23.26.1.0.0 (linux/arm64) on Docker Desktop.
