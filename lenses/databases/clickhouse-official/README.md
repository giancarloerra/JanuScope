---
mcp: "mcp-clickhouse"
mcpUrl: https://github.com/ClickHouse/mcp-clickhouse
testedVersion: "pypi latest 2026-04"
testedAt: "2026-04-19"
maintainer: "@giancarloerra"
category: databases
status: probed
tags: [clickhouse, sql, analytics, readonly, olap]
---

# ClickHouse (official `mcp-clickhouse`) — JanuScope Lens

Wraps [`ClickHouse/mcp-clickhouse`](https://github.com/ClickHouse/mcp-clickhouse), ClickHouse Inc.'s official MCP server ([pypi](https://pypi.org/project/mcp-clickhouse/)). The upstream MCP is read-only by default; writes require an explicit server-side flag. This lens keeps you safe even if that flag flips.

Tool surface: `list_databases`, `list_tables`, `run_query`. `sqlGuard` guards `run_query`; `run_chdb_select_query` and `run_select_query` are forward-looking entries for older releases and community forks.

## What this lens does

- **`instructions`** — read-only policy with analytics-specific guidance ("prefer aggregates over row-level enumeration — column-store engines are optimised for aggregates")
- **`sqlGuard`** — blocks standard write keywords **plus** ClickHouse-specific ones (`OPTIMIZE`, `DETACH`, `ATTACH`, `KILL`, `SYSTEM`) that the default keyword list doesn't cover
- **`redact`** — email, SSN, Stripe/AWS key patterns plus PII column names
- **`audit`** — JSONL log at `~/mcp-audit-clickhouse.jsonl`

No `dbSchema` by default — ClickHouse datasets tend to be very wide and deep, and pre-injecting the full schema can bloat the tool description. If you want it for a specific use case, add `dbSchema:` with a `tables:` allowlist.

## Tool names this lens assumes

The official ClickHouse MCP exposes `run_query` (main SQL tool) and `run_chdb_select_query` (embedded chDB). Some older releases and community forks use `run_select_query`. The Lens's `sqlGuard.tools` list covers all three so coverage survives forks and version drift — sqlGuard only fires when the named tool is actually called, so listing a tool that isn't present costs nothing.

## Prerequisites

- **Read-only ClickHouse user at the data path** (layer 3, mandatory for production). Provision a user with the `readonly` setting profile (or `readonly = 1` for SELECT-only without setting changes; `readonly = 2` to also forbid changing settings via SET). `CREATE USER lens_ro IDENTIFIED BY '...' SETTINGS PROFILE 'readonly';` then `GRANT SELECT ON db.* TO lens_ro;`. Use those credentials in `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD`. JanuScope's allowlist-mode sqlGuard and SURFACE BOUNDARY policy are layers 1 and 2 (defence in depth); only the user profile physically prevents INSERT / ALTER / DROP / TRUNCATE / OPTIMIZE / KILL / SYSTEM if the agent host runs `clickhouse-client` or `curl` against the HTTP interface. See [SECURITY.md](../../../SECURITY.md#three-layer-model) for the full model.

## Customising

Required environment variables:

| Variable              | Purpose                                     |
| --------------------- | ------------------------------------------- |
| `CLICKHOUSE_HOST`     | Hostname (no scheme)                        |
| `CLICKHOUSE_PORT`     | Usually `8443` (HTTPS) or `8123` (HTTP)     |
| `CLICKHOUSE_USER`     | **Use a read-only user** if at all possible |
| `CLICKHOUSE_PASSWORD` | Password                                    |
| `CLICKHOUSE_DATABASE` | Default database                            |

Strong recommendation: connect as a **read-only ClickHouse user** (`CREATE USER reader IDENTIFIED WITH ... SETTINGS readonly = 1`). That's the physical backstop that makes a bug in the proxy harmless.

## Usage

```json
{
  "mcpServers": {
    "clickhouse": {
      "command": "januscope",
      "args": ["--config", "/absolute/path/to/clickhouse-official/config.yaml"]
    }
  }
}
```

## Changelog

- **2026-04-19** — Re-probed against live `tools/list`.
- **2026-04-17** — Initial contribution (@giancarloerra).
