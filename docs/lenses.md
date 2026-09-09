# Policy presets and client entries

A **Lens** is a YAML policy preset for one upstream MCP server. Each preset specifies the process to start and the restrictions to apply. Read its prerequisites before connecting it to a backend.

These are individual server entries. Put the chosen entry inside the container required by your MCP client: `mcpServers` for Claude Code, `servers` for VS Code, or the equivalent host configuration. The full client file formats are in the [setup guide](./setup.md#client-configuration). Example credentials, connection strings, and paths are placeholders.

JanuScope needs Node.js 20+. Presets that start `uvx` also need [uv](https://docs.astral.sh/uv/getting-started/installation/) on the MCP client's PATH. Other executables, credentials, and backend permissions depend on the preset. Remote presets use the `mcp-remote` bridge and connect to the stated endpoint; running JanuScope locally does not make those connections local.

Most existing environment variables pass through unchanged. SQLite and filesystem presets take their formerly positional values from `SQLITE_DB_PATH` and `FILESYSTEM_ALLOWED_DIR`. Preset constants such as restricted access flags still apply. Keep the same server name when wrapping an existing entry, and retain any host settings such as startup timeouts.

```bash
npx -y januscope lenses list
npx -y januscope lenses show postgres-crystaldba
npx -y januscope lenses search postgres
```

## PostgreSQL

Preset: **`postgres-crystaldba`**. Upstream: [crystaldba/postgres-mcp](https://github.com/crystaldba/postgres-mcp).

[Postgres MCP Pro](https://github.com/crystaldba/postgres-mcp). Hardcodes `--access-mode=restricted`, adds sqlGuard with a Postgres dangerous-function denylist, schema pre-injection with multi-schema support, PII redaction, audit.

[Prerequisites and policy details](../lenses/databases/postgres-crystaldba/README.md).

### With JanuScope

```json
{
  "command": "npx",
  "args": ["-y", "januscope", "--config", "postgres-crystaldba"],
  "env": {
    "DATABASE_URI": "postgresql://user:pass@host:5432/db"
  }
}
```

<details>
<summary>Existing upstream entry for comparison</summary>

```json
{
  "command": "uvx",
  "args": ["postgres-mcp"],
  "env": {
    "DATABASE_URI": "postgresql://user:pass@host:5432/db"
  }
}
```

</details>

## MySQL

Preset: **`mysql-benborla29`**. Upstream: [benborla/mcp-server-mysql](https://github.com/benborla/mcp-server-mysql).

[`@benborla29/mcp-server-mysql`](https://github.com/benborla/mcp-server-mysql). `mysql_query` gated by sqlGuard; MCP-level writes hardcoded off via `ALLOW_*_OPERATION=false`.

[Prerequisites and policy details](../lenses/databases/mysql-benborla29/README.md).

### With JanuScope

```json
{
  "command": "npx",
  "args": ["-y", "januscope", "--config", "mysql-benborla29"],
  "env": {
    "MYSQL_HOST": "localhost",
    "MYSQL_PORT": "3306",
    "MYSQL_USER": "readonly",
    "MYSQL_PASS": "<your_password>",
    "MYSQL_DB": "mydb"
  }
}
```

<details>
<summary>Existing upstream entry for comparison</summary>

```json
{
  "command": "npx",
  "args": ["-y", "@benborla29/mcp-server-mysql"],
  "env": {
    "MYSQL_HOST": "localhost",
    "MYSQL_PORT": "3306",
    "MYSQL_USER": "readonly",
    "MYSQL_PASS": "<your_password>",
    "MYSQL_DB": "mydb"
  }
}
```

</details>

## MongoDB

Preset: **`mongodb-official`**. Upstream: [mongodb-js/mongodb-mcp-server](https://github.com/mongodb-js/mongodb-mcp-server).

[MongoDB's official MCP](https://github.com/mongodb-js/mongodb-mcp-server). Locks DB + Atlas writes; PII redaction reaches into returned JSON documents.

[Prerequisites and policy details](../lenses/databases/mongodb-official/README.md).

### With JanuScope

```json
{
  "command": "npx",
  "args": ["-y", "januscope", "--config", "mongodb-official"],
  "env": {
    "MDB_MCP_CONNECTION_STRING": "mongodb+srv://user:pass@cluster.mongodb.net"
  }
}
```

<details>
<summary>Existing upstream entry for comparison</summary>

```json
{
  "command": "npx",
  "args": ["-y", "mongodb-mcp-server"],
  "env": {
    "MDB_MCP_CONNECTION_STRING": "mongodb+srv://user:pass@cluster.mongodb.net"
  }
}
```

</details>

## ClickHouse

Preset: **`clickhouse-official`**. Upstream: [ClickHouse/mcp-clickhouse](https://github.com/ClickHouse/mcp-clickhouse).

[ClickHouse's official MCP](https://github.com/ClickHouse/mcp-clickhouse). Allowlist-mode sqlGuard on `run_query`; PII redaction; audit.

[Prerequisites and policy details](../lenses/databases/clickhouse-official/README.md).

### With JanuScope

```json
{
  "command": "npx",
  "args": ["-y", "januscope", "--config", "clickhouse-official"],
  "env": {
    "CLICKHOUSE_HOST": "myhost.clickhouse.cloud",
    "CLICKHOUSE_PORT": "8443",
    "CLICKHOUSE_USER": "readonly",
    "CLICKHOUSE_PASSWORD": "<your_password>",
    "CLICKHOUSE_DATABASE": "default"
  }
}
```

<details>
<summary>Existing upstream entry for comparison</summary>

```json
{
  "command": "uvx",
  "args": ["mcp-clickhouse"],
  "env": {
    "CLICKHOUSE_HOST": "myhost.clickhouse.cloud",
    "CLICKHOUSE_PORT": "8443",
    "CLICKHOUSE_USER": "readonly",
    "CLICKHOUSE_PASSWORD": "<your_password>",
    "CLICKHOUSE_DATABASE": "default",
    "CLICKHOUSE_SECURE": "true"
  }
}
```

</details>

## Redis

Preset: **`redis-official`**. Upstream: [redis/mcp-redis](https://github.com/redis/mcp-redis).

[`redis/mcp-redis`](https://github.com/redis/mcp-redis). Read-only Redis (47 tools, 23 mutations blocked); works against self-hosted, Redis Cloud, AWS ElastiCache, and Upstash via standard `rediss://` URIs; heavy regex coverage on returned values (session tokens, JWTs, bcrypt, cloud keys); rate-limits the heavy iteration tools.

[Prerequisites and policy details](../lenses/databases/redis-official/README.md).

### With JanuScope

```json
{
  "command": "npx",
  "args": ["-y", "januscope", "--config", "redis-official"],
  "env": {
    "REDIS_URL": "redis://localhost:6379/0"
  }
}
```

<details>
<summary>Existing upstream entry for comparison</summary>

```json
{
  "command": "uvx",
  "args": [
    "--from",
    "redis-mcp-server@latest",
    "redis-mcp-server",
    "--url",
    "redis://localhost:6379/0"
  ]
}
```

</details>

## SQLite

Preset: **`sqlite-panasenco`**. Upstream: [panasenco/mcp-sqlite](https://github.com/panasenco/mcp-sqlite).

[`panasenco/mcp-sqlite`](https://github.com/panasenco/mcp-sqlite). sqlGuard on `sqlite_execute` plus defensive write-verb globs for canned queries.

[Prerequisites and policy details](../lenses/databases/sqlite-panasenco/README.md).

### With JanuScope

```json
{
  "command": "npx",
  "args": ["-y", "januscope", "--config", "sqlite-panasenco"],
  "env": {
    "SQLITE_DB_PATH": "/path/to/your.sqlite"
  }
}
```

<details>
<summary>Existing upstream entry for comparison</summary>

```json
{
  "command": "uvx",
  "args": ["mcp-sqlite", "/path/to/your.sqlite"]
}
```

</details>

## SQL Server / Azure SQL

Preset: **`mssql-azure-dab`**. Upstream: [Azure/data-api-builder](https://github.com/Azure/data-api-builder) v1.7+ MCP.

[Data API builder v1.7+ MCP](https://github.com/Azure/data-api-builder) for Azure SQL / SQL Server / SQLDW / Cosmos DB / PostgreSQL / MySQL. Blocks every write-shaped DML tool (`create_record`, `update_record`, `delete_record`, `execute_entity`); PII redaction; audit.

[Prerequisites and policy details](../lenses/databases/mssql-azure-dab/README.md).

### With JanuScope

```json
{
  "command": "npx",
  "args": ["-y", "januscope", "--config", "mssql-azure-dab"],
  "cwd": "/path/to/your/dab-project"
}
```

<details>
<summary>Existing upstream entry for comparison</summary>

```json
{
  "command": "dab",
  "args": ["start", "--mcp-stdio"],
  "cwd": "/path/to/your/dab-project"
}
```

</details>

## Oracle Database

Preset: **`oracle-db-sqlcl`**. Upstream: [Oracle SQLcl 25.4+ MCP](https://docs.oracle.com/en/database/oracle/sql-developer-command-line/26.1/sqcug/using-oracle-sqlcl-mcp-server.html).

[Oracle SQLcl 25.4+ built-in MCP](https://docs.oracle.com/en/database/oracle/sql-developer-command-line/26.1/sqcug/using-oracle-sqlcl-mcp-server.html). Blocks `run-sqlcl` (SQLcl meta-commands incl HOST shell escape); sqlGuard on `run-sql` for keyword-level write rejection; PII redaction; audit.

[Prerequisites and policy details](../lenses/databases/oracle-db-sqlcl/README.md).

### With JanuScope

```json
{
  "command": "npx",
  "args": ["-y", "januscope", "--config", "oracle-db-sqlcl"]
}
```

<details>
<summary>Existing upstream entry for comparison</summary>

```json
{
  "command": "sql",
  "args": ["-mcp"]
}
```

</details>

## Supabase (self-host)

Preset: **`supabase-selfhost`**. Upstream: [Supabase CLI local MCP](https://github.com/supabase-community/supabase-mcp).

[Supabase self-host MCP](https://github.com/supabase-community/supabase-mcp) via `mcp-remote` against the local CLI stack at `http://127.0.0.1:54321/mcp`. Blocks `apply_migration`; sqlGuard on `execute_sql`; PII redaction including JWT-shaped tokens; audit.

[Prerequisites and policy details](../lenses/databases/supabase-selfhost/README.md).

### With JanuScope

```json
{
  "command": "npx",
  "args": ["-y", "januscope", "--config", "supabase-selfhost"]
}
```

<details>
<summary>Existing upstream entry for comparison</summary>

```json
{
  "command": "npx",
  "args": [
    "-y",
    "mcp-remote",
    "http://127.0.0.1:54321/mcp",
    "--allow-http",
    "--transport",
    "http-only"
  ]
}
```

</details>

## Supabase (cloud)

Preset: **`supabase-cloud`**. Upstream: [Supabase hosted MCP (mcp.supabase.com)](https://github.com/supabase-community/supabase-mcp).

[Supabase hosted MCP](https://github.com/supabase-community/supabase-mcp) at `mcp.supabase.com` via `mcp-remote` with PAT auth. Blocks every project / branch / migration / edge-function write (10 tools + defensive globs); sqlGuard on `execute_sql`; PII redaction including DSN and JWT shapes; audit. For the local-development MCP see `supabase-selfhost`.

[Prerequisites and policy details](../lenses/saas/supabase-cloud/README.md).

### With JanuScope

```json
{
  "command": "npx",
  "args": ["-y", "januscope", "--config", "supabase-cloud"],
  "env": {
    "SUPABASE_ACCESS_TOKEN": "sbp_your_token_here"
  }
}
```

<details>
<summary>Existing upstream entry for comparison</summary>

```json
{
  "command": "npx",
  "args": [
    "-y",
    "mcp-remote",
    "https://mcp.supabase.com/mcp?read_only=true",
    "--header",
    "Authorization:Bearer YOUR_SBP_TOKEN",
    "--transport",
    "http-only"
  ]
}
```

</details>

## Snowflake

Preset: **`snowflake-labs`**. Upstream: [Snowflake-Labs/mcp](https://github.com/Snowflake-Labs/mcp) (uvx).

[Snowflake-Labs/mcp](https://github.com/Snowflake-Labs/mcp) via `uvx` with PAT auth. Blocks the generic DDL writers `create_object` / `drop_object` / `create_or_alter_object` (plus defensive globs); sqlGuard on `run_snowflake_query`; PII redaction including PAT/JWT-shaped tokens; audit. Includes a `services.example.yaml` for the MCP's required `--service-config-file`.

The upstream project is [deprecated and no longer maintained](https://github.com/Snowflake-Labs/mcp#readme). Its replacement, the [Snowflake-managed MCP server](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents-mcp), uses a different setup; this preset wraps the legacy `snowflake-labs-mcp` server.

[Prerequisites and policy details](../lenses/databases/snowflake-labs/README.md).

Before using either entry, have an administrator create a dedicated account role such as `JANUSCOPE_READONLY` and grant it to `your_user`. For basic queries, grant only `USAGE` on the chosen warehouse, database and schemas, plus `SELECT` on the permitted tables and views. Additional services need their documented object permissions. Keep administrative and write privileges out of this role and its inherited grants. See [Snowflake privilege requirements](https://docs.snowflake.com/en/user-guide/security-access-control-privileges) and [custom role assignment](https://docs.snowflake.com/en/user-guide/security-access-control-considerations#managing-custom-roles). Generate the PAT with [`ROLE_RESTRICTION`](https://docs.snowflake.com/en/user-guide/programmatic-access-tokens) set to this role; the example role is a placeholder, not a built-in role.

In the upstream services YAML, use [`sql_statement_permissions`](https://github.com/Snowflake-Labs/mcp#sql-execution) to allow required read statement types and deny writes and `Unknown`. The [bundled example](../lenses/databases/snowflake-labs/services.example.yaml) disables common write classes but permits `Command`, which upstream uses for both `SHOW` and `CALL`. These filters complement the restricted database role; they do not replace it.

### With JanuScope

```json
{
  "command": "npx",
  "args": ["-y", "januscope", "--config", "snowflake-labs"],
  "env": {
    "SNOWFLAKE_ACCOUNT": "ORG-ACCOUNT",
    "SNOWFLAKE_USER": "your_user",
    "SNOWFLAKE_PASSWORD": "<your_PAT>",
    "SNOWFLAKE_ROLE": "JANUSCOPE_READONLY",
    "SNOWFLAKE_WAREHOUSE": "COMPUTE_WH",
    "SNOWFLAKE_MCP_CONFIG": "/path/to/services.yaml"
  }
}
```

<details>
<summary>Existing upstream entry for comparison</summary>

```json
{
  "command": "uvx",
  "args": ["snowflake-labs-mcp", "--service-config-file", "/path/to/services.yaml"],
  "env": {
    "SNOWFLAKE_ACCOUNT": "ORG-ACCOUNT",
    "SNOWFLAKE_USER": "your_user",
    "SNOWFLAKE_PASSWORD": "<your_PAT>",
    "SNOWFLAKE_ROLE": "JANUSCOPE_READONLY",
    "SNOWFLAKE_WAREHOUSE": "COMPUTE_WH"
  }
}
```

</details>

## AWS Aurora DSQL

Preset: **`aurora-dsql`**. Upstream: [awslabs.aurora-dsql-mcp-server](https://github.com/awslabs/mcp/tree/main/src/aurora-dsql-mcp-server) (uvx).

[awslabs.aurora-dsql-mcp-server](https://github.com/awslabs/mcp/tree/main/src/aurora-dsql-mcp-server) via `uvx` with AWS IAM auth. MCP runs in default read-only mode (no `--allow-writes`); sqlGuard layered on `readonly_query`; PII redaction including DSN-shaped values; audit.

[Prerequisites and policy details](../lenses/databases/aurora-dsql/README.md).

### With JanuScope

```json
{
  "command": "npx",
  "args": ["-y", "januscope", "--config", "aurora-dsql"],
  "env": {
    "DSQL_CLUSTER_ENDPOINT": "<id>.dsql.eu-west-2.on.aws",
    "AWS_REGION": "eu-west-2",
    "DSQL_DATABASE_USER": "admin",
    "AWS_PROFILE": "default"
  }
}
```

<details>
<summary>Existing upstream entry for comparison</summary>

```json
{
  "command": "uvx",
  "args": [
    "awslabs.aurora-dsql-mcp-server@latest",
    "--cluster_endpoint",
    "<id>.dsql.eu-west-2.on.aws",
    "--region",
    "eu-west-2",
    "--database_user",
    "admin"
  ]
}
```

</details>

## AWS Redshift

Preset: **`redshift`**. Upstream: [awslabs.redshift-mcp-server](https://github.com/awslabs/mcp/tree/main/src/redshift-mcp-server) (uvx).

[awslabs.redshift-mcp-server](https://github.com/awslabs/mcp/tree/main/src/redshift-mcp-server) via `uvx` with AWS IAM auth. Discovers both provisioned clusters and Serverless workgroups; sqlGuard on `execute_query`; PII redaction including JDBC Redshift / Postgres DSN shapes; audit. README includes the minimum IAM policy.

[Prerequisites and policy details](../lenses/databases/redshift/README.md).

### With JanuScope

```json
{
  "command": "npx",
  "args": ["-y", "januscope", "--config", "redshift"],
  "env": {
    "AWS_REGION": "eu-west-2",
    "AWS_PROFILE": "default"
  }
}
```

<details>
<summary>Existing upstream entry for comparison</summary>

```json
{
  "command": "uvx",
  "args": ["awslabs.redshift-mcp-server@latest"],
  "env": {
    "AWS_REGION": "eu-west-2",
    "AWS_PROFILE": "default"
  }
}
```

</details>

## Neon (hosted Postgres)

Preset: **`neon-cloud`**. Upstream: [Neon hosted MCP (mcp.neon.tech)](https://github.com/neondatabase/mcp-server-neon).

[Neon hosted MCP](https://github.com/neondatabase/mcp-server-neon) via `mcp-remote` with API-key auth and server-side `?readonly=true`. Blocks `get_connection_string` (DSN credential leak); sqlGuard on `run_sql` and `run_sql_transaction`; PII redaction including DSN-shaped values; audit.

[Prerequisites and policy details](../lenses/databases/neon-cloud/README.md).

### With JanuScope

```json
{
  "command": "npx",
  "args": ["-y", "januscope", "--config", "neon-cloud"],
  "env": {
    "NEON_API_KEY": "napi_your_token_here"
  }
}
```

<details>
<summary>Existing upstream entry for comparison</summary>

```json
{
  "command": "npx",
  "args": [
    "-y",
    "mcp-remote",
    "https://mcp.neon.tech/mcp?readonly=true",
    "--header",
    "Authorization:Bearer YOUR_NAPI_TOKEN",
    "--transport",
    "http-only"
  ]
}
```

</details>

## Filesystem

Preset: **`filesystem-mcp-official`**. Upstream: [modelcontextprotocol/server-filesystem](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem).

[MCP reference filesystem server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem). Locks `write_file` / `edit_file` / `create_directory` / `move_file`; wide-spectrum secret redaction (cloud keys, PATs, PEM, DB URLs, `.env`, JWT).

[Prerequisites and policy details](../lenses/dev-tools/filesystem-mcp-official/README.md).

### With JanuScope

```json
{
  "command": "npx",
  "args": ["-y", "januscope", "--config", "filesystem-mcp-official"],
  "env": {
    "FILESYSTEM_ALLOWED_DIR": "/Users/you/Desktop"
  }
}
```

<details>
<summary>Existing upstream entry for comparison</summary>

```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/Desktop"]
}
```

</details>

## GitHub

Preset: **`github-official`**. Upstream: [github/github-mcp-server](https://github.com/github/github-mcp-server).

[GitHub's official Go MCP](https://github.com/github/github-mcp-server). Runs in Docker with `GITHUB_READ_ONLY=1` and a curated `GITHUB_TOOLSETS`; proxy-layer write blocks as defence in depth; wide-spectrum secret redaction on file contents.

[Prerequisites and policy details](../lenses/dev-tools/github-official/README.md).

### With JanuScope

```json
{
  "command": "npx",
  "args": ["-y", "januscope", "--config", "github-official"],
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "<your_PAT>"
  }
}
```

<details>
<summary>Existing upstream entry for comparison</summary>

```json
{
  "command": "docker",
  "args": [
    "run",
    "-i",
    "--rm",
    "-e",
    "GITHUB_PERSONAL_ACCESS_TOKEN",
    "ghcr.io/github/github-mcp-server"
  ],
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "<your_PAT>"
  }
}
```

</details>

## Stripe

Preset: **`stripe-official`**. Upstream: [@stripe/mcp](https://docs.stripe.com/mcp).

[Stripe's official MCP](https://docs.stripe.com/mcp). Locks refunds, payouts, cancels, and the `stripe_api_execute` generic REST bypass; scrubs card PAN, Stripe keys, email, phone.

[Prerequisites and policy details](../lenses/saas/stripe-official/README.md).

### With JanuScope

```json
{
  "command": "npx",
  "args": ["-y", "januscope", "--config", "stripe-official"],
  "env": {
    "STRIPE_SECRET_KEY": "rk_live_<restricted_key>"
  }
}
```

<details>
<summary>Existing upstream entry for comparison</summary>

```json
{
  "command": "npx",
  "args": ["-y", "@stripe/mcp"],
  "env": {
    "STRIPE_SECRET_KEY": "rk_live_<restricted_key>"
  }
}
```

</details>

## Notion

Preset: **`notion-official`**. Upstream: [Notion MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp) (mcp.notion.com/mcp).

[Notion's official hosted MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp) via `mcp-remote`.

[Prerequisites and policy details](../lenses/saas/notion-official/README.md).

### With JanuScope

```json
{
  "command": "npx",
  "args": ["-y", "januscope", "--config", "notion-official"]
}
```

<details>
<summary>Existing upstream entry for comparison</summary>

```json
{
  "command": "npx",
  "args": ["-y", "mcp-remote", "https://mcp.notion.com/mcp"]
}
```

</details>

## Atlassian (Jira / Confluence)

Preset: **`atlassian-official`**. Upstream: [atlassian/atlassian-mcp-server](https://github.com/atlassian/atlassian-mcp-server).

[Atlassian's official Rovo MCP](https://github.com/atlassian/atlassian-mcp-server) via `mcp-remote`. Jira, Confluence, Compass.

[Prerequisites and policy details](../lenses/saas/atlassian-official/README.md).

### With JanuScope

```json
{
  "command": "npx",
  "args": ["-y", "januscope", "--config", "atlassian-official"]
}
```

<details>
<summary>Existing upstream entry for comparison</summary>

```json
{
  "command": "npx",
  "args": ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/mcp"]
}
```

</details>

## Linear

Preset: **`linear-remote`**. Upstream: [Linear MCP](https://linear.app/docs/mcp) (mcp.linear.app).

[Linear's official remote MCP](https://linear.app/docs/mcp) via `mcp-remote`.

[Prerequisites and policy details](../lenses/saas/linear-remote/README.md).

### With JanuScope

```json
{
  "command": "npx",
  "args": ["-y", "januscope", "--config", "linear-remote"]
}
```

<details>
<summary>Existing upstream entry for comparison</summary>

```json
{
  "command": "npx",
  "args": ["-y", "mcp-remote", "https://mcp.linear.app/sse"]
}
```

</details>

## Other MCP servers

Use a [custom policy](./setup.md#write-your-own-policy) or [contribute a preset](../lenses/CONTRIBUTING.md). Tool names and prerequisites vary by upstream version. The `testedAt`, `testedVersion`, and `status` fields in each preset README describe its recorded verification; they do not prove that a later upstream version has the same surface.
