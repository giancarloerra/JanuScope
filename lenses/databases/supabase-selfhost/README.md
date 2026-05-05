---
mcp: "Supabase self-host MCP server (built into Supabase CLI)"
mcpUrl: https://github.com/supabase-community/supabase-mcp
testedVersion: "Supabase CLI 2.98.1 / supabase mcp 0.7.0"
testedAt: "2026-05-05"
maintainer: "@giancarloerra"
category: databases
status: probed
tags: [supabase, postgres, mcp-remote, readonly]
---

# Supabase self-host (CLI / Docker stack) — JanuScope Lens

Wraps the Supabase MCP server that ships inside the Supabase CLI's
local-development stack. When you run `supabase start`, the CLI boots
a full Postgres + GoTrue + Realtime + Studio stack via Docker compose
and exposes an HTTP MCP endpoint at `http://127.0.0.1:54321/mcp`.

The self-host MCP exposes a **subset** of the hosted MCP's tool list
(no Account, Branching, Edge Functions, or Storage admin tools, and
no OAuth flow). For the hosted Supabase MCP, see the upcoming
`supabase-cloud` lens.

This lens locks the local stack to read-only by:

1. **Blocking `apply_migration`** at the proxy.
2. **`sqlGuard`-ing `execute_sql`** to reject any SQL statement
   containing a write keyword.
3. **Redacting PII** (email, password, api_key, token, secret) plus
   value-shape patterns (SSN, PAN, JWT).
4. **Auditing** every tool call to `~/mcp-audit-supabase.jsonl`.

## What this lens does

- **`block`** — `apply_migration` (DDL / schema-mutating).
- **`sqlGuard`** — `execute_sql`, `sqlArg: query`, `readOnly: true`.
- **`instructions`** — read-only banner with the canonical tool path.
- **`redact`** — field-path PII rules + regex fallbacks (SSN, PAN, JWT).
- **`audit`** — JSONL compliance log at `~/mcp-audit-supabase.jsonl`.

The lens uses `mcp-remote` to bridge the HTTP-only Supabase MCP into
stdio so JanuScope (a stdio-only proxy) can wrap it. Same pattern as
`linear-remote`, `notion-official`, and `atlassian-official`.

## Tool names this lens assumes

Probed against Supabase CLI 2.98.1 / Supabase MCP 0.7.0 on 2026-05-05:

| Tool                        | Kind             | Treatment       |
| --------------------------- | ---------------- | --------------- |
| `search_docs`               | read (KB)        | passes through  |
| `list_tables`               | read (metadata)  | passes through  |
| `list_extensions`           | read (metadata)  | passes through  |
| `list_migrations`           | read (metadata)  | passes through  |
| `get_logs`                  | read (logs)      | passes through  |
| `get_advisors`              | read (advice)    | passes through  |
| `get_project_url`           | read (metadata)  | passes through  |
| `get_publishable_keys`      | read (anon keys) | passes through  |
| `generate_typescript_types` | read (schema)    | passes through  |
| `execute_sql`               | arbitrary SQL    | **sqlGuard ed** |
| `apply_migration`           | DDL write        | **blocked**     |

## Prerequisites

1. **Supabase CLI** installed (`brew install supabase` or the
   GitHub-release binary):
   ```bash
   brew install supabase
   supabase --version
   ```
2. **Docker Desktop** running (Supabase compose-stack needs Docker).
3. **A Supabase project initialised** in some directory:
   ```bash
   mkdir my-supabase-project && cd $_
   supabase init
   supabase start
   ```
   The first `supabase start` pulls a dozen images and may take a few
   minutes. Subsequent starts are quick.
4. **`mcp-remote`** is fetched on demand by `npx -y mcp-remote …` and
   needs Node.js 20+ on PATH.

## Customising

The Supabase self-host MCP listens on a fixed local port
(`127.0.0.1:54321`) and accepts no environment variables; whatever
`supabase start` brings up is what the MCP exposes. JanuScope does
not relay or rename anything.

If you change the port via `supabase config` or run multiple stacks,
copy this lens to your own out-of-tree directory and edit the URL in
`target.args` to point at the right port.

## Usage

```json
{
  "mcpServers": {
    "supabase": {
      "command": "januscope",
      "args": ["--config", "supabase-selfhost"]
    }
  }
}
```

Run `supabase start` first; otherwise the lens will fail to connect.

## Probe transcript (2026-05-05)

A live `tools/list` against the bridged stdio session returned the
eleven tools shown in the table above. Server identity:
`{"name": "supabase", "title": "Supabase", "version": "0.7.0"}`.

The probe was driven against the full Supabase CLI Docker stack
(Postgres 15 + GoTrue + Realtime + Studio + Edge runtime). The lens
config blocks `apply_migration` at the proxy and applies sqlGuard to
`execute_sql`.

## Note on the hosted Supabase MCP

If you connect to the hosted MCP at `https://mcp.supabase.com/mcp`
instead, the tool surface is much larger (about thirty tools spanning
Account / Database / Debugging / Development / Edge Functions /
Storage / Branching). This lens does NOT cover that surface; a
separate `supabase-cloud` lens is planned and will need its own
block list and `firstRun: approve` baseline.

## Changelog

- **2026-05-05** — Initial contribution (@giancarloerra). Probed
  against Supabase CLI 2.98.1 + Supabase MCP 0.7.0 on Docker
  Desktop (linux/arm64).
