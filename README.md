<img src="./januscope.png" alt="JanuScope" width="96" height="96" />

# JanuScope

**Add response redaction, an audit trail, and shared policy to an existing MCP server.** JanuScope runs locally between your MCP client and the server. A YAML policy preset, called a **Lens**, selects the restrictions and context to apply.

[![CI](https://github.com/giancarloerra/januscope/actions/workflows/ci.yml/badge.svg)](https://github.com/giancarloerra/januscope/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/januscope.svg)](https://www.npmjs.com/package/januscope) [![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)

Start with Postgres: keep the MCP's restricted mode, add matching-value redaction and a local JSONL audit log, and supply schema in the SQL tool description. If native read-only controls already cover your needs, an extra proxy may be unnecessary.

JanuScope adds no hosted gateway. Upstream services, database introspection, optional secret stores, and configured telemetry can still use the network. Tool descriptions and filtered responses reach your MCP client and may reach its model provider. [Security boundaries](./SECURITY.md).

## Quick Start

### 1. Check the prerequisites

- **Node.js 20+** with `npx`.
- **[uv](https://docs.astral.sh/uv/getting-started/installation/)** with `uvx` available to your MCP client. This starts [Postgres MCP Pro](https://github.com/crystaldba/postgres-mcp).
- **A Postgres connection using a read-only database role**, with no write, DDL, administrative, or unsafe function-execution privileges. Review the [Postgres preset prerequisites](./lenses/databases/postgres-crystaldba/README.md#prerequisites).

Set `DATABASE_URI` in the environment to your read-only Postgres connection string before starting the check and client. The preset reads the `public` schema, includes schema comments in tool descriptions, and logs to `~/mcp-audit-postgres.jsonl`. Inspect the policy before connecting it to sensitive data:

```bash
npx -y januscope lenses show postgres-crystaldba
npx -y januscope check --config postgres-crystaldba
```

The check starts the target and discovers tools without invoking upstream MCP tools. When `dbSchema` is configured, startup also connects to the configured database and inspects schema metadata. A successful check does not prove backend permissions or every redaction rule. Package runners may download the upstream on first use. [Setup checks and troubleshooting](./docs/setup.md#check-a-setup).

### 2. Connect Claude Code

This complete example is for **Claude Code's `.mcp.json`** at your project root. `${DATABASE_URI}` is expanded from the environment Claude Code starts with. Keep actual credentials out of the file. If a `postgres` entry already exists, replace that entry while preserving its host options and credentials; do not configure a second unwrapped connection to the same backend.

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "januscope", "--config", "postgres-crystaldba"],
      "env": { "DATABASE_URI": "${DATABASE_URI}" }
    }
  }
}
```

Start a new Claude Code session and enable the project server when prompted. The [Claude Code documentation](https://code.claude.com/docs/en/mcp#project-scope) explains project configuration and trust. For **VS Code or other clients**, use the [host-specific setup guide](./docs/setup.md#client-configuration).

### 3. Run one query and inspect the log

Ask the client:

> Using the postgres execute_sql tool, run `SELECT 1 AS connection_ok`.

A successful connection returns `connection_ok: 1`. The preset also adds SQL filtering, schema context, and response redaction. Inspect `~/mcp-audit-postgres.jsonl` for the call's outcome. On macOS or Linux:

```bash
tail -n 5 ~/mcp-audit-postgres.jsonl
```

## What it looks like in practice

The following is a **synthetic illustration of response filtering**, not a benchmark result. If an upstream query returns this JSON row:

```json
{ "id": 1, "email": "demo@example.com", "status": "ready" }
```

The preset's matching field rule replaces the email value before forwarding it to the client:

```json
{ "id": 1, "email": "[REDACTED]", "status": "ready" }
```

An audit outcome has this shape. Values below are illustrative; successful response bodies are not stored in the log.

```json
{
  "ts": "2026-01-01T12:00:00.000Z",
  "event": "tools/call",
  "tool": "execute_sql",
  "id": 1,
  "args_hash": "sha256:0123456789abcdef",
  "status": "ok",
  "duration_ms": 12,
  "result_bytes": 120,
  "classification": "sensitive"
}
```

Redaction only covers the configured fields and patterns. Requests outside this wrapped MCP, unmatched values, and backend permissions require separate controls. [Full security model](./SECURITY.md#security-model).

## Why JanuScope

Use it when an MCP's native controls leave a specific gap: sensitive values in responses, a missing call log, repeated schema discovery, or policy that must be shared across several servers.

### Why not just use restricted mode?

The Postgres preset already enables `--access-mode=restricted`. JanuScope adds response rules, correlated audit outcomes, schema descriptions, and a keyword-based SQL check. It cannot determine arbitrary function side effects, including `SELECT dropUsers()` or `SELECT purge_audits()`. A read-only database role remains necessary.

Schema injection can reduce discovery work, but large descriptions also consume context. Measure the workflow you use. The [historical measurements](#benchmarks--measured-not-modelled) are specific to an older harness.

## What it does

| Configuration                               | Behavior                                                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `block`                                     | Hides matching tool names and rejects direct calls to them.                                                                      |
| `sqlGuard`                                  | Rejects configured SQL patterns; it is a keyword filter, not a SQL parser.                                                       |
| `redact`                                    | Replaces matching response fields and text, including JSON-RPC error payloads. Refuses the response if required redaction fails. |
| `audit`                                     | Writes correlated call outcomes to JSONL; raw arguments are opt-in.                                                              |
| `instructions`                              | Adds policy text to descriptions. The model can ignore it.                                                                       |
| `dbSchema` / `contextInjection`             | Adds database schema or supplied context to selected tool descriptions.                                                          |
| `rateLimit`                                 | Caps per-tool request rates.                                                                                                     |
| `classification` / `firstRun` / `telemetry` | Adds sensitivity labels, optional approval fingerprints, or configured tracing.                                                  |

[Detailed behavior](./docs/setup.md#what-it-does) · [Configuration reference](./docs/setup.md#configuration-reference)

## Lenses: the community ecosystem

<a id="option-a-use-a-bundled-lens-fastest-drop-in"></a>
<a id="bundled-lenses-20"></a>

The **[20 bundled presets](./docs/lenses.md)** cover databases, filesystem, GitHub, Stripe, Notion, Atlassian, and Linear. Their existing upstream and wrapped configurations are available in one readable block per service. Each preset README records its own prerequisites and tested upstream status.

```bash
npx -y januscope lenses list
npx -y januscope lenses search postgres
npx -y januscope lenses show postgres-crystaldba
```

<a id="contributing-a-lens"></a>

[Contribute a preset](./lenses/CONTRIBUTING.md) or [request one](https://github.com/giancarloerra/januscope/issues/new?template=lens_request.yml).

## Configuration reference

<a id="option-b-write-your-own-policy"></a>

Existing preset names, YAML/JSON configuration, and run flags remain available. `--config` accepts either a bundled name or a file path. A custom policy starts with the upstream process:

```yaml
target:
  command: uvx
  args: ["postgres-mcp", "--access-mode=restricted"]
```

Add the relevant controls using the [custom policy example](./docs/setup.md#write-your-own-policy) and [complete configuration reference](./docs/setup.md#configuration-reference). Use `januscope check --config /absolute/path/to/policy.yaml` before connecting the client.

## How it works

```text
MCP client <-> JanuScope <-> upstream MCP
              policy        database / service / filesystem
```

JanuScope wraps a stdio process. Remote presets start `mcp-remote` as a bridge to the configured endpoint. The bridge's authentication and network traffic still apply. Native HTTP transport is not implemented inside JanuScope.

<a id="how-dbschema-and-contextinjection-actually-work"></a>
<a id="crash-restart-and-health"></a>

[Schema and context data flow](./docs/setup.md#how-dbschema-and-contextinjection-actually-work) · [Restart and diagnostics](./docs/setup.md#crash-restart-and-health)

## Logging & audit

The Postgres preset writes call outcomes to `~/mcp-audit-postgres.jsonl`, with hashed arguments by default. New files use mode `0600`; existing file permissions are preserved. Upstream error messages are recorded before response redaction and may contain sensitive values. Audit write errors are logged without stopping forwarding, so monitor the sink when completeness matters.

Use a file or `stderr` for CLI audit output. `stdout` carries the MCP protocol. [Event schema, identity, and retention](./docs/setup.md#logging--audit).

<a id="benchmarks--measured-not-modelled"></a>

## Benchmarks: measured, not modelled

The previous report recorded **84% fewer total tokens** across a three-question Claude Sonnet 4.5/Postgres benchmark, using medians from four runs. Those historical measurements are specific to that harness and are not a validated estimate for the current setup. The original scripts and raw runs are not part of the published repository.

[Historical tables and limitations](./docs/setup.md#historical-benchmarks). A current comparison needs equivalent upstream restrictions, schema access, prompts, session history, and token accounting before supporting a new performance claim.

## Library API

```ts
import { runOverlay, loadConfig } from "januscope";

const config = loadConfig("./policy.yaml");
await runOverlay({ config });
```

Use `loadConfigAsync` for [secret-store references](./docs/setup.md#credential-vault-references-optional). [Library details](./docs/setup.md#library-api).

## JanuScope vs Claude Skills

Skills and client instructions guide tool use. JanuScope checks traffic on a wrapped MCP connection. Neither replaces backend permissions or controls another terminal tool or MCP server. [Details](./docs/setup.md#januscope-vs-claude-skills).

## FAQ

- **Only need to prevent writes?** Start with the backend's permissions and the MCP's native restricted mode.
- **Does data stay on this machine?** The proxy runs locally. Databases, remote upstreams, configured secret stores or telemetry, and the client's model provider can still receive data.
- **Can the model bypass the proxy with a terminal?** Yes, if the host gives it that separate capability. Scope credentials at the backend.
- **Will every secret be redacted?** Only values matched by configured field or regex rules. Required redaction failures are refused; unknown formats can still contain unmatched values.
- **How does setup fail?** `januscope check --config <preset-or-path>` helps locate prerequisites and discovery failures. A successful discovery check does not prove backend operations or model behavior.

[Detailed FAQ](./docs/setup.md#faq) · [Security policy](./SECURITY.md) · [Setup guide](./docs/setup.md)

## License

JanuScope is dual-licensed:

- **Open-source**: [GNU AGPL-3.0-only](./LICENSE). Free for personal use, internal company use, and open-source projects that are also AGPL-compatible. The AGPL's copyleft applies to network-facing deployments, so if you host a modified JanuScope behind an HTTP surface you must publish your modifications.
- **Commercial**: [LICENSE-COMMERCIAL](./LICENSE-COMMERCIAL). Drops the AGPL copyleft for commercial redistribution, closed-source forks, or SaaS/OEM offerings. Contact [giancarlo@altaire.com](mailto:giancarlo@altaire.com) for pricing.

Third-party software included in this repository retains its own license, see [THIRD-PARTY-LICENSES](./THIRD-PARTY-LICENSES).

Contributing: please read [CONTRIBUTING.md](./CONTRIBUTING.md) and sign the [CLA](./CLA.md). The CLA is necessary because of the dual-licensing model.

Copyright © 2026 Giancarlo Erra, Altaire Limited.

Supported by [Altaire Limited](https://altaire.com). For codebase search and dependency analysis, see [SocratiCode](https://github.com/giancarloerra/socraticode).
