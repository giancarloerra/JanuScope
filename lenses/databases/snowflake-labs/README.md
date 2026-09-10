---
mcp: "Snowflake-Labs/mcp (snowflake-labs-mcp)"
mcpUrl: https://github.com/Snowflake-Labs/mcp
testedVersion: "Snowflake MCP Server 2.14.7"
testedAt: "2026-05-06"
maintainer: "@giancarloerra"
category: databases
status: probed
tags: [snowflake, cortex, semantic-views, pat, readonly]
---

# Snowflake (via Snowflake-Labs MCP) — JanuScope Lens

Wraps Snowflake's official MCP server,
[`Snowflake-Labs/mcp`](https://github.com/Snowflake-Labs/mcp), which
speaks stdio. The MCP exposes Snowflake DB operations (object
discovery, raw SQL execution) plus the semantic-view family
(`query_semantic_view`, `show_semantic_dimensions`, …) for Cortex
Analyst-style structured analytics.

This lens applies the following controls:

1. **Blocking** the generic DDL writers `create_object`,
   `drop_object`, and `create_or_alter_object` (plus defensive
   globs `create_*` / `drop_*` / `delete_*` / `alter_*`).
2. **Applying `sqlGuard` to `run_snowflake_query`** with its default
   read-verb allowlist. `CALL` and `GRANT` are refused; `SHOW` remains
   available.
3. **Redacting PII** in result frames — Snowflake returns rows as
   structured JSON.
4. **Auditing** every tool call to `~/mcp-audit-snowflake.jsonl`.

## What this lens does

- **`block`** — `create_object`, `drop_object`,
  `create_or_alter_object` + defensive globs.
- **`sqlGuard`** — `run_snowflake_query`, `sqlArg: statement`,
  `readOnly: true`.
- **`instructions`** — read-only banner pointing the LLM at
  `list_objects` / `describe_object` / semantic-view tools first,
  with `run_snowflake_query` as the SELECT-only escape hatch.
- **`redact`** — field-path PII rules (email, password, api_key,
  token, secret in both lower-case and Snowflake's default UPPERCASE
  identifier folding) plus regex fallbacks for SSN, PAN, JWT-shape
  (which catches PATs leaking through).
- **`audit`** — JSONL compliance log.

## Tool names this lens assumes

Probed against `Snowflake MCP Server` 2.14.7 on 2026-05-06:

| Tool                             | Kind              | Treatment       |
| -------------------------------- | ----------------- | --------------- |
| `list_objects`                   | read (metadata)   | passes through  |
| `describe_object`                | read (metadata)   | passes through  |
| `list_semantic_views`            | read              | passes through  |
| `describe_semantic_view`         | read              | passes through  |
| `show_semantic_dimensions`       | read              | passes through  |
| `show_semantic_metrics`          | read              | passes through  |
| `get_semantic_view_ddl`          | read              | passes through  |
| `write_semantic_view_query_tool` | helper (no exec)  | passes through  |
| `query_semantic_view`            | read (analytical) | passes through  |
| `run_snowflake_query`            | arbitrary SQL     | **sqlGuard ed** |
| `create_object`                  | DDL write         | **blocked**     |
| `drop_object`                    | DDL write         | **blocked**     |
| `create_or_alter_object`         | DDL write         | **blocked**     |

## Prerequisites

1. **A Snowflake account** ([signup.snowflake.com](https://signup.snowflake.com/)).
   The 30-day trial is sufficient for this lens.
2. **`uv` / `uvx`** installed locally (the MCP runs via
   `uvx snowflake-labs-mcp`):
   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```
3. **A Programmatic Access Token (PAT)**. In Snowsight, navigate to
   **Governance & security → Users & roles → click your user →
   Programmatic access tokens → + Generate new token**.
4. **A PAT-compatible authentication posture** for the user. Snowflake's
   PAT-auth contract requires either (a) a user-level network policy
   in place, or (b) an authentication policy granting PAT use without
   one. Pick whichever fits the deployment; the lens works either way.
   - **Option (a)** — user-level network policy. Best when the lens
     runs from a known IP range you want to enforce as a hardening
     layer:
     ```sql
     CREATE NETWORK RULE allow_lens_ip
       TYPE = IPV4 MODE = INGRESS
       VALUE_LIST = ('203.0.113.0/24');           -- your range
     CREATE NETWORK POLICY lens_network_policy
       ALLOWED_NETWORK_RULE_LIST = ('allow_lens_ip');
     ALTER USER <YOUR_USER> SET NETWORK_POLICY = lens_network_policy;
     ```
   - **Option (b)** — authentication policy that lets PAT auth proceed
     without a user-level network policy. Best when the lens runs
     from changing IPs (CI runners, MCP-client laptops, etc.) and
     the PAT itself is the security boundary. Authentication policies
     are schema-level objects and must live in a non-personal
     database; create a small admin database for them:
     ```sql
     CREATE DATABASE IF NOT EXISTS LENS_ADMIN;
     CREATE OR REPLACE AUTHENTICATION POLICY LENS_ADMIN.PUBLIC.pat_no_network_required
       PAT_POLICY = (NETWORK_POLICY_EVALUATION = ENFORCED_NOT_REQUIRED);
     ALTER USER <YOUR_USER>
       SET AUTHENTICATION POLICY LENS_ADMIN.PUBLIC.pat_no_network_required;
     ```
     See [SECURITY.md](../../../SECURITY.md#three-layer-model) for the
     defence-in-depth picture.
5. **A service-config YAML** for the MCP (it requires one).
   `services.example.yaml` next to this README is a starter — copy it
   somewhere stable (e.g. `~/.januscope/snowflake-services.yaml`)
   and point at it via the `SNOWFLAKE_MCP_CONFIG` env var.

## Customising

All connection details are passed via environment variables (NOT as
`--password` CLI args, which would leak the PAT into `ps` output).
These are the names the upstream MCP itself reads — JanuScope does
not rename or relay them; whatever the user sets in their MCP-client
config's `env` block reaches the spawned MCP unchanged.

| Variable               | Purpose                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `SNOWFLAKE_ACCOUNT`    | `<orgname>-<accountname>` (e.g. `XYZ-ABC123`)                       |
| `SNOWFLAKE_USER`       | Your Snowflake username                                             |
| `SNOWFLAKE_PASSWORD`   | Your PAT — read by the MCP from this env var directly (no CLI flag) |
| `SNOWFLAKE_ROLE`       | Dedicated read-only account role (e.g. `JANUSCOPE_READONLY`)        |
| `SNOWFLAKE_WAREHOUSE`  | Warehouse to use (e.g. `COMPUTE_WH`)                                |
| `SNOWFLAKE_MCP_CONFIG` | Absolute path to your services.yaml                                 |

Before connecting, have an administrator create the dedicated account
role and grant it to the user. For basic queries, grant the role
`USAGE` on the selected warehouse, database and schemas, plus `SELECT`
on only the permitted tables and views. Additional services need their
documented object permissions. See the [client entry prerequisites](../../../docs/lenses.md#snowflake)
for role-restricted PATs and upstream SQL policy settings.

For production, use a dedicated read-only Snowflake user with this role, and
ideally key-pair auth instead of PAT — JanuScope inherits whatever
auth path the MCP supports without rename.

## Usage

```json
{
  "mcpServers": {
    "snowflake": {
      "command": "npx",
      "args": ["-y", "januscope", "--config", "snowflake-labs"],
      "env": {
        "SNOWFLAKE_ACCOUNT": "XYZ-ABC123",
        "SNOWFLAKE_USER": "your_user",
        "SNOWFLAKE_PASSWORD": "<your_PAT>",
        "SNOWFLAKE_ROLE": "JANUSCOPE_READONLY",
        "SNOWFLAKE_WAREHOUSE": "COMPUTE_WH",
        "SNOWFLAKE_MCP_CONFIG": "/Users/you/.januscope/snowflake-services.yaml"
      }
    }
  }
}
```

## Probe transcript (2026-05-06)

A live `tools/list` against `uvx snowflake-labs-mcp …` returned the
thirteen tools shown in the table above. Server identity:
`{"name": "Snowflake MCP Server", "version": "2.14.7"}`. The probe
was driven against a Snowflake trial account with the
`pat_no_network_required` authentication policy in place.

## Note on `sql_statement_permissions` (defence in depth)

The Snowflake-Labs MCP's own service-config YAML uses
[`sql_statement_permissions`](https://github.com/Snowflake-Labs/mcp#sql-execution)
to filter SQL statement categories for `run_snowflake_query`. The
[bundled example](services.example.yaml) disables common write categories
(Alter, Copy, Create, Delete, Drop, Insert, Merge, TruncateTable, Update)
and `Unknown`. It retains `Command: True` for `SHOW`; upstream also puts
`CALL` and `GRANT` in that category. This is a category filter, not a
read-only guarantee for the standalone server.

Permitted statements still depend on effective Snowflake privileges.
[`USAGE` on a stored procedure](https://docs.snowflake.com/en/user-guide/security-access-control-privileges#stored-procedure-privileges)
allows calling it. [Owner's-rights procedures](https://docs.snowflake.com/en/developer-guide/stored-procedure/stored-procedures-rights)
execute with their owner's privileges, so restricting the caller's
table privileges does not prevent a procedure from writing.

For a read-only workflow, grant procedure access only through an explicit
administrator-reviewed allowlist of procedures whose operations meet that
policy. Review [inherited role and `PUBLIC` grants](https://docs.snowflake.com/en/user-guide/security-access-control-overview)
too. If procedure access is unnecessary, grant none.

JanuScope's `sqlGuard` adds a separate check on `run_snowflake_query`:
its default read-verb allowlist refuses `CALL` and `GRANT` while allowing
`SHOW`. It does not inspect procedure bodies or replace database privilege
review.

## Changelog

- **2026-05-06** — Initial contribution (@giancarloerra). Probed
  against Snowflake MCP Server 2.14.7 on a Snowflake 30-day trial
  account with PAT auth.
