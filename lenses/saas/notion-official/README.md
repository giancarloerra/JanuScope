---
mcp: "Notion official MCP (hosted at mcp.notion.com/mcp)"
mcpUrl: https://developers.notion.com/guides/mcp/get-started-with-mcp
testedVersion: "2026-04"
testedAt: "2026-04-19"
maintainer: "@giancarloerra"
category: saas
status: probed
tags: [notion, readonly, secret-redaction, remote-mcp, official]
---

# Notion (Official MCP) — JanuScope Lens

Wraps [Notion's official MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp) at `https://mcp.notion.com/mcp`.

Notion's documentation:

> "Notion is prioritizing, and only providing active support for, Notion MCP (remote)."

The MCP is remote-only (Streamable HTTP + SSE). This Lens bridges it to stdio via [`mcp-remote`](https://github.com/geelen/mcp-remote) — a small external npm package that proxies stdio↔HTTP and handles the OAuth flow. `npx -y` fetches it on first use; nothing to install manually. First launch opens a browser window for OAuth; subsequent launches reuse the cached token in `~/.mcp-auth/`.

## Tool surface

**Reads** — `notion-search`, `notion-fetch`, `notion-get-comments`, `notion-get-teams`, `notion-get-users`.

**Writes** (blocked) — `notion-create-pages`, `notion-update-page`, `notion-move-pages`, `notion-duplicate-page`, `notion-create-database`, `notion-update-data-source`, `notion-create-comment`, `notion-create-view`, `notion-update-view`.

## What this Lens adds

- **`block`** — Write-verb globs: `notion-create-*`, `notion-update-*`, `notion-move-*`, `notion-duplicate-*`, plus forward-looking defensive entries (`notion-delete-*`, `notion-archive-*`, `notion-add-*`, `notion-remove-*`, `notion-patch-*`).
- **`instructions`** — Read-only policy plus a warning about credentials pasted into pages (onboarding runbooks, credential lists, token dumps).
- **`redact`** — Notion integration tokens (`secret_*`, `ntn_*`), GitHub PATs, AWS/GCP/Stripe keys, Slack tokens, PEM headers, JWTs, `password=` / `api_key=` assignments.
- **`audit`** — JSONL log at `~/mcp-audit-notion.jsonl`.

## Prerequisites

- **Read-only access at the data path** (layer 3, recommended for production). Notion's hosted MCP uses OAuth on first run; the OAuth grant flow controls which pages / databases the integration can read or write. Two ways to lock this down: (1) use a **separate Notion workspace integration with read-only access** to the specific pages you want to query, and authenticate the lens with that integration's credentials; or (2) when the OAuth consent screen appears, only grant access to the pages / databases that should be exposed, and don't share write-capable pages with the integration. Notion's per-page sharing is the actual barrier — the OAuth scope flow is more permissive than most APIs. JanuScope's block list and SURFACE BOUNDARY policy are layers 1 and 2 (defence in depth); only the integration's per-page access physically prevents writes if the agent host runs `curl` against `api.notion.com` reusing the same OAuth token. See [SECURITY.md](../../../SECURITY.md#three-layer-model) for the full model.
- `npx` available (Node.js 20+).
- A Notion workspace you can approve OAuth for.

## Troubleshooting

This lens runs a three-process stack: your MCP client → JanuScope → `mcp-remote` → `https://mcp.notion.com/mcp`. Most reported breakage is `mcp-remote` or OAuth state, not JanuScope itself. Work through the list below before filing an issue.

| Symptom                                                                     | Likely cause                                                               | Fix                                                                                                                                                    |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Unauthorized` / `invalid_grant` on startup                                 | Cached OAuth token expired                                                 | `rm -rf ~/.mcp-auth` and restart — a new browser tab opens for fresh OAuth                                                                             |
| `mcp-remote: command not found` or a `404` from the Notion MCP              | Stale `mcp-remote` in the npx cache                                        | `npx clear-npx-cache` (or `rm -rf ~/.npm/_npx`) — `npx -y mcp-remote` re-downloads on next launch                                                      |
| Browser window doesn't open during first OAuth                              | No default browser on a headless session                                   | Copy the printed URL and open it on another machine; the OAuth callback lands in `~/.mcp-auth/` regardless                                             |
| `getaddrinfo ENOTFOUND mcp.notion.com`                                      | Corporate proxy / TLS-inspection                                           | Export `HTTPS_PROXY=<your-proxy>` (and your CA bundle in `NODE_EXTRA_CA_CERTS` if applicable) before launching the MCP client                          |
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
