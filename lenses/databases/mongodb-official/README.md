---
mcp: "mongodb-mcp-server"
mcpUrl: https://github.com/mongodb-js/mongodb-mcp-server
testedVersion: "2026-04 (npm latest)"
testedAt: "2026-04-18"
maintainer: "@giancarloerra"
category: databases
status: probed
tags: [mongodb, nosql, atlas, readonly]
---

# MongoDB (official mongodb-js MCP) — JanuScope Lens

Wraps [`mongodb-js/mongodb-mcp-server`](https://github.com/mongodb-js/mongodb-mcp-server), MongoDB's official Model Context Protocol server. It exposes both database operations (find, aggregate, list-databases, collection-schema) AND Atlas-management tools (atlas-create-project, atlas-create-db-user, atlas-connect-cluster, …). This lens locks it to read-only across both surfaces.

## What this lens does

- **`instructions`** — strict read-only policy covering both DB ops and Atlas ops, plus explicit PII field names
- **`block`** — hides every write-capable tool (insert / update / delete / drop / rename / create-index / Atlas create-_). Defensive `create-_`/`update-_`/`delete-_` globs catch future additions.
- **`redact`** — field-path rules on common PII (email, password, passwordHash, apiKey, token, …) + regex rules on value patterns. Field rules auto-parse JSON in tool results, so they match inside MongoDB document output.
- **`audit`** — JSONL compliance log at `~/mcp-audit-mongodb.jsonl`.

No `sqlGuard` (MongoDB isn't SQL) and no `dbSchema` (MongoDB is schema-flexible; introspection would inject the MCP's sample-based schema guess, which can be misleading on heterogeneous collections).

## Tool names this lens assumes

Partial — the MongoDB MCP is iterated on regularly and adds tools. This list covers what's documented at the time of authoring; the glob rules catch reasonable additions. Run `tools/list` against your installed version if in doubt.

| Tool                                                                               | Kind  | Treatment      |
| ---------------------------------------------------------------------------------- | ----- | -------------- |
| `find`, `aggregate`, `list-databases`, `list-collections`, `collection-schema`     | read  | passes through |
| `atlas-list-orgs`, `atlas-list-projects`, `atlas-list-clusters`, `atlas-inspect-*` | read  | passes through |
| `insert-*`, `update-*`, `delete-*`, `drop-*`, `create-*`                           | write | **blocked**    |
| `atlas-create-*`, `atlas-delete-*`, `atlas-update-*`                               | write | **blocked**    |

## Prerequisites

- **Read-only MongoDB user at the data path** (layer 3, mandatory for production). Provision the connection-string user with the `read` (or `readAnyDatabase`) role rather than `readWrite`. For Atlas-managed clusters: in the Atlas UI, create a Database User with "Only read any database" privilege — and use API credentials with the minimum-required Atlas roles for any Atlas tools you actually need. JanuScope's block list and SURFACE BOUNDARY policy are layers 1 and 2 (defence in depth); only the role physically prevents writes if the agent host runs `mongosh`, `mongodump`, or another tool surface against the same cluster. See [SECURITY.md](../../../SECURITY.md#three-layer-model) for the full model.

## Customising

Required environment variables:

| Variable                      | Purpose                          |
| ----------------------------- | -------------------------------- |
| `MONGODB_CONNECTION_STRING`   | Standard MongoDB connection URI  |
| `MONGODB_ATLAS_CLIENT_ID`     | Required if you want Atlas tools |
| `MONGODB_ATLAS_CLIENT_SECRET` | Required if you want Atlas tools |

Strong recommendation: use a **read-only MongoDB user** for the connection string. The MongoDB MCP's "require confirmation" mode for destructive tools is bypassed by blocking the tools entirely — if you want an additional physical backstop, the database user is the right place.

## Usage

```json
{
  "mcpServers": {
    "mongodb": {
      "command": "januscope",
      "args": ["--config", "/absolute/path/to/mongodb-official/config.yaml"]
    }
  }
}
```

## Changelog

- **2026-04-18** — Re-probed against live `tools/list` (status: `active` → `probed`).
- **2026-04-17** — Initial contribution (@giancarloerra).
