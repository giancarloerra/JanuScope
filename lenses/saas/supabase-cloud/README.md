---
mcp: "Supabase hosted MCP server"
mcpUrl: https://github.com/supabase-community/supabase-mcp
testedVersion: "supabase 0.8.1 (hosted at mcp.supabase.com)"
testedAt: "2026-05-06"
maintainer: "@giancarloerra"
category: saas
status: probed
tags: [supabase, postgres, hosted, mcp-remote, readonly, pat]
---

# Supabase Cloud (hosted) — JanuScope Lens

Wraps Supabase's **hosted** MCP server at `https://mcp.supabase.com/mcp`
via [`mcp-remote`](https://github.com/geelen/mcp-remote). The hosted
MCP exposes a much wider surface than the self-host variant
(~30 tools spanning Account / Project / Database / Edge Functions /
Branching), so this lens has a correspondingly larger block list.

For the **local-development** Supabase MCP that ships with the CLI
(`supabase start` → `http://127.0.0.1:54321/mcp`), use the
`supabase-selfhost` lens instead. That one has a smaller surface
(~11 tools) and no auth.

## What this lens does

- **`block`** — every write-shaped tool: `create_project`,
  `pause_project`, `restore_project`, `apply_migration`,
  `deploy_edge_function`, `create_branch` / `delete_branch` /
  `merge_branch` / `reset_branch` / `rebase_branch`. Plus
  defensive globs (`create_*`, `delete_*`, `update_*`, `deploy_*`)
  to catch future write-shaped additions.
- **`sqlGuard`** — `execute_sql`, `sqlArg: query`, `readOnly: true`.
- **`instructions`** — read-only banner with the canonical tool path.
- **`redact`** — PII field paths + DSN / SSN / PAN / JWT regex
  fallbacks.
- **`audit`** — JSONL compliance log at
  `~/mcp-audit-supabase-cloud.jsonl`.

The lens uses `mcp-remote` to bridge HTTP→stdio. Auth is
non-interactive via Personal Access Token in the
`Authorization: Bearer` header.

## Tool names this lens assumes

Probed against Supabase hosted MCP `0.8.1` on 2026-05-06 with
`?read_only=true`:

| Tool                        | Kind             | Treatment       |
| --------------------------- | ---------------- | --------------- |
| `search_docs`               | read (KB)        | passes through  |
| `list_organizations`        | read             | passes through  |
| `get_organization`          | read             | passes through  |
| `list_projects`             | read             | passes through  |
| `get_project`               | read             | passes through  |
| `get_cost` / `confirm_cost` | read (pricing)   | passes through  |
| `list_tables`               | read (metadata)  | passes through  |
| `list_extensions`           | read (metadata)  | passes through  |
| `list_migrations`           | read (metadata)  | passes through  |
| `get_logs`                  | read (logs)      | passes through  |
| `get_advisors`              | read (advice)    | passes through  |
| `get_project_url`           | read (metadata)  | passes through  |
| `get_publishable_keys`      | read (anon keys) | passes through  |
| `generate_typescript_types` | read (schema)    | passes through  |
| `list_edge_functions`       | read             | passes through  |
| `get_edge_function`         | read             | passes through  |
| `list_branches`             | read             | passes through  |
| `execute_sql`               | arbitrary SQL    | **sqlGuard ed** |
| `apply_migration`           | DDL write        | **blocked**     |
| `create_project`            | account write    | **blocked**     |
| `pause_project`             | account write    | **blocked**     |
| `restore_project`           | account write    | **blocked**     |
| `deploy_edge_function`      | code deploy      | **blocked**     |
| `create_branch`             | branch write     | **blocked**     |
| `delete_branch`             | branch write     | **blocked**     |
| `merge_branch`              | branch write     | **blocked**     |
| `reset_branch`              | branch write     | **blocked**     |
| `rebase_branch`             | branch write     | **blocked**     |

## Prerequisites

1. **A Supabase account** ([supabase.com/dashboard/sign-up](https://supabase.com/dashboard/sign-up)). The free tier covers the lens probe.
2. **A Personal Access Token (PAT)**. In the Supabase dashboard,
   navigate to **[Account → Access Tokens → Generate new token](https://supabase.com/dashboard/account/tokens)**,
   copy the value (only shown once). The token starts with `sbp_`.
3. **Node.js 20+** for `mcp-remote`.

## Customising

The lens reads the PAT from the `SUPABASE_ACCESS_TOKEN` environment variable.
JanuScope substitutes `${SUPABASE_ACCESS_TOKEN}` in `target.args` at startup.

To scope the MCP to a single project (recommended for production
deployments), add `&project_ref=<project-id>` to the URL in
`target.args`. Project-scoping disables the cross-account tools
(`list_projects`, `list_organizations`, etc.) and locks the session
to a single project.

## Usage

```json
{
  "mcpServers": {
    "supabase": {
      "command": "npx",
      "args": ["-y", "januscope", "--config", "supabase-cloud"],
      "env": {
        "SUPABASE_ACCESS_TOKEN": "sbp_your_token_here"
      }
    }
  }
}
```

Replace `sbp_your_token_here` with your Supabase PAT.

## Probe transcript (2026-05-06)

A live `tools/list` against the bridged stdio session returned the
twenty-nine tools shown in the table above. Server identity:
`{"name": "supabase", "title": "Supabase", "version": "0.8.1"}`. The
probe was driven against the live `mcp.supabase.com` endpoint with
`?read_only=true` and PAT auth. After the lens's block list applies,
**18 tools** remain visible to the LLM (read-side); `execute_sql`
additionally has `sqlGuard` on its `query` argument.

## Note on read-only flag vs proxy block list

Supabase's `?read_only=true` URL flag DOES disable execution of write
operations at the data-path level (per the official docs), but the
MCP still surfaces those tools in `tools/list`. The proxy-side block
list ensures the LLM never sees write-shaped tool names in the first
place — same defence-in-depth philosophy as the `neon-cloud` lens.

## Changelog

- **2026-05-06** — Initial contribution (@giancarloerra). Probed
  against Supabase hosted MCP 0.8.1 with PAT auth and
  `?read_only=true`.
