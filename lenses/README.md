# JanuScope Lenses

> **A Lens is a specific JanuScope policy — the `config.yaml` + docs — for one particular MCP server.**

Each Lens is a ready-made answer to _"how do I safely deploy the [X] MCP?"_. Browse for the MCP you're using, read its README, and point your client at the `config.yaml`. If the Lens you need doesn't exist — [submit one](./CONTRIBUTING.md).

## Available Lenses

One Lens per service, pointing at the official vendor MCP where one exists. Community alternatives are included only for technologies without a single vendor (Postgres, MySQL, SQLite). Every Lens is verified against a live `tools/list` on its target MCP.

### 📊 Databases

| Lens                                                      | Target MCP                                                                          | Official?                                           |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------- |
| [`postgres-crystaldba`](./databases/postgres-crystaldba/) | [Postgres MCP Pro](https://github.com/crystaldba/postgres-mcp)                      | Community — Postgres has no single vendor           |
| [`mysql-benborla29`](./databases/mysql-benborla29/)       | [`@benborla29/mcp-server-mysql`](https://github.com/benborla/mcp-server-mysql)      | Community — no generic-MySQL vendor-official exists |
| [`mongodb-official`](./databases/mongodb-official/)       | [`mongodb-js/mongodb-mcp-server`](https://github.com/mongodb-js/mongodb-mcp-server) | Official — MongoDB Inc.                             |
| [`clickhouse-official`](./databases/clickhouse-official/) | [`ClickHouse/mcp-clickhouse`](https://github.com/ClickHouse/mcp-clickhouse)         | Official — ClickHouse Inc.                          |
| [`redis-official`](./databases/redis-official/)           | [`redis/mcp-redis`](https://github.com/redis/mcp-redis)                             | Official — Redis Inc. (works with Upstash too)      |
| [`sqlite-panasenco`](./databases/sqlite-panasenco/)       | [`panasenco/mcp-sqlite`](https://github.com/panasenco/mcp-sqlite)                   | Community — SQLite has no single vendor             |

### 🔧 Developer tools

| Lens                                                              | Target MCP                                                                                                            | Official?              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| [`github-official`](./dev-tools/github-official/)                 | [`github/github-mcp-server`](https://github.com/github/github-mcp-server)                                             | Official — GitHub      |
| [`filesystem-mcp-official`](./dev-tools/filesystem-mcp-official/) | [`@modelcontextprotocol/server-filesystem`](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) | Official MCP reference |

### 💼 SaaS

| Lens                                               | Target MCP                                                                                          | Official?            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------- |
| [`stripe-official`](./saas/stripe-official/)       | [`@stripe/mcp`](https://docs.stripe.com/mcp)                                                        | Official — Stripe    |
| [`notion-official`](./saas/notion-official/)       | [Notion remote MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp) via `mcp-remote` | Official — Notion    |
| [`atlassian-official`](./saas/atlassian-official/) | [Atlassian Rovo MCP](https://github.com/atlassian/atlassian-mcp-server) via `mcp-remote`            | Official — Atlassian |
| [`linear-remote`](./saas/linear-remote/)           | [Linear hosted MCP](https://linear.app/docs/mcp) via `mcp-remote`                                   | Official — Linear    |

## Using a Lens

From the command line:

```bash
januscope lenses list                       # list every bundled Lens
januscope lenses show mongodb-official      # print the config.yaml + README
```

From your MCP client config:

```json
{
  "mcpServers": {
    "my-mongo": {
      "command": "januscope",
      "args": ["--config", "/absolute/path/to/lenses/databases/mongodb-official/config.yaml"]
    }
  }
}
```

## Contributing a new Lens

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full guide. In short:

1. Copy `_template/` to the right category folder, rename, edit.
2. Fill in the README frontmatter (target MCP, tested version, maintainer, category).
3. Run `npm run validate:lenses` locally — it must pass.
4. Open a PR; a maintainer will review.

> **Want a lens but don't have time to write one?** [Open a lens request](https://github.com/giancarloerra/januscope/issues/new?template=lens_request.md). The template asks for the target MCP, a link to its docs / repo, and the dangerous-tool gaps that make a lens worth shipping. Maintainers and the community pick up requests when the target MCP looks tractable.

## Categories

New Lenses go in one of:

- `databases/` — Postgres, MySQL, SQLite, MongoDB, BigQuery, Snowflake, ClickHouse, ...
- `dev-tools/` — GitHub, GitLab, filesystem, git, ...
- `saas/` — Notion, Stripe, Slack, Jira/Atlassian, Linear, Salesforce, HubSpot, ...
- `infra/` — Kubernetes, AWS, GCP, Azure, Terraform, ...
- `other/` — anything that doesn't fit above (suggest a new category in your PR)

### Remote / HTTP MCPs

Lenses here wrap **stdio** MCPs. Many first-party remote MCPs (HubSpot's `mcp.hubspot.com`, Linear's `mcp.linear.app`, Atlassian's Cloudflare-hosted server) require Streamable HTTP transport, which lands in JanuScope v0.4. Lenses for those will be added once the transport ships — when the target is a remote MCP and a stdio community alternative exists, the community Lens is listed in the table above with a note.

## Maintainer model

Each Lens has **one maintainer** listed in its README frontmatter — usually the person who submitted it. Anyone can open a PR to update a Lens; the maintainer reviews and merges. If the maintainer is unresponsive for 30+ days, anyone may take over:

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
- Ship a sensible default — usually read-only when the target MCP supports it
- Apply the defence-in-depth baseline: `instructions` + (`block` and/or `sqlGuard`) + `redact` where each applies
- Specify which tool names it assumes so forks can be adapted
- Add **real value** over the bare MCP — don't submit a Lens whose only effect is a no-op against an already-restricted MCP
