---
mcp: "Neon hosted MCP (mcp-server-neon)"
mcpUrl: https://github.com/neondatabase/mcp-server-neon
testedVersion: "mcp-server-neon 1.0.0 (hosted at mcp.neon.tech)"
testedAt: "2026-05-06"
maintainer: "@giancarloerra"
category: databases
status: probed
tags: [neon, postgres, hosted, mcp-remote, readonly]
---

# Neon (hosted Postgres) — JanuScope Lens

Wraps Neon's hosted MCP server at `https://mcp.neon.tech/mcp` via
[`mcp-remote`](https://github.com/geelen/mcp-remote). Neon is a hosted
Postgres-as-a-service whose MCP exposes project / branch management,
schema introspection, and read-only SQL execution.

This lens locks the surface to read-only by:

1. Setting Neon's server-side **`?readonly=true`** flag on the URL
   (Neon's own readonly enforcement at the data layer).
2. **Blocking `get_connection_string`** at the proxy. That tool
   returns the raw Postgres DSN (with username + password) and is a
   credential leak to the LLM regardless of read-only mode.
3. **`sqlGuard`-ing `run_sql` and `run_sql_transaction`** to reject
   any SQL containing a write keyword (defence in depth on top of
   the server-side readonly).
4. **Redacting PII + connection-string-shaped values** in result
   frames.
5. **Auditing** every tool call to `~/mcp-audit-neon.jsonl`.

## What this lens does

- **`block`** — `get_connection_string` (DSN credential leak).
- **`sqlGuard`** — `run_sql`, `run_sql_transaction`, `sqlArg: sql`,
  `readOnly: true`.
- **`instructions`** — read-only banner with the canonical tool path.
- **`redact`** — field-path PII rules + regex fallbacks for DSN
  patterns, SSN, PAN, JWT.
- **`audit`** — JSONL compliance log at `~/mcp-audit-neon.jsonl`.

The lens uses `mcp-remote` to bridge the HTTP MCP into stdio (Neon
ships streamable-HTTP, JanuScope's engine is stdio-native). API-key
auth is passed via the `Authorization: Bearer <key>` header.

## Tool names this lens assumes

Probed against `mcp-server-neon` 1.0.0 hosted at `mcp.neon.tech` on
2026-05-06 with `?readonly=true`:

| Tool                      | Kind             | Treatment       |
| ------------------------- | ---------------- | --------------- |
| `list_projects`           | read             | passes through  |
| `list_organizations`      | read             | passes through  |
| `list_shared_projects`    | read             | passes through  |
| `describe_project`        | read             | passes through  |
| `describe_branch`         | read             | passes through  |
| `describe_table_schema`   | read (metadata)  | passes through  |
| `get_database_tables`     | read (metadata)  | passes through  |
| `list_branch_computes`    | read             | passes through  |
| `list_slow_queries`       | read (analytics) | passes through  |
| `compare_database_schema` | read (analytics) | passes through  |
| `explain_sql_statement`   | read (analysis)  | passes through  |
| `search`                  | read (docs KB)   | passes through  |
| `fetch`                   | read (docs KB)   | passes through  |
| `list_docs_resources`     | read (docs KB)   | passes through  |
| `get_doc_resource`        | read (docs KB)   | passes through  |
| `run_sql`                 | arbitrary SQL    | **sqlGuard ed** |
| `run_sql_transaction`     | arbitrary SQL    | **sqlGuard ed** |
| `get_connection_string`   | DSN leak         | **blocked**     |

## Prerequisites

1. **A Neon account** ([console.neon.tech/signup](https://console.neon.tech/signup)).
   The free tier is permanent and sufficient for this lens.
2. **A Neon API key**. In the Neon console, navigate to **Account
   settings → API keys → Create API key**, copy the value (only shown
   once). The key starts with `napi_`.
3. **Node.js 20+** for `mcp-remote` (fetched by `npx -y` on first use).

## Customising

The lens reads the Neon API key from the `NEON_API_KEY` environment
variable, which is the natural place for the user to set it (in their
MCP-client config's `env` block, in their shell, or via a secret-vault
reference like `${vault://secrets/neon#api_key}` if they use one).
JanuScope substitutes `${NEON_API_KEY}` in `target.args` at startup.

If you want to scope the MCP to a single project (recommended for
safety in production), add `&projectId=<your-project-id>` to the URL
in `target.args`. The Neon docs list other URL params (`category=`,
etc.) for further narrowing.

## Usage

```json
{
  "mcpServers": {
    "neon": {
      "command": "npx",
      "args": ["-y", "januscope", "--config", "neon-cloud"],
      "env": {
        "NEON_API_KEY": "napi_your_token_here"
      }
    }
  }
}
```

Replace `napi_your_token_here` with your Neon API key. The token
inherits straight through to `mcp-remote`'s Authorization header
without any rename.

## Probe transcript (2026-05-06)

A live `tools/list` against the bridged stdio session returned the
eighteen tools shown in the table above. Server identity:
`{"name": "mcp-server-neon", "version": "1.0.0"}`. The probe was driven
against the live `mcp.neon.tech` endpoint with `?readonly=true` and
API-key auth.

## Note on OAuth vs API-key auth

Neon's MCP supports both OAuth (browser flow) and API-key (header)
auth. This lens uses API-key auth because it works in non-interactive
contexts (CI, MCP-client configs without browser access) and because
it lets the operator control the read/write scope at the API-key level.
For interactive workflows, OAuth is also supported by `mcp-remote`,
just remove `--header` from `target.args` and a browser tab will
open on first launch.

## Changelog

- **2026-05-06** — Initial contribution (@giancarloerra). Probed
  against `mcp-server-neon` 1.0.0 hosted at `mcp.neon.tech` with
  API-key auth and `?readonly=true`.
