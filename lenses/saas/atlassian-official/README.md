---
mcp: "atlassian-mcp-server (official Rovo MCP, hosted)"
mcpUrl: https://github.com/atlassian/atlassian-mcp-server
testedVersion: "2026-04 (live hosted at mcp.atlassian.com/v1/mcp)"
testedAt: "2026-04-19"
maintainer: "@giancarloerra"
category: saas
status: probed
tags: [atlassian, jira, confluence, readonly, secret-redaction, remote-mcp, official]
---

# Atlassian (Official Rovo MCP) — JanuScope Lens

Wraps [Atlassian's official Rovo MCP Server](https://github.com/atlassian/atlassian-mcp-server) at `https://mcp.atlassian.com/v1/mcp`, maintained by Atlassian and hosted on Cloudflare. Covers Jira, Confluence, and Compass.

The Rovo MCP is remote-only (Streamable HTTP + SSE). This Lens bridges it to stdio via [`mcp-remote`](https://github.com/geelen/mcp-remote) — a small external npm package that proxies stdio↔HTTP and handles the OAuth flow. `npx -y` fetches it on first use; nothing to install manually. First launch opens a browser window for OAuth 2.1; subsequent launches reuse the cached token in `~/.mcp-auth/`.

## Tool surface

**Reads** — `atlassianUserInfo`, `getAccessibleAtlassianResources`, `getConfluencePage`, `searchConfluenceUsingCql`, `getConfluenceSpaces`, `getPagesInConfluenceSpace`, `getConfluencePageFooterComments`, `getConfluencePageInlineComments`, `getConfluenceCommentChildren`, `getConfluencePageDescendants`, `getJiraIssue`, `getTransitionsForJiraIssue`, `getJiraIssueRemoteIssueLinks`, `getVisibleJiraProjects`, `getJiraProjectIssueTypesMetadata`, `getJiraIssueTypeMetaWithFields`, `searchJiraIssuesUsingJql`, `lookupJiraAccountId`, `getIssueLinkTypes`, `search`, `fetch`.

**Writes** (blocked) — `createConfluencePage`, `updateConfluencePage`, `createConfluenceFooterComment`, `createConfluenceInlineComment`, `editJiraIssue`, `createJiraIssue`, `addCommentToJiraIssue`, `transitionJiraIssue`, `addWorklogToJiraIssue`, `createIssueLink`.

## What this Lens adds

- **`block`** — Write-verb globs on camelCase names (`create*`, `update*`, `edit*`, `add*`, `transition*`) plus forward-looking defensive entries (`delete*`, `remove*`, `archive*`, `move*`, `upload*`, `bulk*`, `batch*`, `reply*`, `assign*`).
- **`instructions`** — Read-only policy plus a warning about pasted credentials in tickets and pages.
- **`redact`** — Atlassian API tokens (`ATATT*`), GitHub PATs, AWS/GCP/Stripe keys, Slack tokens, PEM private-key headers, JWTs, `password=` / `api_key=` assignments in free text.
- **`audit`** — JSONL log at `~/mcp-audit-atlassian-official.jsonl`.

## Prerequisites

- **Read-only Atlassian access at the data path** (layer 3, recommended for production). The Rovo MCP authenticates via OAuth — its access is bounded by the user / service account's permissions in Jira, Confluence, and Compass. For production deployments, authenticate the lens with a **dedicated service account** whose Atlassian role grants only Browse / View / Read permissions on the projects and spaces in scope; never with an admin or project-lead account. Atlassian Cloud's permission scheme (Project Permissions for Jira; Space Permissions for Confluence) is the actual barrier — OAuth scope alone is not enough because authenticated users inherit their account's full Atlassian role. JanuScope's block list and SURFACE BOUNDARY policy are layers 1 and 2 (defence in depth); only the account's role physically prevents writes if the agent host runs `curl` against `*.atlassian.net/rest/api/` reusing the same token. See [SECURITY.md](../../../SECURITY.md#three-layer-model) for the full model.
- `npx` available (Node.js 20+).
- An Atlassian Cloud account. Free tier at [atlassian.com/software/free](https://www.atlassian.com/software/free) works.
- Ability to approve OAuth in your browser on first launch.

The Rovo MCP is Cloud-only — Server / Data Center deployments are not supported upstream.

## Troubleshooting

This lens runs a three-process stack: your MCP client → JanuScope → `mcp-remote` → `https://mcp.atlassian.com/v1/mcp`. Most reported breakage is `mcp-remote` or OAuth state, not JanuScope itself. Work through the list below before filing an issue.

| Symptom                                                                     | Likely cause                                                               | Fix                                                                                                                                                    |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Unauthorized` / `invalid_grant` on startup                                 | Cached OAuth 2.1 token expired                                             | `rm -rf ~/.mcp-auth` and restart — a new browser tab opens for fresh OAuth                                                                             |
| `mcp-remote: command not found` or a `404` from the Rovo MCP                | Stale `mcp-remote` in the npx cache                                        | `npx clear-npx-cache` (or `rm -rf ~/.npm/_npx`) — `npx -y mcp-remote` re-downloads on next launch                                                      |
| Browser window doesn't open during first OAuth                              | No default browser on a headless session                                   | Copy the printed URL and open it on another machine; the OAuth callback lands in `~/.mcp-auth/` regardless                                             |
| `getaddrinfo ENOTFOUND mcp.atlassian.com`                                   | Corporate proxy / TLS-inspection                                           | Export `HTTPS_PROXY=<your-proxy>` (and your CA bundle in `NODE_EXTRA_CA_CERTS` if applicable) before launching the MCP client                          |
| Intermittent `SSE stream closed` reconnect loop                             | Known upstream quirk in `mcp-remote` + SSE                                 | Restart the MCP client; update Node to ≥ 20.12                                                                                                         |
| Tool names don't match this lens's block list                               | Rovo MCP is iterated on continuously and may rename                        | From a clone of the repo, run `npm run validate:lenses:probe` to diff the block list against the live `tools/list`; open a PR with the updated names   |
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
