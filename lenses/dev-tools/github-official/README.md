---
mcp: "github-mcp-server (GitHub official, Go)"
mcpUrl: https://github.com/github/github-mcp-server
testedVersion: "2026-04"
testedAt: "2026-04-19"
maintainer: "@giancarloerra"
category: dev-tools
status: probed
tags: [github, readonly, secret-redaction, official]
---

# GitHub (Official) — JanuScope Lens

Wraps GitHub's [official MCP server](https://github.com/github/github-mcp-server) — written in Go, maintained by GitHub, distributed as the Docker image `ghcr.io/github/github-mcp-server`.

The official server exposes two runtime safety flags this Lens leans on:

- `GITHUB_READ_ONLY=1` — MCP-layer read-only mode; hides every write tool.
- `GITHUB_TOOLSETS=…` — selectively enables only the toolsets you need.

## What this Lens adds

- **`target`** — Runs the MCP in Docker with `GITHUB_READ_ONLY=1` and a conservative `GITHUB_TOOLSETS` list (`context,repos,issues,pull_requests,code_security,dependabot,secret_protection,discussions,users`). Action-running, gist creation, stars, notifications-management, and labels are off by default — edit `config.yaml` to add them back.
- **`block`** — Proxy-layer write-verb globs (`*_write`, `create_*`, `update_*`, `delete_*`, `merge_*`, `push_*`, `fork_*`, `star_*`, `assign_*`, `add_*`, …). These hold as defence in depth if `GITHUB_READ_ONLY=1` is removed or its semantics change in a future MCP version.
- **`redact`** — Scrubs GitHub PATs in every format (`ghp_*`, `gho_*`, `ghs_*`, `ghu_*`, `github_pat_*`), AWS access keys, Google API keys, Stripe keys, JWTs, PEM private-key headers, and `password=` / `api_key=` assignments in file contents.
- **`audit`** — JSONL log at `~/mcp-audit-github.jsonl`.

## Tool surface

With the default toolsets plus `GITHUB_READ_ONLY=1`, the following reads are accessible:

| Toolset           | Tools                                                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| context           | `get_me`, `get_team_members`, `get_teams`                                                                                                                                                     |
| repos             | `get_commit`, `get_file_contents`, `get_latest_release`, `get_release_by_tag`, `get_tag`, `list_branches`, `list_commits`, `list_releases`, `list_tags`, `search_code`, `search_repositories` |
| issues            | `issue_read`, `list_issues`, `search_issues`, `list_issue_types`                                                                                                                              |
| pull_requests     | `pull_request_read`, `list_pull_requests`, `search_pull_requests`                                                                                                                             |
| code_security     | `get_code_scanning_alert`, `list_code_scanning_alerts`                                                                                                                                        |
| dependabot        | `get_dependabot_alert`, `list_dependabot_alerts`                                                                                                                                              |
| secret_protection | `get_secret_scanning_alert`, `list_secret_scanning_alerts`                                                                                                                                    |
| discussions       | `get_discussion`, `get_discussion_comments`, `list_discussion_categories`, `list_discussions`                                                                                                 |
| users             | `search_users`                                                                                                                                                                                |

## Prerequisites

- **Read-only GitHub PAT at the data path** (layer 3, mandatory for production). Use a **fine-grained personal access token** (not a classic PAT) and grant **only Read** permissions on Contents / Metadata / Issues / Pull requests / Discussions / Code security alerts — whatever your queries actually need. Avoid Write permissions on anything; avoid the classic `repo` scope which is read+write. Use `gh auth token --scopes` (or the Settings → Developer settings → Fine-grained PAT UI) to confirm before passing the token via `GITHUB_PERSONAL_ACCESS_TOKEN`. JanuScope's block list, the upstream MCP's `GITHUB_READ_ONLY=1` flag, and the SURFACE BOUNDARY policy are layers 1 and 2 (defence in depth); only the PAT scopes physically prevent writes if the agent host runs `gh`, `git push`, or `curl` against `api.github.com` reusing the same token. See [SECURITY.md](../../../SECURITY.md#three-layer-model) for the full model.
- Docker installed and running.

## Escalating the classification

This lens ships with `classification: internal` by default. If the
content in your deployment includes regulated or PII data (for
example, GitHub repos storing customer PII; Jira tickets with
medical records; Notion pages with contracts; Linear issues
containing access tokens), bump it to `sensitive` in your local
copy of `config.yaml`. That change tightens the `instructions`
banner the LLM sees and tags every audit record so a SIEM can
route on it.
