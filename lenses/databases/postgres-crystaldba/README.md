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

# Postgres (Postgres MCP Pro / CrystalDBA) , JanuScope Lens

Replaces the archived [`@modelcontextprotocol/server-postgres`](https://github.com/modelcontextprotocol/servers-archived/tree/main/src/postgres) (2.4k stars on the old repo, but with a [documented SQL-injection vulnerability](https://securitylabs.datadoghq.com/articles/mcp-vulnerability-case-study-SQL-injection-in-the-postgresql-mcp-server/) per Datadog Labs Aug 2025).

**Postgres MCP Pro** is the actively-maintained community Postgres MCP:

- Python package: [`postgres-mcp`](https://pypi.org/project/postgres-mcp/)
- Install: `uvx postgres-mcp`
- 2.4k+ stars, MIT license, active development.
- Built-in `--access-mode=restricted` flag already limits `execute_sql` to read-only transactions , this Lens hardcodes that flag and adds proxy-layer defence on top.

Verified against `tools/list` live on 2026-04-19 , 9 tools in restricted mode:

- **Reads**: `list_schemas`, `list_objects`, `get_object_details`, `explain_query`, `analyze_workload_indexes`, `analyze_query_indexes`, `analyze_db_health`, `get_top_queries`
- **SQL entry point**: `execute_sql` (guarded by sqlGuard)

## What this Lens adds

- **`target.args`** , Hardcodes `--access-mode=restricted` so the MCP itself gates writes. Defence in depth.
- **`sqlGuard`** , Allowlist mode on `execute_sql`: rejects any statement whose leading verb isn't a read, plus catches CTE-DML / SELECT INTO / EXPLAIN ANALYZE DELETE / Postgres admin functions (`lo_export`, `pg_sleep`, `pg_terminate_backend`, `dblink`, `COPY … PROGRAM`, etc.).
- **`dbSchema`**: Adds schema to the `execute_sql` tool description before querying. Table and column names, plus included comments, are sent to the MCP client and may reach its model provider. This can reduce discovery calls; it does not guarantee a correct first query. Use `schemas: [...]` to select the relevant namespaces.
- **`instructions`** , Explicit PII-column list, aggregate-over-enumerate guidance, resistance to "trust-me-I'm-admin" framings.
- **`redact`**: Regex and field rules replace matching email, SSN, Stripe, bcrypt, and named sensitive-field values in supported response representations. Audit runs first: upstream JSON-RPC error messages may be logged before redaction, while successful response bodies are not stored in the audit log. Unmatched values are outside these rules' coverage.
- **`audit`** , JSONL log at `~/mcp-audit-postgres.jsonl`. SHA-256 args by default; flip `logRawArgs: true` only in environments where the audit file is already secured.

## Prerequisites

- **Read-only Postgres role at the backend**, required wherever unintended changes matter. Give the role only the intended read access, with no write, DDL, administrative, or unsafe function-execution privileges. Review inherited grants and callable functions, including `SECURITY DEFINER` functions: a `SELECT` grant alone does not establish that a role cannot cause writes. Use that role's credentials in `DATABASE_URI`. JanuScope cannot determine arbitrary function side effects or control a separate `psql` or sibling-MCP connection. See [SECURITY.md](../../../SECURITY.md#three-layer-model).
- Node.js 20+ with `npx` for JanuScope.
- `uvx` available to the MCP client; install [uv](https://docs.astral.sh/uv/getting-started/installation/) if needed. A GUI client's PATH can differ from the terminal's.

## Customising

Required environment variable:

- `DATABASE_URI` , Postgres connection string, e.g. `postgresql://user:pass@host:5432/db`

Optional , for multi-schema deployments uncomment and edit `dbSchema.schemas` in `config.yaml`:

```yaml
dbSchema:
  schemas: ["public", "analytics", "core"]
```

## Recommended defence-in-depth

Restricted MCP mode and `sqlGuard` add checks on the wrapped connection. Backend permissions must also prevent unwanted side effects, including those reachable through callable functions such as `SELECT schema.delete_all()`. See the [SQL limitations](../../../docs/setup.md#faq).

Read-only access does not prevent sensitive-field disclosure. Aliases, encodings and calculated values can avoid the preset's output matches. For strict source-field isolation, use a dedicated role with approved column grants or vetted views, including a review of inherited, `PUBLIC` and function permissions. The [tested PostgreSQL example](../../../docs/sensitive-data.md) preserves allowed analytics while refusing protected-source reads. This is an optional stricter deployment; it also denies aggregates and presence checks that reference protected columns.
