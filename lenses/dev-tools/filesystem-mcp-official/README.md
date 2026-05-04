---
mcp: "@modelcontextprotocol/server-filesystem"
mcpUrl: https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem
testedVersion: "2026-04"
testedAt: "2026-04-18"
maintainer: "@giancarloerra"
category: dev-tools
status: probed
tags: [filesystem, readonly, secret-redaction, local]
---

# Filesystem (official MCP) — JanuScope Lens

Wraps [`@modelcontextprotocol/server-filesystem`](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem), the official filesystem MCP. Without a Lens, the MCP's only guardrail is the allow-list of directories you pass at startup — inside those directories, the LLM can **read, write, edit, and delete freely**. This Lens neutralises the write surface and scrubs secrets out of read responses.

## What this Lens does

- **`instructions`** — read-only policy, concise-excerpt guidance (don't dump whole files), and symlink-escape warning.
- **`block`** — hides every write/edit/create/delete/move tool with both explicit names and glob patterns. Safe against upstream tool renames.
- **`redact`** — broad secret coverage: AWS keys (both access-ID and temp), Google / GitHub classic+fine+installation+OAuth / GitLab PATs, Stripe live / test / restricted keys, Slack tokens, SendGrid, Mailgun, PEM private-key headers, PEM certificate headers, Postgres/MySQL/MongoDB/Redis connection strings with embedded passwords, generic `.env`-style assignments, JWT tokens.
- **`audit`** — JSONL log at `~/mcp-audit-filesystem.jsonl`.

No `sqlGuard` / `dbSchema` (this isn't a database).

## Tool names this Lens assumes

Verified live against `@modelcontextprotocol/server-filesystem` on 2026-04-18. `tools/list` returns these 14 tools:

| Real tool name(s)                                                                                                                                                                                     | Kind                 | Treatment                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_file`, `read_text_file`, `read_media_file`, `read_multiple_files`, `list_directory`, `list_directory_with_sizes`, `directory_tree`, `get_file_info`, `search_files`, `list_allowed_directories` | read                 | passes through (output redacted)                                                                                                                                          |
| `write_file`, `edit_file`, `create_directory`, `move_file`                                                                                                                                            | write                | **blocked** (literal)                                                                                                                                                     |
| `write_*`, `edit_*`, `create_*`, `move_*`, `delete_*`, `rename_*`                                                                                                                                     | forward-looking glob | **blocked**. `delete_*` and `rename_*` match nothing in today's MCP; kept so a future version that adds `delete_file` or `rename_file` is covered without a config change |

## Prerequisites

- **Read-only OS-level access to the allowed directory** (layer 3, mandatory for production). The filesystem MCP runs as your user; whatever filesystem permissions that user has are what it can do. For a safe deployment: either point `FILESYSTEM_ALLOWED_DIR` at a tree where the proxy user has read-but-not-write permissions (`chmod -R u-w,g-w,o-w` or owned by another user with chmod 555 / 444), OR run JanuScope under a UNIX account that lacks write permissions on the target tree (one-shot: `setfacl -d -m u:lensuser:r-x ...`). JanuScope's block list and SURFACE BOUNDARY policy are layers 1 and 2 (defence in depth); only the OS permissions physically prevent file writes if the agent host runs `cat`, `cp`, `mv`, an editor's save, or another filesystem-shaped MCP rooted in the same path. See [SECURITY.md](../../../SECURITY.md#three-layer-model) for the full model.

## Customising

Required environment variable:

| Variable                 | Purpose                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `FILESYSTEM_ALLOWED_DIR` | Absolute path to the single directory you want the LLM to read. Add more by appending further paths to `target.args`. |

> **Recommendation**: point at a single project directory, not `$HOME`. The MCP's allow-list is the physical backstop — combined with this Lens's write-block and secret redaction, you get three independent layers protecting the filesystem.

## Usage

```json
{
  "mcpServers": {
    "fs": {
      "command": "januscope",
      "args": ["--config", "/absolute/path/to/filesystem-mcp-official/config.yaml"],
      "env": {
        "FILESYSTEM_ALLOWED_DIR": "/Users/you/projects/my-project"
      }
    }
  }
}
```

## Changelog

- **2026-04-18** — Re-probed against live `tools/list` (status: `active` → `probed`).
- **2026-04-17** — Initial contribution (@giancarloerra).
