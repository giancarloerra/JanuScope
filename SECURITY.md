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

JanuScope applies configured policy at the JSON-RPC connection between an MCP client and the upstream MCP it starts. It can block tool names, filter SQL statements, redact matching response values, and record call outcomes. It does not sandbox the client, the upstream process, or other tools available to the model.

### Three-layer model

Use three layers for a backend with sensitive data:

1. **Restrict the wrapped connection**: `block` removes matching tool names from `tools/list` and refuses direct calls to them, including guessed names. `sqlGuard` checks configured SQL arguments for allowed leading verbs and known dangerous patterns. `redact` replaces matching response values. These checks cover only traffic through this JanuScope process.
2. **Advise**: `instructions` (and `contextInjection`) push policy text into the descriptions the model reads, including a SURFACE BOUNDARY paragraph forbidding bypass via the host's other tools (terminal, vendor CLI, sibling MCPs). JanuScope provides this. **It is advice, not enforcement.** Different models comply at different rates, and observed behaviour against agent hosts like VS Code Copilot shows the policy text is read but not always followed.
3. **Enforce at the backend**: a credential whose permissions exclude unintended operations. Examples include a database role without write, DDL, administrative, or unsafe function-execution privileges, or an API token scoped to the required read operations. **JanuScope cannot provide this layer.** Verify inherited permissions and callable functions as well as direct table grants.

**For any deployment where unintended backend changes matter, layer 3 is required.** A terminal, vendor CLI, or sibling MCP can reach the same backend without passing through JanuScope. Instruction text cannot enforce restrictions on those separate connections.

The bundled lens READMEs each document the recommended layer-3 shape for their backend in a `Prerequisites` section. Read them.

<a id="what-januscope-guarantees"></a>

### Enforced behavior and data flow

- **Local stdio proxy, with configurable network connections.** JanuScope has no listening HTTP server or required hosted gateway. `dbSchema` can connect to a database; secret-store resolution and optional OpenTelemetry can contact configured services. The upstream MCP or a remote bridge can also use the network. Running locally does not imply that tool traffic stays on the machine.
- **Descriptions and filtered output are sent to the client.** Injected schema includes table and column names and, when enabled, comments. `contextInjection` forwards the supplied text. The client may retain this information or send it to its model provider.
- **Request gates refuse on handler exceptions.** A failing `block` or `sqlGuard` handler returns a JSON-RPC error instead of forwarding the unchecked request. See [`src/pipeline.ts`](./src/pipeline.ts).
- **Required response redaction refuses on failure.** Configured redaction applies to successful response payloads and JSON-RPC error messages and data. Error codes and request IDs are preserved. If required redaction throws, the original response is not forwarded; the client receives a refusal. Tests cover payloads in [`test/overlays/redact-boundaries.test.ts`](./test/overlays/redact-boundaries.test.ts) and native subprocess failures in [`test/integration/redact-failure-boundary.test.ts`](./test/integration/redact-failure-boundary.test.ts).
- **New audit files use mode `0o600`.** Existing files retain their permissions. Access control also depends on the host operating system and filesystem. Audit runs before response redaction: upstream error messages may contain sensitive values even when `logRawArgs` is false. Enabling raw arguments can also store SQL, request bodies, or secrets.
- **Local state is explicit.** Audit logs and opt-in approval fingerprints persist. Configuration substitution resolves secret values for the process; it does not prevent upstream diagnostics, audit records, client configuration, package runners, or authentication bridges from storing sensitive information.

What JanuScope does **not** guarantee:

- **sqlGuard is a keyword scanner, not a parser.** It checks a leading-verb allowlist, embedded-write patterns, and a configured dangerous-function list. It cannot determine the effects of arbitrary functions, including `SELECT delete_all()`, `SELECT dropUsers()`, or `SELECT purge_audits()`. No coverage percentage is established. Use backend permissions that prevent those side effects; see the [SQL limitations](./docs/setup.md#faq).
- **LLM compliance with `instructions`.** The `instructions` overlay injects a policy string into every tool description. A model under heavy social-engineering pressure can still ignore it. `instructions` is a first layer; `block` / `sqlGuard` / `redact` / DB-level roles are the enforcing layers.
- **Complete sensitive-data detection.** Redaction covers configured field names and value patterns in supported response representations. An unmatched value, an unsupported representation, or information supplied through another channel may still contain sensitive data. Refusing a redaction exception does not turn pattern matching into a general privacy guarantee.
- **Durable or complete audit delivery.** Audit write failures are logged and forwarding continues. The sink must be monitored when completeness matters. Hashes do not make raw upstream error messages anonymous, and the local log is not tamper-proof.

## Supported Versions

Only the latest minor release on npm is supported with security updates. Older releases do not receive backports.

## Disclosure Policy

- Confirmed vulnerabilities are patched and released as soon as practical. Critical issues block a point release within 48 hours of confirmation.
- A security advisory is published on GitHub after the fix is available.
- Credit is given to reporters unless they prefer to remain anonymous.
- Known bypass-class payloads are tracked as pinning regressions in `test/overlays/sqlGuard-*.test.ts` so a future change cannot silently reintroduce them.
