---
mcp: "mcp-sqlite (panasenco community)"
mcpUrl: https://github.com/panasenco/mcp-sqlite
testedVersion: "2026-04"
testedAt: "2026-04-19"
maintainer: "@giancarloerra"
category: databases
status: probed
tags: [sqlite, readonly, schema-injection, pii-redaction, sqlguard, replacement-for-archived-mcp]
---

# SQLite (Panasenco community) — JanuScope Lens

Wraps [`panasenco/mcp-sqlite`](https://github.com/panasenco/mcp-sqlite), the community-maintained Python SQLite MCP. Tool surface: `sqlite_get_catalog` (read) and `sqlite_execute` (arbitrary SQL). `sqlGuard` gates `sqlite_execute`; the additional write-verb globs in the block list cover canned queries that users add via the `--metadata` flag.

## Tool surface

Three categories of tool:

- `sqlite_get_catalog()` — read-only; returns schema + metadata (Datasette-compatible)
- `sqlite_execute(sql)` — arbitrary SQL, reads or writes depending on the statement
- **Canned queries** — one tool per entry in an optional `--metadata <file.yml>` file, individually marked `write: true` or read-only by the metadata

## What this Lens adds

- **`sqlGuard`** — Allowlist mode on `sqlite_execute` rejects any non-read statement (DELETE, INSERT, UPDATE, DROP, CREATE, ALTER, TRUNCATE, PRAGMA writes, etc.) and catches embedded DML patterns.
- **`block`** — Defensive globs (`write_*`, `insert_*`, `update_*`, `delete_*`, `drop_*`, `create_*`, `alter_*`, `truncate_*`) that match nothing in a bare install but protect you from accidentally exposing a mutating canned query if you add a metadata file.
- **`instructions`** — SELECT-only policy + PII column guidance.
- **`redact`** — Email / SSN / Stripe / bcrypt patterns plus field rules for common sensitive column names.
- **`audit`** — JSONL log at `~/mcp-audit-sqlite.jsonl`.

## Prerequisites

- **Read-only file permissions on the SQLite database** (layer 3, mandatory for production). SQLite is a flat file. There is no separate user / role / connection string to grant SELECT on — the only enforcement at the data path is filesystem ACLs. `chmod 444 /path/to/db.sqlite` (read-only for owner / group / others) is the minimum; for stronger isolation, run JanuScope as a UNIX user that has read access but no write access to the file. JanuScope's sqlGuard, block list, and SURFACE BOUNDARY policy are layers 1 and 2 (defence in depth); only the file permissions physically prevent writes if the agent host runs `sqlite3` directly OR reads / writes the file through a filesystem MCP. See [SECURITY.md](../../../SECURITY.md#three-layer-model) for the full model. Note that "read-only file" is also the only way to prevent `PRAGMA journal_mode = WAL` side effects which can write a `.db-journal` even on read-only-looking SQL.

## Customising

Required environment variable:

- `SQLITE_DB_PATH` — absolute path to the `.sqlite` / `.db` file.

Optional: uncomment the `--metadata` args in `config.yaml` if you want canned queries.
