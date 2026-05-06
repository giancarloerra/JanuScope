---
mcp: "awslabs.redshift-mcp-server"
mcpUrl: https://github.com/awslabs/mcp/tree/main/src/redshift-mcp-server
testedVersion: "awslabs.redshift-mcp-server 1.27.0"
testedAt: "2026-05-06"
maintainer: "@giancarloerra"
category: databases
status: probed
tags: [aws, redshift, redshift-serverless, iam-auth, readonly]
---

# AWS Redshift — JanuScope Lens

Wraps the [`awslabs.redshift-mcp-server`](https://github.com/awslabs/mcp/tree/main/src/redshift-mcp-server)
which speaks stdio. The MCP discovers both **provisioned Redshift
clusters and Redshift Serverless workgroups** in the configured AWS
account/region, exposes hierarchical schema introspection tools, and
runs SQL through the [Redshift Data API](https://docs.aws.amazon.com/redshift-data/latest/APIReference/Welcome.html)
in read-only mode.

This lens stays read-only by:

1. Relying on the MCP's **default read-only mode** (write support
   is planned for a future MCP release; this lens does not enable
   it).
2. Layering `sqlGuard` on `execute_query` so any write keyword in
   the SQL string is refused at the proxy before the MCP sees it.
3. Redacting PII + DSN-shaped values in result frames.
4. Auditing every tool call to `~/mcp-audit-redshift.jsonl`.

## What this lens does

- **`sqlGuard`** — `execute_query`, `sqlArg: sql`, `readOnly: true`.
- **`instructions`** — read-only banner with the canonical
  `list_clusters → list_databases → list_schemas → list_tables →
list_columns → execute_query` discovery flow.
- **`redact`** — field-path PII rules + DSN / SSN / PAN / JWT
  regex fallbacks (Postgres, JDBC Redshift, JDBC Postgres URI
  shapes).
- **`audit`** — JSONL compliance log.

No `block`: the MCP only surfaces 6 tools and 5 are pure read; the
sixth (`execute_query`) gets sqlGuard.

## Tool names this lens assumes

Probed against `awslabs.redshift-mcp-server` 1.27.0 on 2026-05-06:

| Tool             | Kind             | Treatment       |
| ---------------- | ---------------- | --------------- |
| `list_clusters`  | read (discovery) | passes through  |
| `list_databases` | read (metadata)  | passes through  |
| `list_schemas`   | read (metadata)  | passes through  |
| `list_tables`    | read (metadata)  | passes through  |
| `list_columns`   | read (metadata)  | passes through  |
| `execute_query`  | arbitrary SQL    | **sqlGuard ed** |

## Prerequisites

1. **A Redshift cluster or Serverless workgroup** in your AWS
   account.
2. **`uv` / `uvx`** installed locally.
3. **AWS credentials** the SDK can pick up (env vars, profile, etc.).
4. **An IAM policy** attached to the principal the lens
   authenticates as. The lens requires the following actions to
   discover Redshift resources and execute queries through the
   Redshift Data API:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "redshift:DescribeClusters",
           "redshift-serverless:ListWorkgroups",
           "redshift-serverless:GetWorkgroup",
           "redshift-data:ListDatabases",
           "redshift-data:ListSchemas",
           "redshift-data:ListTables",
           "redshift-data:DescribeTable",
           "redshift-data:ExecuteStatement",
           "redshift-data:DescribeStatement",
           "redshift-data:GetStatementResult"
         ],
         "Resource": "*"
       }
     ]
   }
   ```

   Attach this policy to `<your-iam-principal>` (the IAM user, role,
   or federated identity whose credentials feed the AWS SDK chain
   the lens reads). All ten actions are required; the discovery
   chain (`list_clusters` → `list_databases` → `list_schemas` →
   `list_tables` → `list_columns`) fails on the first missing
   action.

## Customising

The lens reads AWS context from standard SDK env vars; JanuScope
does not rename them.

| Variable                                      | Purpose                                                    |
| --------------------------------------------- | ---------------------------------------------------------- |
| `AWS_REGION`                                  | AWS region of the Redshift cluster/workgroup               |
| `AWS_PROFILE`                                 | (optional) named profile to read from `~/.aws/credentials` |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | direct creds; alternative to `AWS_PROFILE`                 |

## Usage

```json
{
  "mcpServers": {
    "redshift": {
      "command": "npx",
      "args": ["-y", "januscope", "--config", "redshift"],
      "env": {
        "AWS_REGION": "eu-west-2",
        "AWS_PROFILE": "default"
      }
    }
  }
}
```

## Probe transcript (2026-05-06)

A live `tools/list` against `uvx awslabs.redshift-mcp-server@latest`
returned the six tools shown in the table above. Server identity:
`{"name": "awslabs.redshift-mcp-server", "version": "1.27.0"}`. The
probe was driven against an AWS account in `eu-west-2`; the MCP's
own startup log confirms it ran a `ListToolsRequest` round-trip.

## Three-layer recap

JanuScope's lens is layer 1 (proxy `sqlGuard`). The MCP's read-only
mode is layer 2 (current default behaviour). A scoped IAM principal
with read-only Redshift Data API actions only is layer 3 (the
data-path enforcement). Production deployments should lean on
layer 3 — even if the MCP later adds a `--allow-writes` flag, an
IAM principal without the corresponding `Update*`/`Delete*`
actions cannot mutate.

## Changelog

- **2026-05-06** — Initial contribution (@giancarloerra). Probed
  against awslabs.redshift-mcp-server 1.27.0 in `eu-west-2`.
