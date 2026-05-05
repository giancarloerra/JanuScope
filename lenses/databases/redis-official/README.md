---
mcp: "redis-mcp-server (Redis Inc. official, PyPI)"
mcpUrl: https://github.com/redis/mcp-redis
testedVersion: "redis-mcp-server@latest 2026-05"
testedAt: "2026-05-02"
maintainer: "@giancarloerra"
category: databases
status: probed
tags:
  [
    redis,
    cache,
    session-store,
    key-value,
    readonly,
    pii-redaction,
    vector,
    upstash,
    elasticache,
    redis-cloud,
  ]
---

# Redis (official `redis/mcp-redis`): JanuScope Lens

Wraps [`redis/mcp-redis`](https://github.com/redis/mcp-redis), Redis Inc.'s own data-plane MCP server. Connects via standard `redis://` (plain) or `rediss://` (TLS) URIs, so the same lens works against:

- **Self-hosted Redis** (`redis://user:pass@host:6379/0`)
- **Redis Cloud** (`rediss://default:pass@<region>.redis-cloud.com:port`)
- **AWS ElastiCache for Redis** (`redis://...elasticache.amazonaws.com:6379`)
- **Upstash Redis** (`rediss://default:<rest-token>@<endpoint>.upstash.io:6379`). Upstash speaks the standard Redis protocol over TLS at port 6379, and the REST token is also the AUTH password.
- Any other Redis-protocol endpoint

The MCP runs under `uvx` (it's published on PyPI as `redis-mcp-server`, not on npm). The lens accordingly sets `target.command: uvx`.

## What this lens does

- **`block`**: hides every mutation tool (47 tools surfaced, roughly half are writes). Covers `set`, `hset`, `hdel`, `lpush`, `rpush`, `lpop`, `rpop`, `lrem`, `sadd`, `srem`, `zadd`, `zrem`, `xadd`, `xdel`, `delete`, `expire`, `rename`, `publish`, `json_set`, `json_del`, `set_vector_in_hash`, `create_vector_index_hash`, plus forward-looking globs (`flush*`, `config_*`, `debug_*`, `script_*`, `cluster_*`, `shutdown*`, `save*`).
- **`rateLimit`**: caps `scan_all_keys` at 10/min and the other iteration / search tools at 60/min. Default for everything else is 600/min. Stops a stuck-in-a-loop LLM from hammering a production Redis with full-key scans.
- **`instructions`**: read-only policy plus warnings (don't echo cached values verbatim, prefer aggregate operations, use tight `scan_keys` patterns rather than `scan_all_keys`).
- **`redact`**: heavy regex coverage on returned values (Redis is a common home for session tokens, JWTs, bcrypt hashes, Stripe / GitHub / AWS keys, PII). Field rules apply when `json_get` returns a structured payload.
- **`classification: sensitive`**: banner prepended to the policy text and tagged onto every audit record.
- **`audit`**: JSONL log at `~/mcp-audit-redis.jsonl`.

No `sqlGuard` (Redis isn't SQL) and no `dbSchema` (Redis is schema-flexible).

## Tool surface (47 tools, live-probed 2026-05-02)

| Tools                                                                                                                                                                                       | Kind             | Treatment      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------- |
| `get`, `hget`, `hgetall`, `hexists`, `get_vector_from_hash`, `json_get`, `lrange`, `llen`, `smembers`, `zrange`, `xrange`, `type`, `dbsize`, `info`, `client_list`                          | reads            | passes through |
| `scan_keys`, `scan_all_keys`, `get_indexes`, `get_index_info`, `get_indexed_keys_number`, `vector_search_hash`, `hybrid_search`, `search_redis_documents`                                   | reads (heavy)    | rate-limited   |
| `subscribe`, `unsubscribe`                                                                                                                                                                  | pub/sub listener | passes through |
| `set`, `hset`, `hdel`, `set_vector_in_hash`, `json_set`, `json_del`, `lpush`, `rpush`, `lpop`, `rpop`, `lrem`, `sadd`, `srem`, `zadd`, `zrem`, `xadd`, `xdel`, `delete`, `expire`, `rename` | mutations        | **blocked**    |
| `publish`                                                                                                                                                                                   | side effect      | **blocked**    |
| `create_vector_index_hash`                                                                                                                                                                  | schema mutation  | **blocked**    |

## Customising

Required environment variable:

| Variable    | Purpose                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL` | Standard Redis URI. Use `rediss://` for TLS (Upstash, Redis Cloud, ElastiCache encryption-in-transit). For Upstash: `rediss://default:<rest-token>@<endpoint>.upstash.io:6379`. |

> **Strong recommendation**: connect with a Redis user that is **physically read-only at the Redis ACL level** (Redis 6+ supports per-user ACLs with `~*` `&*` `+@read`). For Upstash, create a [read-only token](https://upstash.com/docs/redis/howto/connectclient#-tls-required-) in the dashboard. The proxy-layer block list is defence in depth, not the only enforcement.

## Usage

```json
{
  "mcpServers": {
    "redis": {
      "command": "januscope",
      "args": ["--config", "redis-official"],
      "env": {
        "REDIS_URL": "rediss://default:your-token-here@your-endpoint.upstash.io:6379"
      }
    }
  }
}
```

For VS Code Copilot the equivalent is `.vscode/mcp.json`; for Cursor it's `.cursor/mcp.json` (same shape).

## Prerequisites

- **Read-only credential at the data path** (layer 3, mandatory for production). For Upstash: create a separate read-only REST token in the dashboard alongside the main one and use that as the password in `REDIS_URL`. For self-hosted Redis 6+: provision a user via `ACL SETUSER readonly on >password ~* +@read` and use those credentials. JanuScope's block list and SURFACE BOUNDARY policy are layers 1 and 2 (defence in depth); only the credential physically prevents writes if the agent host runs `redis-cli` or another tool surface against the same Redis. See [SECURITY.md](../../../SECURITY.md#three-layer-model) for the full model.
- `uvx` available; install with `pipx install uv` or `brew install uv` if you don't have it.
- A Redis-protocol endpoint reachable from your machine (self-hosted, Redis Cloud, AWS ElastiCache, or Upstash). The Upstash REST URL alone will not work; use the native TLS endpoint.
- For Upstash specifically: copy the **REST API URL** plus **REST API Token** from the database page, then convert the URL form `https://<endpoint>.upstash.io` to `rediss://default:<token>@<endpoint>.upstash.io:6379`.

## Escalating the classification

This lens ships with `classification: sensitive` already, because Redis is so frequently used as a session store / hot-cache for tokens. If your specific deployment only stores non-PII data (e.g. a leaderboard with scores keyed by random IDs), you can drop the level to `internal` in your local `config.yaml` and the audit / instruction layers tighten or relax accordingly.

## Changelog

- **2026-05-02**: initial contribution (@giancarloerra). Live-probed against `redis-mcp-server@latest` connected to Upstash; 47 tools enumerated, 23 blocked.
