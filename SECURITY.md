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
2. **Advise**: `instructions` adds configured policy text to tool descriptions, including explicit sensitive-field and bypass rules in the bundled lenses. `contextInjection` adds operator-supplied inline or file content to selected tool descriptions. This guidance cannot enforce restrictions on the host's other tools (terminal, vendor CLI, sibling MCPs).
3. **Enforce at the backend**: a credential whose permissions exclude unintended operations **and data access**. Examples include a database role restricted to approved columns or vetted views, without write, DDL, administrative, or unsafe function-execution privileges, or an API token scoped to the required resources and operations. **JanuScope cannot provide this layer.** Verify inherited and `PUBLIC` permissions, exposed views and callable functions as well as direct grants.

**Layer 3 is required when unintended changes or sensitive-field disclosure must be prevented.** Read-only access prevents some operations; it does not prevent reading protected values. A terminal, vendor CLI, or sibling MCP can also reach the backend without passing through JanuScope. Instruction text cannot enforce restrictions on those separate connections. See the [PostgreSQL restricted-role example](./docs/sensitive-data.md).

The bundled lens READMEs each document the recommended layer-3 shape for their backend in a `Prerequisites` section. Read them.

<a id="what-januscope-guarantees"></a>

### Enforced behavior and data flow

- **Local stdio proxy, with configurable network connections.** JanuScope has no listening HTTP server or required hosted gateway. `dbSchema` can connect to a database; secret-store resolution and optional OpenTelemetry can contact configured services. The upstream MCP or a remote bridge can also use the network. Running locally does not imply that tool traffic stays on the machine.
- **Descriptions and filtered output are sent to the client.** Injected schema includes table and column names, types, defaults and, when enabled, comments. Disabling comments affects automatic schema injection, not upstream metadata queries. `contextInjection` forwards the supplied text. The client may retain this information or send it to its model provider.
- **Gate handlers refuse on exceptions in either direction.** `block`, `rateLimit` and `sqlGuard` have handlers for client messages; `block`, `redact` and `toolSurface` have handlers for upstream messages. If a gate handler throws, the unchecked message is withheld. Messages with an `id` produce a JSON-RPC internal error for the side awaiting a response: back to the sender for requests, or to the intended recipient for responses. String, numeric and `null` IDs are retained, while other ID types become `null`. Messages without an `id`, including notifications, are dropped without an error response. See [`src/pipeline.ts`](./src/pipeline.ts).
- **Required response redaction refuses on failure.** Configured redaction applies to successful response payloads and JSON-RPC error messages and data. Successful redaction preserves the original error code and response ID. If required redaction throws, the original message is withheld. Messages with an `id` produce a JSON-RPC refusal for the side awaiting a response, using the ID handling above; messages without an `id` are dropped without a response. Tests cover payloads in [`test/overlays/redact-boundaries.test.ts`](./test/overlays/redact-boundaries.test.ts) and native subprocess failures in [`test/integration/redact-failure-boundary.test.ts`](./test/integration/redact-failure-boundary.test.ts).
- **New audit files use mode `0o600`.** Existing files retain their permissions. Access control also depends on the host operating system and filesystem. Audit runs before response redaction: upstream error messages may contain sensitive values even when `logRawArgs` is false. Enabling raw arguments can also store SQL, request bodies, or secrets.
- **Local state is explicit.** Audit logs and opt-in approval fingerprints persist. Configuration substitution resolves secret values for the process; it does not prevent upstream diagnostics, audit records, client configuration, package runners, or authentication bridges from storing sensitive information.

What JanuScope does **not** guarantee:

- **sqlGuard is a keyword scanner, not a parser.** It checks a leading-verb allowlist, embedded-write patterns, and a configured dangerous-function list. It cannot determine the effects of arbitrary functions, including `SELECT delete_all()`, `SELECT dropUsers()`, or `SELECT purge_audits()`. No coverage percentage is established. Use backend permissions that prevent those side effects; see the [SQL limitations](./docs/setup.md#faq).
- **LLM compliance with `instructions`.** The `instructions` overlay injects a policy string into every tool description. A model under heavy social-engineering pressure can still ignore it. `instructions` is a first layer; `block` / `sqlGuard` / `redact` / DB-level roles are the enforcing layers.
- **Complete sensitive-data detection.** Redaction matches output field names and value patterns, without tracing their source. Renaming a field can defeat a field-only rule; encoding, masking, fragments and calculated results can defeat value patterns. These well-formed responses need not raise a redaction exception. Views, functions and yes/no queries can expose information without returning a protected field name. Refusing a redaction exception does not turn pattern matching into a general privacy guarantee. Prevent access before evaluation with backend permissions when this boundary matters; see [sensitive-data access](./docs/sensitive-data.md).
- **Durable or complete audit delivery.** Audit write failures are logged and forwarding continues. The sink must be monitored when completeness matters. Hashes do not make raw upstream error messages anonymous, and the local log is not tamper-proof.

## Supported Versions

Only the latest minor release on npm is supported with security updates. Older releases do not receive backports.

## Disclosure Policy

- Confirmed vulnerabilities are patched and released as soon as practical. Critical issues block a point release within 48 hours of confirmation.
- A security advisory is published on GitHub after the fix is available.
- Credit is given to reporters unless they prefer to remain anonymous.
- Known bypass-class payloads are tracked as pinning regressions in `test/overlays/sqlGuard-*.test.ts` so a future change cannot silently reintroduce them.
