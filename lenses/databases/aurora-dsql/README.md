---
mcp: "awslabs.aurora-dsql-mcp-server"
mcpUrl: https://github.com/awslabs/mcp/tree/main/src/aurora-dsql-mcp-server
testedVersion: "awslabs-aurora-dsql-mcp-server 1.27.0"
testedAt: "2026-05-06"
maintainer: "@giancarloerra"
category: databases
status: probed
tags: [aws, aurora-dsql, postgres-compatible, iam-auth, readonly]
---

# AWS Aurora DSQL — JanuScope Lens

Wraps the [`awslabs.aurora-dsql-mcp-server`](https://github.com/awslabs/mcp/tree/main/src/aurora-dsql-mcp-server)
which speaks stdio. Aurora DSQL is AWS's distributed Postgres-compatible
serverless SQL service. The MCP authenticates via AWS IAM (no DSQL
password — IAM-issued tokens) and uses the AWS SDK credential chain.

This lens stays read-only by:

1. Spawning the MCP **without `--allow-writes`** (the MCP defaults to
   read-only and rejects mutations at execution time when this flag
   is absent).
2. Layering `sqlGuard` on `readonly_query` so any write keyword in
   the SQL string is refused at the proxy before the MCP even sees
   it.
3. Redacting PII + DSN-shaped values in result frames.
4. Auditing every tool call to `~/mcp-audit-aurora-dsql.jsonl`.

## What this lens does

- **`sqlGuard`** — `readonly_query`, `sqlArg: sql`, `readOnly: true`.
- **`instructions`** — read-only banner, plus an explicit "do not
  request `--allow-writes`" caution for the LLM.
- **`redact`** — field-path PII rules + DSN / SSN / PAN / JWT
  regex fallbacks.
- **`audit`** — JSONL compliance log.

No `block`: the MCP only surfaces 6 tools and none are write-shaped
when the MCP is started without `--allow-writes`. The
`transact` tool is left available because in read-only mode it is
the canonical way to run multiple SELECTs at a consistent
point-in-time snapshot; sqlGuard doesn't apply to its array-shaped
`sql_list` argument, but the MCP rejects mutations in `transact`
itself when `--allow-writes` is absent.

## Tool names this lens assumes

Probed against `awslabs-aurora-dsql-mcp-server` 1.27.0 on
2026-05-06 with the MCP started in default (read-only) mode:

| Tool                        | Kind               | Treatment                      |
| --------------------------- | ------------------ | ------------------------------ |
| `readonly_query`            | arbitrary SQL      | **sqlGuard ed**                |
| `transact`                  | array of SQL stmts | passes through (MCP read-only) |
| `get_schema`                | read (metadata)    | passes through                 |
| `dsql_search_documentation` | read (docs KB)     | passes through                 |
| `dsql_read_documentation`   | read (docs KB)     | passes through                 |
| `dsql_recommend`            | read (advice)      | passes through                 |

## Prerequisites

1. **An Aurora DSQL cluster** in your AWS account
   ([console](https://console.aws.amazon.com/dsql/)). The free trial
   covers a small cluster.
2. **`uv` / `uvx`** installed locally:
   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```
3. **AWS credentials** that the SDK can pick up — env vars, an
   `~/.aws/credentials` profile, or any other source the AWS SDK's
   default credential chain supports. The IAM principal needs
   `dsql:DbConnect` (token issuance) plus the database-side role
   you want the LLM to inherit.
4. **A DSQL database role** scoped to read-only. DSQL roles are
   bound to IAM principals — the README in the awslabs repo's
   [`getting-started`](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/getting-started.html)
   guide walks through creating one. Use that role's name as
   `DSQL_DATABASE_USER`.

## Customising

The lens reads the cluster + region + database user from
environment variables. JanuScope substitutes them into `target.args`
at startup (no rename, the MCP's `--cluster_endpoint` / `--region` /
`--database_user` CLI flags receive the values directly).

| Variable                | Purpose                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `DSQL_CLUSTER_ENDPOINT` | e.g. `<id>.dsql.eu-west-2.on.aws`                                                              |
| `AWS_REGION`            | AWS region of the cluster (e.g. `eu-west-2`)                                                   |
| `DSQL_DATABASE_USER`    | DSQL role to assume (typically a read-only role)                                               |
| AWS SDK credential vars | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, or `AWS_PROFILE`, or any other supported source |

## Usage

```json
{
  "mcpServers": {
    "aurora-dsql": {
      "command": "npx",
      "args": ["-y", "januscope", "--config", "aurora-dsql"],
      "env": {
        "DSQL_CLUSTER_ENDPOINT": "<id>.dsql.eu-west-2.on.aws",
        "AWS_REGION": "eu-west-2",
        "DSQL_DATABASE_USER": "readonly_role",
        "AWS_PROFILE": "default"
      }
    }
  }
}
```

`AWS_PROFILE` reads `~/.aws/credentials`; alternatively pass
`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` directly in the
`env` block. JanuScope inherits whatever the AWS SDK reads.

## Probe transcript (2026-05-06)

A live `tools/list` against `uvx awslabs.aurora-dsql-mcp-server@latest`
returned the six tools shown in the table above. Server identity:
`{"name": "awslabs-aurora-dsql-mcp-server", "version": "1.27.0"}`. The
probe was driven against an Aurora DSQL cluster in `eu-west-2`, with
the MCP starting in default (read-only) mode (no `--allow-writes`
flag).

Server-side log: `Aurora DSQL MCP init with CLUSTER_ENDPOINT:…,
REGION: eu-west-2, DATABASE_USER:admin, MODE:READ-ONLY,
AWS_PROFILE:default, KNOWLEDGE_SERVER:…`. The `MODE:READ-ONLY` line
is the upstream MCP's own confirmation of its posture.

## Three-layer recap

JanuScope's lens is layer 1 (proxy block + sqlGuard). The MCP's
read-only mode is layer 2 (default behaviour without `--allow-writes`).
A scoped DSQL database role bound to a least-privilege IAM principal
is layer 3 (the data-path enforcement that survives even if
layers 1 + 2 misconfigure). Production deployments should rely on
layer 3 as the source of truth.

## Changelog

- **2026-05-06** — Initial contribution (@giancarloerra). Probed
  against awslabs-aurora-dsql-mcp-server 1.27.0 in `eu-west-2` with
  IAM-based auth.
