---
mcp: "mcp.linear.app (Linear's official remote MCP, bridged via mcp-remote)"
mcpUrl: https://linear.app/docs/mcp
testedVersion: "2026-04"
testedAt: "2026-04-19"
maintainer: "@giancarloerra"
category: saas
status: probed
tags: [linear, issues, project-management, readonly, secret-redaction, remote-mcp, official]
---

# Linear (Official Remote MCP) — JanuScope Lens

Wraps [Linear's official MCP](https://linear.app/docs/mcp) at `https://mcp.linear.app/mcp`.

The MCP is remote-only (Streamable HTTP + SSE). This Lens bridges it to stdio via [`mcp-remote`](https://github.com/geelen/mcp-remote) — a small external npm package that proxies stdio↔HTTP and handles the OAuth flow. `npx -y` fetches it on first use; nothing to install manually. First launch opens a browser window for OAuth; subsequent launches reuse the cached token in `~/.mcp-auth/`.

## Tool surface

**Reads** — `get_attachment`, `list_comments`, `list_cycles`, `get_document`, `list_documents`, `get_issue`, `list_issues`, `list_issue_statuses`, `get_issue_status`, `list_issue_labels`, `list_projects`, `get_project`, `list_project_labels`, `list_milestones`, `get_milestone`, `list_teams`, `get_team`, `list_users`, `get_user`, `search_documentation`.

**Writes** (blocked) — `save_issue`, `save_comment`, `save_project`, `save_milestone`, `create_attachment`, `create_document`, `create_issue_label`, `delete_attachment`, `delete_comment`, `update_document`, `extract_images`.

Linear uses a `save_*` upsert pattern where a single tool handles both create and update; the block list targets `save_*` alongside the usual `create_*` / `update_*` / `delete_*` globs.

## What this Lens adds

- **`block`** — `save_*`, `create_*`, `update_*`, `delete_*` globs plus explicit `extract_images`. Forward-looking defensive entries for verbs the upstream may add (`add_*`, `remove_*`, `assign_*`, `transition_*`, `archive_*`, `unarchive_*`).
- **`instructions`** — Read-only policy plus a warning about tokens pasted into issues and comments during debugging.
- **`redact`** — Linear API keys (`lin_api_*`), GitHub PATs, AWS/GCP keys, Slack tokens, PEM private-key headers, JWTs, `password=` / `api_key=` assignments.
- **`audit`** — JSONL log at `~/mcp-audit-linear.jsonl`.

## Prerequisites

- **Read-only Linear access at the data path** (layer 3, recommended for production). Linear's hosted MCP authenticates via OAuth — its access is bounded by the authenticating user's permissions in Linear. For production deployments, authenticate with a **dedicated bot / service account** whose Linear role is **Member** or **Guest** (not Admin), and which is added only to the teams whose data the lens should read. Avoid admin-role accounts — once the OAuth token is held by another tool surface, role-bounded access is the only remaining barrier. JanuScope's block list (especially the `save_*` glob) and SURFACE BOUNDARY policy are layers 1 and 2 (defence in depth); only the account's role physically prevents writes if the agent host runs `curl` against `api.linear.app/graphql` reusing the same OAuth token. See [SECURITY.md](../../../SECURITY.md#three-layer-model) for the full model.
- `npx` available (Node.js 20+).
- A Linear workspace you can approve OAuth for. No API-key env var is needed.

## Troubleshooting

This lens runs a three-process stack: your MCP client → JanuScope → `mcp-remote` → `https://mcp.linear.app/mcp`. Most reported breakage is `mcp-remote` or OAuth state, not JanuScope itself. Work through the list below before filing an issue.

| Symptom                                                                     | Likely cause                                                               | Fix                                                                                                                                                    |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Unauthorized` / `invalid_grant` on startup                                 | Cached OAuth token expired                                                 | `rm -rf ~/.mcp-auth` and restart — a new browser tab opens for fresh OAuth                                                                             |
| `mcp-remote: command not found` or a `404` from the Linear MCP              | Stale `mcp-remote` in the npx cache                                        | `npx clear-npx-cache` (or `rm -rf ~/.npm/_npx`) — `npx -y mcp-remote` re-downloads on next launch                                                      |
| Browser window doesn't open during first OAuth                              | No default browser on a headless session                                   | Copy the printed URL and open it on another machine; the OAuth callback lands in `~/.mcp-auth/` regardless                                             |
| `getaddrinfo ENOTFOUND mcp.linear.app`                                      | Corporate proxy / TLS-inspection                                           | Export `HTTPS_PROXY=<your-proxy>` (and your CA bundle in `NODE_EXTRA_CA_CERTS` if applicable) before launching the MCP client                          |
| Intermittent `SSE stream closed` reconnect loop                             | Known upstream quirk in `mcp-remote` + SSE                                 | Restart the MCP client; update Node to ≥ 20.12                                                                                                         |
| Client logs say "MCP server disconnected" with no JanuScope diagnostic line | `mcp-remote` crashed before JanuScope's stderr got wired to the client log | Run JanuScope with `npx januscope --config …` from a terminal and watch stderr directly; the first line from either side identifies the guilty process |

## Escalating the classification

This lens ships with `classification: internal` by default. If the
content in your deployment includes regulated or PII data (for
example, GitHub repos storing customer PII; Jira tickets with
medical records; Notion pages with contracts; Linear issues
containing access tokens), bump it to `sensitive` in your local
copy of `config.yaml`. That change tightens the `instructions`
banner the LLM sees and tags every audit record so a SIEM can
route on it.
