<p align="center">
  <img src="./januscope.png" alt="JanuScope logo" width="500" height="500" />
</p>

# JanuScope

<p align="center">
  <a href="https://github.com/giancarloerra/januscope/actions/workflows/ci.yml"><img src="https://github.com/giancarloerra/januscope/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License: AGPL-3.0"></a>
  <a href="https://www.npmjs.com/package/januscope"><img src="https://img.shields.io/npm/v/januscope.svg" alt="npm version"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js >= 20"></a>
  <a href="https://github.com/giancarloerra/januscope"><img src="https://img.shields.io/github/stars/giancarloerra/januscope?style=social" alt="GitHub stars"></a>
</p>

> _"Whatever you see anywhere (sky, sea, clouds, lands) are all **closed and opened by my hand**."_
> _Ovid, Fasti I, 117–18 (**Janus speaking**)_

**JanuScope is a local policy proxy for MCP servers.** It adds tool restrictions, response redaction, an audit trail and useful context to the MCP servers you already use. One YAML policy, called a **Lens**, selects the rules to apply.

Use it across databases, files, developer tools and SaaS services. Choose one of the [20 bundled Lenses](./docs/lenses.md), or write a policy for your own server.

> 🧠 **Need codebase understanding together with MCP governance?** See our sibling project [**SocratiCode**](https://github.com/giancarloerra/socraticode): local-first codebase intelligence with semantic search, dependency graphs, symbol-level impact analysis.

<p align="center">
  Kindly sponsored by <a href="https://altaire.com">Altaire Limited</a>.
  We also offer a <a href="./LICENSE-COMMERCIAL">commercial license</a>
  for organisations where AGPL is a blocker.
</p>

> If JanuScope has been useful to you, please ⭐ **star this repo** (it helps others discover it) and share it with your team.

## How it works

```text
Your MCP client <-> JanuScope <-> Your existing MCP server
                   policy       database / files / service
```

Your client launches JanuScope in place of the original server. JanuScope starts that server, applies the configured rules to requests and responses, and forwards the resulting messages. Keep using the same tools in your client; the server's code does not need to change.

JanuScope runs locally. The upstream server and your client's model provider can still receive data. [Security boundaries](./SECURITY.md).

## Why JanuScope

<a id="three-problems-that-hit-every-real-mcp-deployment"></a>
<a id="todays-options-and-whats-wrong-with-them"></a>
<a id="what-makes-januscope-different"></a>

Use it when an MCP server's native controls leave a gap: sensitive values in responses, a missing call log, repeated context discovery, or policies that need to be applied consistently across several servers.

A Lens can block selected tools, redact matching fields and patterns, record calls, and add instructions or context. Database Lenses can also supply schema information and filter SQL. Choose the controls you need while retaining the backend's own permissions and native restrictions.

## Contents

- [Install](#install)
- [Quick Start: connect your MCP client](#quick-start)
- [Lenses: choose a policy](#lenses-the-community-ecosystem)
- [Configuration: write your own policy](#configuration-reference)
- [Command-line integration](#command-line-integration)
- [Library API](#library-api)
- [What it does](#what-it-does)
- [Logging and audit](#logging--audit)
- [FAQ](#faq)
- [Examples](#what-it-looks-like-in-practice)
- [Benchmarks and findings](#benchmarks--measured-not-modelled)
- [License](#license)

## Install

Requires **Node.js 20+ and npm**. Install the command-line tool:

```bash
npm install -g januscope
januscope --help
```

Or run it without a global installation; `npx` downloads and caches the package:

```bash
npx -y januscope --help
```

The commands below use `januscope`. With the `npx` option, replace that command with `npx -y januscope`.

## Quick Start

Use JanuScope with an MCP client that can launch stdio servers, and an MCP server you want to wrap. The server keeps its own installation, credentials and connection requirements; each bundled Lens documents those separately.

### 1. Choose a Lens

List the bundled policies:

```bash
januscope lenses list
```

Find your server in the [Lens catalogue](./docs/lenses.md), which includes prerequisites and ready-to-copy client entries. Inspect a policy with `januscope lenses show LENS_NAME`. Replace `LENS_NAME` throughout these examples with the name you chose.

No matching Lens? [Create a YAML policy](#configuration-reference) using your server's existing command and arguments. A policy file path can be used wherever these examples use a Lens name.

### 2. Point your MCP client at JanuScope

In your client's existing server entry, set these two fields:

```json
{
  "command": "januscope",
  "args": ["--config", "LENS_NAME"]
}
```

For the `npx` option, use:

```json
{
  "command": "npx",
  "args": ["-y", "januscope", "--config", "LENS_NAME"]
}
```

These are the server's launch fields, not a complete client configuration file. Keep the entry's existing name, credentials and other client settings. Review the chosen Lens's target settings and any documented path or argument changes. The [client configuration guide](./docs/setup.md#client-configuration) shows complete examples for individual hosts.

### 3. Check the setup and use your tools

Run the diagnostic with the same environment and working directory as your MCP client:

```bash
januscope check --config LENS_NAME
```

It checks configuration, startup and tool discovery without invoking upstream tools. A Lens with database schema injection also connects to that database to read metadata. [Diagnostic details](./docs/setup.md#check-a-setup).

Restart the MCP connection in your client and use its tools as usual. JanuScope starts the original server and applies the selected policy. If the Lens enables auditing, its configuration specifies the log destination.

[Worked examples](#what-it-looks-like-in-practice) · [Custom policies](#configuration-reference) · [All bundled Lenses](./docs/lenses.md)

## Lenses: the community ecosystem

<a id="option-a-use-a-bundled-lens-fastest-drop-in"></a>
<a id="bundled-lenses-20"></a>
<a id="lenses--the-community-ecosystem"></a>

The **[20 bundled presets](./docs/lenses.md)** cover databases, filesystem, GitHub, Stripe, Notion, Atlassian, and Linear. Their existing upstream and wrapped configurations are available in one readable block per service. Each preset README records its own prerequisites and tested upstream status.

Inspect policies with `januscope lenses show LENS_NAME`, or find them with `januscope lenses search KEYWORD`. Existing custom policies keep their own wording; no configuration migration is required.

<a id="contributing-a-lens"></a>

[Contribute a preset](./lenses/CONTRIBUTING.md) or [request one](https://github.com/giancarloerra/januscope/issues/new?template=lens_request.yml).

## Configuration reference

<a id="option-b-write-your-own-policy"></a>

`--config` accepts a bundled Lens name or a YAML/JSON file path. To wrap another server, copy its existing command and argument list into `target`. For example, this policy adds a call log:

```yaml
target:
  command: your-mcp-server
  args: []
audit:
  sink: "~/mcp-audit.jsonl"
```

Replace `your-mcp-server` and `args` with the actual launch settings, save the file as `policy.yaml`, and use its absolute path as the `--config` argument. Add the controls you need using the [complete configuration reference](./docs/setup.md#configuration-reference) or the [worked database policy](./docs/setup.md#write-your-own-policy). Existing custom policies and run flags remain supported.

## Command-line integration

A process that speaks MCP over stdin/stdout can launch JanuScope directly:

```bash
januscope --config /absolute/path/to/policy.yaml
```

For a minimal setup without a policy file, supply the original server command and the controls you want:

```bash
januscope --target "your-existing-mcp-command" --block tool_to_block --audit ./mcp-audit.jsonl
```

Replace the command and tool name with your server's actual values. This mode supports `--block`, `--instructions` and `--audit`; use a YAML/JSON policy for response redaction and the other controls. The process communicates using MCP messages over stdin/stdout. Run `januscope --help` for all options.

Remote Lenses launch `mcp-remote` as a bridge. The bridge handles the remote connection and authentication; JanuScope itself wraps a stdio process. [Transport and configuration details](./docs/setup.md#how-it-works).

<a id="how-dbschema-and-contextinjection-actually-work"></a>
<a id="crash-restart-and-health"></a>

[Schema and context data flow](./docs/setup.md#how-dbschema-and-contextinjection-actually-work) · [Restart and diagnostics](./docs/setup.md#crash-restart-and-health)

## Library API

For a Node.js or TypeScript application, install the package in your project:

```bash
npm install januscope
```

Load a policy and run the proxy:

```ts
import { runOverlay, loadConfig } from "januscope";

const config = loadConfig("./policy.yaml");
await runOverlay({ config });
```

<a id="credential-vault-references-optional"></a>

Use `loadConfigAsync` for [secret-store references](./docs/setup.md#credential-vault-references-optional). [Library details](./docs/setup.md#library-api).

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

<a id="under-the-hood-the-details-that-actually-work"></a>

[Detailed behavior](./docs/setup.md#what-it-does) · [Configuration reference](./docs/setup.md#configuration-reference)

## Logging & audit

<a id="sink"></a>
<a id="event-schema"></a>
<a id="identity-attribution"></a>
<a id="machine-readable-schema"></a>
<a id="why-the-hashed-args-default"></a>
<a id="reading-the-log"></a>
<a id="ordering-guarantee"></a>
<a id="retention--rotation"></a>

Enable `audit` in a policy and choose its destination with `audit.sink`, as in the custom policy above. Bundled Lenses specify their own destinations. Arguments are hashed by default. New files use mode `0600`; existing file permissions are preserved. Upstream error messages are recorded before response redaction and may contain sensitive values. Audit write errors are logged without stopping forwarding, so monitor the sink when completeness matters.

Use a file or `stderr` for CLI audit output. `stdout` carries the MCP protocol. [Event schema, identity, and retention](./docs/setup.md#logging--audit).

## JanuScope vs Claude Skills

Skills and client instructions guide tool use. JanuScope checks traffic on a wrapped MCP connection. Neither replaces backend permissions or controls another terminal tool or MCP server. [Details](./docs/setup.md#januscope-vs-claude-skills).

## FAQ

<a id="why-not-just-set---access-moderestricted-on-postgres-mcp-and-call-it-done"></a>

- **Only need to prevent writes?** Start with the backend's permissions and the MCP's native restricted mode.
- **Does data stay on this machine?** The proxy runs locally. Databases, remote upstreams, configured secret stores or telemetry, and the client's model provider can still receive data.
- **Can the model bypass the proxy with a terminal?** Yes, if the host gives it that separate capability. Scope credentials at the backend.
- **Will every secret be redacted?** Only values matched by configured field or regex rules. Required redaction failures are refused, but aliases, encodings and derived values can avoid a match. Restrict sensitive-data access at the backend when disclosure must be prevented.
- **How does setup fail?** `januscope check --config <preset-or-path>` helps locate prerequisites and discovery failures. A successful discovery check does not prove backend operations or model behavior.

[Detailed FAQ](./docs/setup.md#faq) · [Security policy](./SECURITY.md) · [Setup guide](./docs/setup.md)

## What it looks like in practice

### A worked server setup

The [PostgreSQL walkthrough](./docs/setup.md#example-postgresql) covers that server's prerequisites, client configuration, first query and audit log. Setup entries for every other bundled server are in the [Lens catalogue](./docs/lenses.md).

### Client responses

<p align="center">
  <img src="./assets/screenshots/policy-refusal-pii.png"
       alt="GitHub Copilot declining to return email addresses against a JanuScope-wrapped Postgres MCP, citing the lens's PII policy"
       width="48%">
  &nbsp;
  <img src="./assets/screenshots/policy-refusal-readonly.png"
       alt="GitHub Copilot declining to UPDATE an order against a JanuScope-wrapped Postgres MCP, recognising it has read-only access"
       width="48%">
</p>

<p align="center"><em>Historical GitHub Copilot responses with the PostgreSQL Lens. These screenshots illustrate client refusals; current instruction behavior and enforced controls are evaluated separately below.</em></p>

### Response filtering and audit output

The following is a **synthetic illustration of response filtering**, not a benchmark result. If an upstream query returns this JSON row:

```json
{ "id": 1, "email": "demo@example.com", "status": "ready" }
```

With a `redact` field rule for `**.email`, JanuScope replaces the email value before forwarding it to the client:

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

Redaction only covers matching output fields and patterns. Aliases, encodings and calculated results can remove those matches. Requests outside this wrapped MCP also require separate controls. [Full security model](./SECURITY.md#security-model).

<a id="benchmarks--measured-not-modelled"></a>
<a id="benchmarks-measured-not-modelled"></a>
<a id="performance-typical-analytical-question"></a>
<a id="multi-question-session-amortised-view"></a>
<a id="safety-three-adversarial-prompts"></a>
<a id="why-these-numbers-compound"></a>

## Benchmarks: accuracy, overhead and protection

The revised instructions retain backend workflows, named protected fields and rules against writes, bypasses and transformed disclosures. The PostgreSQL policy falls from 255 to 193 words; the combined text across all 20 presets grows from 3,115 to 3,745 words because terser presets gain missing explicit rules. Tool blocks, SQL checks, redaction rules, schema settings, classification and instruction placement are preserved. Existing custom policies keep their own wording; no configuration migration is required.

**The revised instructions have completed a targeted evaluation, with a known analytical failure.** Both wordings passed the conversation-history and permitted sensitive-field summary checks. On the duplicate-name case, the revised wording merged two distinct members while the original kept them separate. The PostgreSQL totals were **8/9 correct for the revised wording and 9/9 for the original**. The filesystem safe-read sentence was clarified afterward; its model trial covered aggregates and identifiers, not file excerpts. [Results and limits](./docs/benchmarks.md#targeted-27-task-follow-up).

A **225-answer synthetic PostgreSQL study** found that a 24-word prototype used **46% fewer tokens and 44% lower estimated API cost** for standalone analytical questions, with **39/39 correct analytical answers per variant** across standalone and session tests. It also returned a masked email and billing-ID suffix in one safety answer. That aggressive prototype is not the revised bundled wording.

A subsequent **182-answer comparison** of an intermediate policy retained all **21/21 standalone answers**, with approximately **22% fewer tokens and 21% lower estimated cost**. Across all analytical modes it scored **42/43**, versus **43/43** for the original: one retained-session query omitted a zero-event member. This does not establish equal effectiveness.

Separate tests using synthetic adapters for all 20 lenses isolated model guidance from executable controls. In the second complete comparison, revised wording reduced safety answers with protected-data reads from **41 to 1**, and writes from **4 to 2**, while both arms retained **20/20 correct ordinary answers**. Some refusals still offered prohibited actions. These are advisory tests, not authenticated tests of every vendor integration.

A **27-task targeted follow-up** evaluated the revised wording before that filesystem clarification. All 12 PostgreSQL conversation-history answers and all four permitted sensitive-field summaries were correct; the duplicate-name pair scored **0/1 revised versus 1/1 original**. On the matched history tasks, revised wording used **9.3% to 9.6% fewer tokens** and **8.1% to 8.8% less estimated cost**, with and without caching. The nine remaining lens tasks returned correct values supported by tool results, completing ordinary-task coverage across all **20 lenses over two runs**. Those nine answers used Markdown fences and failed the separate strict-JSON check. The earlier interrupted broad comparisons remain partial.

Forced queries also showed that encoded and aliased values can pass response rules even with full instructions. An optional restricted PostgreSQL role passed **30 allowed calls** and denied **87 protected-source calls** at the database boundary. Restrict backend access when protected fields must not reach the client or model provider.

[Methods, all completed comparisons and limitations](./docs/benchmarks.md) distinguish the wording variants, retained history, caching, actual enforcement and incomplete follow-up runs. The evidence supports useful schema context and additional policy controls; it does not establish universal savings or privacy guarantees.

## License

JanuScope is dual-licensed:

- **Open-source**: [GNU AGPL-3.0-only](./LICENSE). Free for personal use, internal company use, and open-source projects that are also AGPL-compatible. The AGPL's copyleft applies to network-facing deployments, so if you host a modified JanuScope behind an HTTP surface you must publish your modifications.
- **Commercial**: [LICENSE-COMMERCIAL](./LICENSE-COMMERCIAL). Drops the AGPL copyleft for commercial redistribution, closed-source forks, or SaaS/OEM offerings. Contact [giancarlo@altaire.com](mailto:giancarlo@altaire.com) for pricing.

Third-party software included in this repository retains its own license, see [THIRD-PARTY-LICENSES](./THIRD-PARTY-LICENSES).

Contributing: please read [CONTRIBUTING.md](./CONTRIBUTING.md) and sign the [CLA](./CLA.md). The CLA is necessary because of the dual-licensing model.

Copyright © 2026 Giancarlo Erra, Altaire Limited.

Supported by [Altaire Limited](https://altaire.com). For codebase search and dependency analysis, see [SocratiCode](https://github.com/giancarloerra/socraticode).
