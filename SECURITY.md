# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in JanuScope, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, email **[giancarlo@altaire.com](mailto:giancarlo@altaire.com)** with:

- A description of the vulnerability (ideally with a minimal repro: a lens config, an MCP message, and what shouldn't have been forwarded / blocked / redacted)
- Steps to reproduce
- Potential impact
- Any suggested fixes (optional)

You will receive an acknowledgment within 48 hours and a detailed response within 7 days indicating next steps.

## Scope

This policy covers:

- The `januscope` engine (`src/`): the overlay pipeline (`block`, `sqlGuard`, `dbSchema`, `instructions`, `redact`, `audit`) and stdio transport.
- The bundled Lenses (`lenses/`): `config.yaml` and README pairs distributed with the npm package.
- The CLI (`januscope` binary) and library API (`runOverlay`, `Pipeline`).

Out of scope:

- Third-party MCP servers JanuScope wraps: those are maintained upstream. Report tool-level vulnerabilities in e.g. `@modelcontextprotocol/server-postgres` to that project.
- LLM behaviour: if a wrapped model ignores an `instructions` overlay, that is a prompt-robustness issue, not a JanuScope vulnerability. Concrete reproductions are still useful and welcome via the reporting channel above.
- User-authored Lenses: if you write your own `config.yaml` with a permissive block list, that's a configuration question, not a vulnerability.

## Security Model

JanuScope is a **policy proxy**, not a sandbox. It enforces tool-name blocking, SQL statement filtering, payload redaction, and audit logging at the JSON-RPC layer between an MCP client (usually an LLM) and an MCP server (database, API, filesystem adapter).

### Three-layer model

For any backend with sensitive data, the realistic deployment shape is three layers stacked, each closing a class of failure the other two cannot:

1. **Hide**: `block` removes write tools from `tools/list` so the LLM never sees them. The model can't call a tool it doesn't know exists. `sqlGuard` is the SQL-level analogue: it removes write SQL from a single combined-read-write tool. JanuScope provides this.
2. **Advise**: `instructions` (and `contextInjection`) push policy text into the descriptions the model reads, including a SURFACE BOUNDARY paragraph forbidding bypass via the host's other tools (terminal, vendor CLI, sibling MCPs). JanuScope provides this. **It is advice, not enforcement.** Different models comply at different rates, and observed behaviour against agent hosts like VS Code Copilot shows the policy text is read but not always followed.
3. **Enforce at the data path**: a credential that physically cannot mutate, configured upstream of JanuScope. Examples: a Postgres role with `GRANT SELECT` and nothing else; an Upstash read-only REST token; a fine-grained GitHub PAT with read-only scopes; a Stripe Restricted API Key (`rk_*`) scoped to read endpoints. **JanuScope cannot provide this layer.** It depends on the backend's own authorisation system.

For demo or non-production use, layers 1 and 2 alone are usually enough (your data is throwaway, the agent is supervised). **For any deployment where data corruption matters, layer 3 is mandatory.** When the agent host's terminal or another MCP touches the same backend with the same credentials (a failure mode demonstrated live against JanuScope on 2026-05-04: VS Code Copilot received the SURFACE BOUNDARY instruction, acknowledged it when asked, and still proposed a `redis-cli` bypass on its own initiative), layers 1 and 2 stop being enforcement and become signalling. The credential is what stops the write.

The bundled lens READMEs each document the recommended layer-3 shape for their backend in a `Prerequisites` section. Read them.

### What JanuScope guarantees

- **No data exfiltration by the proxy itself.** The proxy runs as a child process of the MCP client, communicates only over stdio, and does not open network listeners or make outbound network calls on its own.
- **Block / sqlGuard are "fail-closed" gates.** If a gate overlay throws on a malformed payload, the message is refused with a JSON-RPC error rather than forwarded to the target. (See `src/pipeline.ts` and `test/pipeline.test.ts`.)
- **Audit logs are user-only (`0o600`) at creation.** With `logRawArgs: true` the file may contain raw SQL / request bodies; we set tight perms so default-umask environments don't leak. Existing audit files keep their current mode; rotate to a fresh sink if you enable raw logging later.
- **No credentials stored by the proxy.** API keys and DB passwords flow through `${ENV_VAR}` substitution in `config.yaml` and are never written to disk by JanuScope.

What JanuScope does **not** guarantee:

- **sqlGuard is a keyword scanner, not a parser.** It catches the 95% case (leading-verb allowlist, embedded-write scan, Postgres dangerous-function denylist: `lo_import`/`lo_export`/`pg_read_file`/`pg_write_file`/`pg_sleep`/`pg_terminate_backend`/`dblink*`/`COPY … PROGRAM`/etc.) but cannot distinguish a UDF whose name starts with a write-verb fragment (e.g. `SELECT delete_all()`, `SELECT dropUsers()`; the regex's `\b` word boundary does not fire inside `delete_all`). See the README FAQ for the documented limits. The recommended backstop is a read-only DB role.
- **LLM compliance with `instructions`.** The `instructions` overlay injects a policy string into every tool description. A model under heavy social-engineering pressure can still ignore it. `instructions` is a first layer; `block` / `sqlGuard` / `redact` / DB-level roles are the enforcing layers.
- **Perfect regex redaction.** The `redact` overlay uses regex + JSON-in-text field rules. A payload in an unexpected format, or a secret in a format we don't match, will pass through. The default lenses have conservative patterns; audit your own.

## Supported Versions

Only the latest minor release on npm is supported with security updates. Older releases do not receive backports.

## Disclosure Policy

- Confirmed vulnerabilities are patched and released as soon as practical. Critical issues block a point release within 48 hours of confirmation.
- A security advisory is published on GitHub after the fix is available.
- Credit is given to reporters unless they prefer to remain anonymous.
- Known bypass-class payloads are tracked as pinning regressions in `test/overlays/sqlGuard-*.test.ts` so a future change cannot silently reintroduce them.
