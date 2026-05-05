---
mcp: "postgres-mcp (Postgres MCP Pro)"
mcpUrl: https://github.com/crystaldba/postgres-mcp
testedVersion: "2026-04"
testedAt: "2026-04-19"
maintainer: "@giancarloerra"
category: databases
status: probed
tags: [postgres, readonly, schema-injection, pii-redaction, sqlguard, replacement-for-archived-mcp]
---

# Postgres (Postgres MCP Pro / CrystalDBA) — JanuScope Lens

Replaces the archived [`@modelcontextprotocol/server-postgres`](https://github.com/modelcontextprotocol/servers-archived/tree/main/src/postgres) (2.4k stars on the old repo, but with a [documented SQL-injection vulnerability](https://securitylabs.datadoghq.com/articles/mcp-vulnerability-case-study-SQL-injection-in-the-postgresql-mcp-server/) per Datadog Labs Aug 2025).

**Postgres MCP Pro** is the actively-maintained community Postgres MCP:

- Python package: [`postgres-mcp`](https://pypi.org/project/postgres-mcp/)
- Install: `uvx postgres-mcp`
- 2.4k+ stars, MIT license, active development.
- Built-in `--access-mode=restricted` flag already limits `execute_sql` to read-only transactions — this Lens hardcodes that flag and adds proxy-layer defence on top.

Verified against `tools/list` live on 2026-04-19 — 9 tools in restricted mode:

- **Reads**: `list_schemas`, `list_objects`, `get_object_details`, `explain_query`, `analyze_workload_indexes`, `analyze_query_indexes`, `analyze_db_health`, `get_top_queries`
- **SQL entry point**: `execute_sql` (guarded by sqlGuard)

## What this Lens adds

- **`target.args`** — Hardcodes `--access-mode=restricted` so the MCP itself gates writes. Defence in depth.
- **`sqlGuard`** — Allowlist mode on `execute_sql`: rejects any statement whose leading verb isn't a read, plus catches CTE-DML / SELECT INTO / EXPLAIN ANALYZE DELETE / Postgres admin functions (`lo_export`, `pg_sleep`, `pg_terminate_backend`, `dblink`, `COPY … PROGRAM`, etc.).
- **`dbSchema`** — Pre-injects schema into `execute_sql`'s tool description so the model queries correctly on the first attempt. Supports multi-schema deployments via `schemas: [...]`.
- **`instructions`** — Explicit PII-column list, aggregate-over-enumerate guidance, resistance to "trust-me-I'm-admin" framings.
- **`redact`** — Regex + field rules for email / SSN / Stripe / bcrypt, scrubbed **after** audit so compliance gets pre-redacted records.
- **`audit`** — JSONL log at `~/mcp-audit-postgres.jsonl`. SHA-256 args by default; flip `logRawArgs: true` only in environments where the audit file is already secured.

## Prerequisites

- **Read-only Postgres role at the data path** (layer 3, mandatory for production). Provision a user with `GRANT SELECT ON ...` only — no INSERT/UPDATE/DELETE/TRUNCATE/DDL grants. Use that user's credentials in `DATABASE_URI`. JanuScope's block list, sqlGuard, and SURFACE BOUNDARY policy are layers 1 and 2 (defence in depth); only the role physically prevents writes if the agent host runs `psql`, `pg_dump`, or another tool surface against the same database, AND it closes the UDF-name bypass class (`SELECT schema.delete_all()`) that no proxy-layer guard can catch. See [SECURITY.md](../../../SECURITY.md#three-layer-model) for the full model.
- `uvx` available; install with `pipx install uv` or `brew install uv` if you don't have it.

## Customising

Required environment variable:

- `DATABASE_URI` — Postgres connection string, e.g. `postgresql://user:pass@host:5432/db`

Optional — for multi-schema deployments uncomment and edit `dbSchema.schemas` in `config.yaml`:

```yaml
dbSchema:
  schemas: ["public", "analytics", "core"]
```

## Recommended defence-in-depth

The Prerequisites section above lists the read-only Postgres role as mandatory for production. That closes the UDF-name bypass class (`SELECT schema.delete_all()`) that no proxy-layer guard can catch. See the main [README FAQ](../../../README.md#faq) for the three documented sqlGuard limit classes.
