# JanuScope Lenses

A **Lens** is a YAML policy preset plus setup notes for one MCP server. It declares the upstream command, tool restrictions, response rules, and other enabled overlays. Start with the [Postgres quick start](../README.md#quick-start), or browse the [complete client entry catalogue](../docs/lenses.md).

## Available Lenses

The package includes 20 presets. Verification is specific to the `testedVersion`, `testedAt`, and `status` recorded in each preset README. These records do not guarantee compatibility with later upstream releases or successful access to your backend.

### Databases

| Preset                                                    | Target MCP                                                                                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [`postgres-crystaldba`](./databases/postgres-crystaldba/) | [crystaldba/postgres-mcp](https://github.com/crystaldba/postgres-mcp)                                                                         |
| [`mysql-benborla29`](./databases/mysql-benborla29/)       | [benborla/mcp-server-mysql](https://github.com/benborla/mcp-server-mysql)                                                                     |
| [`mongodb-official`](./databases/mongodb-official/)       | [mongodb-js/mongodb-mcp-server](https://github.com/mongodb-js/mongodb-mcp-server)                                                             |
| [`clickhouse-official`](./databases/clickhouse-official/) | [ClickHouse/mcp-clickhouse](https://github.com/ClickHouse/mcp-clickhouse)                                                                     |
| [`redis-official`](./databases/redis-official/)           | [redis/mcp-redis](https://github.com/redis/mcp-redis)                                                                                         |
| [`sqlite-panasenco`](./databases/sqlite-panasenco/)       | [panasenco/mcp-sqlite](https://github.com/panasenco/mcp-sqlite)                                                                               |
| [`mssql-azure-dab`](./databases/mssql-azure-dab/)         | [Azure/data-api-builder](https://github.com/Azure/data-api-builder) v1.7+ MCP                                                                 |
| [`oracle-db-sqlcl`](./databases/oracle-db-sqlcl/)         | [Oracle SQLcl 25.4+ MCP](https://docs.oracle.com/en/database/oracle/sql-developer-command-line/26.1/sqcug/using-oracle-sqlcl-mcp-server.html) |
| [`supabase-selfhost`](./databases/supabase-selfhost/)     | [Supabase CLI local MCP](https://github.com/supabase-community/supabase-mcp)                                                                  |
| [`snowflake-labs`](./databases/snowflake-labs/)           | [Snowflake-Labs/mcp](https://github.com/Snowflake-Labs/mcp) (uvx)                                                                             |
| [`aurora-dsql`](./databases/aurora-dsql/)                 | [awslabs.aurora-dsql-mcp-server](https://github.com/awslabs/mcp/tree/main/src/aurora-dsql-mcp-server) (uvx)                                   |
| [`redshift`](./databases/redshift/)                       | [awslabs.redshift-mcp-server](https://github.com/awslabs/mcp/tree/main/src/redshift-mcp-server) (uvx)                                         |
| [`neon-cloud`](./databases/neon-cloud/)                   | [Neon hosted MCP (mcp.neon.tech)](https://github.com/neondatabase/mcp-server-neon)                                                            |

### Developer tools

| Preset                                                            | Target MCP                                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [`filesystem-mcp-official`](./dev-tools/filesystem-mcp-official/) | [modelcontextprotocol/server-filesystem](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) |
| [`github-official`](./dev-tools/github-official/)                 | [github/github-mcp-server](https://github.com/github/github-mcp-server)                                            |

### SaaS

| Preset                                             | Target MCP                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`supabase-cloud`](./saas/supabase-cloud/)         | [Supabase hosted MCP (mcp.supabase.com)](https://github.com/supabase-community/supabase-mcp)     |
| [`stripe-official`](./saas/stripe-official/)       | [@stripe/mcp](https://docs.stripe.com/mcp)                                                       |
| [`notion-official`](./saas/notion-official/)       | [Notion MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp) (mcp.notion.com/mcp) |
| [`atlassian-official`](./saas/atlassian-official/) | [atlassian/atlassian-mcp-server](https://github.com/atlassian/atlassian-mcp-server)              |
| [`linear-remote`](./saas/linear-remote/)           | [Linear MCP](https://linear.app/docs/mcp) (mcp.linear.app)                                       |

## Using a Lens

Install the prerequisites listed by the preset. JanuScope needs Node.js 20+, Python MCPs also need `uvx` from [uv](https://docs.astral.sh/uv/getting-started/installation/), and some presets require Docker or a vendor CLI. Backend credentials and permissions are separate prerequisites.

```bash
npx -y januscope lenses list
npx -y januscope lenses show postgres-crystaldba
npx -y januscope check --config postgres-crystaldba
```

`--config` accepts either the bundled name or a path to a custom YAML/JSON policy. Set required environment variables in the MCP client's configuration using that client's syntax. The [setup guide](../docs/setup.md#client-configuration) gives complete client examples; the [catalogue](../docs/lenses.md) preserves the existing and wrapped entry for every preset.

## Contributing a new Lens

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full guide. In short:

1. Copy `_template/` to the right category folder, rename, edit.
2. Fill in the README frontmatter (target MCP, tested version, maintainer, category).
3. Run `npm run validate:lenses` locally , it must pass.
4. Open a PR; a maintainer will review.

> **Want a lens but don't have time to write one?** [Open a lens request](https://github.com/giancarloerra/januscope/issues/new?template=lens_request.yml). The template asks for the target MCP, a link to its docs / repo, and the dangerous-tool gaps that make a lens worth shipping. Maintainers and the community pick up requests when the target MCP looks tractable.

## Categories

New Lenses go in one of:

- `databases/` , Postgres, MySQL, SQLite, MongoDB, BigQuery, Snowflake, ClickHouse, ...
- `dev-tools/` , GitHub, GitLab, filesystem, git, ...
- `saas/` , Notion, Stripe, Slack, Jira/Atlassian, Linear, Salesforce, HubSpot, ...
- `infra/` , Kubernetes, AWS, GCP, Azure, Terraform, ...
- `other/` , anything that doesn't fit above (suggest a new category in your PR)

### Remote / HTTP MCPs

JanuScope's transport is stdio. Remote presets already work through `mcp-remote`, a separate stdio-to-HTTP bridge. They include Notion, Atlassian, Linear, Neon, and Supabase; the self-hosted Supabase preset uses the same bridge against a local endpoint.

The bridge connects to the endpoint in the preset and handles its authentication. `npx` downloads the bridge on first use. See the per-preset README for credentials, authentication steps, and version-specific details. Native HTTP transport is not implemented inside JanuScope; no future release version is promised here.

## Maintainer model

Each Lens has **one maintainer** listed in its README frontmatter , usually the person who submitted it. Anyone can open a PR to update a Lens; the maintainer reviews and merges. If the maintainer is unresponsive for 30+ days, anyone may take over:

1. Comment on the PR / issue asking the current maintainer to respond.
2. If no reply in 7 days, post in the PR that you're taking over and update the `maintainer` field in the frontmatter.
3. A JanuScope core maintainer approves the handover.

Stale Lenses (`testedAt` older than 6 months) are flagged by `npm run validate:lenses` and surface a warning but do not fail CI. If a Lens has been stale for 12+ months and nobody volunteers, it moves to `_archive/`.

## Core Lens quality bar

Every Lens in this directory must:

- Parse as valid JanuScope config (checked by `npm run validate:lenses`)
- Include a frontmatter-prefixed README with all required fields
- Credit the target MCP (link to source repo)
- Use environment variables for any secrets (no hardcoded credentials)
- Ship a sensible default , usually read-only when the target MCP supports it
- Apply the defence-in-depth baseline: `instructions` + (`block` and/or `sqlGuard`) + `redact` where each applies
- Specify which tool names it assumes so forks can be adapted
- Add **real value** over the bare MCP , don't submit a Lens whose only effect is a no-op against an already-restricted MCP
