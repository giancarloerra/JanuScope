# JanuScope — Architecture

_Last revised: 2026-04._

## What an MCP server actually is

An MCP server is a program that speaks JSON-RPC 2.0 over either:

- **stdio** — line-delimited JSON messages on stdin/stdout (most common,
  especially for local CLI-launched servers), or
- **Streamable HTTP** — the newer remote-MCP transport.

When a client (Claude Desktop, Cursor, ChatGPT, Claude Code) connects, it
exchanges these messages:

| Method                                  | Direction       | Purpose                                    |
| --------------------------------------- | --------------- | ------------------------------------------ |
| `initialize`                            | client → server | Handshake. Declare capabilities, versions. |
| `initialized` (notification)            | client → server | Confirmation after initialize.             |
| `tools/list`                            | client → server | What tools does this server expose?        |
| `tools/call`                            | client → server | Execute a specific tool with arguments.    |
| `notifications/tools/list_changed`      | server → client | "My tool list changed — re-fetch it."      |
| `ping`, `resources/*`, `prompts/*`, ... | both            | Various other methods.                     |

A typical session looks like:

```
client → initialize
client ← initialize response (protocolVersion, capabilities, serverInfo)
client → initialized (notification)
client → tools/list
client ← { tools: [...] }
client → tools/call { name: "query", arguments: { sql: "SELECT 1" } }
client ← { content: [{ type: "text", text: "1" }] }
```

## Where JanuScope sits

```
┌──────────────┐   stdio   ┌──────────────┐   stdio   ┌──────────────┐
│  AI Client   │<─────────>│  januscope   │<─────────>│ real MCP     │
│  (Claude,    │           │              │           │ server       │
│  Cursor, …)  │           │  pipeline    │           │              │
└──────────────┘           └──────────────┘           └──────────────┘
                                  ▲
                                  │
                         policy.yaml
```

To the client, JanuScope _is_ an MCP server. To the real server, JanuScope
is just a normal client. In between, every message passes through a
**pipeline** of overlays that can inspect, modify, or reject it.

## Process model

The overlay is short-lived. When the MCP client decides to connect to a
server:

1. Client spawns `januscope --config <path>` as a child process with
   stdio pipes.
2. Overlay reads its YAML config.
3. Overlay spawns the _target_ MCP server (the `target.command` from
   config) as _its_ child, also with stdio pipes.
4. Overlay pipes stdin through its pipeline to the target's stdin; pipes
   target's stdout through its pipeline to its own stdout.
5. When the client closes its stdin, the overlay closes the target's
   stdin; the target exits; the overlay exits.

There is no daemon, no port, no persistent state (except optional audit
logs). The lifetime of the overlay is the lifetime of the client's
connection.

## Context injection: push, not pull

JanuScope takes a deliberate design stance on context. When the AI
needs to know "what tables exist in this database," there are two
architectures:

- **Pull (searchable artifacts)** — store the context somewhere the AI
  can query on demand. This is for example used by [SocratiCode](https://github.com/giancarloerra/socraticode)
  for codebases, where the data is too large to fit in prompts and
  changes often.
- **Push (pre-injection)** — bake the context directly into the tool
  description at startup. Used by JanuScope's `dbSchema` overlay,
  because database schemas are small enough (typically a few kilobytes
  of metadata) and change infrequently enough (per deploy, not per
  query) for pre-injection to work.

The upshot for `dbSchema`: **zero runtime round-trips.** The LLM sees
the schema every time it reads the tool description, which happens
before it decides to call the tool. No `describe_table` trip, no
`list_tables` trip. The first query is correct because the first query
is informed.

This choice only makes sense when the context is small and stable.
For large, fast-changing data (like a codebase), searchable artifacts
win. Different products, different regimes, same underlying question:
"how does the AI get the context it needs safely?"

## Message pipeline

```
                   incoming (from client)          outgoing (from target)
                   ─────────────────────           ──────────────────────
                        │                                   │
                        ▼                                   ▼
          ┌────────────────────────┐          ┌────────────────────────┐
          │      PRE-OVERLAYS      │          │     POST-OVERLAYS      │
          ├────────────────────────┤          ├────────────────────────┤
          │  audit   (log call)    │          │  audit   (log result)  │
          │  block   (reject call) │          │  block   (filter list) │
          │  sqlGuard (reject SQL) │          │  instructions (append) │
          │  …                     │          │  dbSchema   (inject)   │
          └────────────────────────┘          │  redact     (scrub)    │
                        │                     └────────────────────────┘
                        ▼                                   │
                 to target stdin                            ▼
                                                     to client stdout
```

Each overlay implements a small interface:

```ts
export interface Overlay {
  name: string;

  /** Invoked on every incoming message from the client. */
  onClientMessage?(
    msg: JsonRpcMessage,
    ctx: OverlayContext,
  ):
    | { kind: "forward"; msg: JsonRpcMessage }
    | { kind: "respond"; response: JsonRpcMessage } // short-circuit
    | { kind: "drop" };

  /** Invoked on every outgoing message from the target. */
  onServerMessage?(
    msg: JsonRpcMessage,
    ctx: OverlayContext,
  ): { kind: "forward"; msg: JsonRpcMessage } | { kind: "drop" };

  /** Optional one-time setup when the pipeline starts (e.g. DB connect). */
  setup?(ctx: OverlayContext): Promise<void>;

  /** Optional cleanup on shutdown. */
  teardown?(ctx: OverlayContext): Promise<void>;
}
```

Ordering matters. The pipeline is a **list** (not a set). Overlays run in
registration order **in both directions** — client→target and
target→client. This gives a single predictable rule and means that
`audit` (registered first) observes both requests and responses before
later overlays modify them, which is what compliance audit requires.

## Short-circuit (reject) flow

When `block` or `sqlGuard` detects a disallowed `tools/call`, it doesn't
forward to the target. It builds a JSON-RPC error response with the
original `id` and returns `{ kind: "respond", response }`. The pipeline
sends that response back to the client and never touches the target.
This is both faster and provably safe (no risk of the target executing
the call).

## Defence in depth

For any Lens that controls access to sensitive data, three protective
layers combine into a complete policy. Each layer covers a weakness of
the others:

| Layer                     | Overlay(s)           | Role                                                                                                                          | Limitation                                                                                                    |
| ------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Shape intent**          | `instructions`       | Tell the model _what to ask for_ in natural language, pushed into every tool description                                      | Model may forget or be jailbroken                                                                             |
| **Enforce at the gate**   | `block` + `sqlGuard` | Refuse the tool call before the target MCP sees it — `block` at tool-name granularity, `sqlGuard` at SQL-argument granularity | `block` can't partition reads/writes inside a single tool; `sqlGuard` is keyword-based, not a full SQL parser |
| **Scrub on the way back** | `redact`             | Strip PII from results before the model sees them                                                                             | Pattern matching — determined adversaries can encode around it                                                |

A typical high-assurance Lens uses **all three layers** plus a
database-level read-only role as a fourth backstop. The single-query
rule: if only one layer is deployed, an attacker who breaks that layer
wins; with three, they need to defeat independent mechanisms.

**`block` vs `sqlGuard` — when does each apply?**

- Use `block` when the target MCP separates reads and writes into
  different tools (`read_query` vs `write_query`, `search_repos` vs
  `create_repository`). Blocking the tool name is cheap and definitive.
- Use `sqlGuard` when the target MCP has a single SQL tool that accepts
  arbitrary SQL (the common case for Postgres MCPs — one `query` tool).
  `sqlGuard` inspects the SQL argument and rejects anything containing
  write keywords (`UPDATE`, `DELETE`, `DROP`, `CREATE`, `ALTER`,
  `TRUNCATE`, `GRANT`, ...). Comment-stripped before matching so
  `--` or `/* */` can't hide a mutation.
- Use `block` + `sqlGuard` together when a write-capable MCP has both
  named write tools AND a generic SQL tool. They complement rather than
  overlap.

**`sqlGuard` is a best-effort filter, not a SQL parser.** A motivated
adversary can craft statements that escape keyword matching (dynamic
SQL, extension functions, stored procedures). For high-assurance use,
combine `sqlGuard` with a physically read-only database role — the
Lens protects against casual LLM-generated mutations, the DB role
catches the rest.

## JSON-RPC framing

MCP stdio uses newline-delimited JSON (NDJSON). Our `rpc.ts` module
handles:

- A streaming parser that accumulates partial bytes until it sees `\n`.
- Safe JSON.parse with error handling (malformed frames are logged and
  dropped rather than crashing the pipeline).
- Frame serialisation (`JSON.stringify(msg) + "\n"`).
- Typed helpers for distinguishing request / response / notification /
  error messages.

## Transport: stdio native, remote via bridge

The engine is stdio-native: it spawns the target MCP as a child process and proxies JSON-RPC over stdin/stdout. Local-spawn via `command` in the client config covers the large majority of MCPs in the wild.

Remote MCPs (Streamable HTTP / SSE) are supported today via the [`mcp-remote`](https://github.com/geelen/mcp-remote) bridge — a stdio↔HTTP proxy that handles the HTTP transport and OAuth flow on behalf of any stdio-speaking parent. The `linear-remote`, `atlassian-official`, and `notion-official` bundled Lenses use this pattern; their `target.command` is simply `npx -y mcp-remote <url>`. From the engine's perspective nothing is special about these Lenses — they look like any other stdio child.

Native Streamable HTTP transport inside JanuScope itself (skipping the bridge) is planned for a post-v0.3 release, primarily to remove the extra process and correlate audit records with the HTTP request / response frames directly. The bridge is the right default for v0.3.

## Config model

A single YAML (or JSON) file drives everything:

```yaml
target:
  command: <string>          # required
  args: <string[]>           # optional
  env: <record>              # optional; process env is inherited and merged
  cwd: <string>              # optional

# Each overlay key is optional; its absence disables the overlay.

block:
  - <tool_name or glob>

instructions: <string>        # appended to every tool description

dbSchema:
  connectionString: <string>
  tables: <string[]>
  injectInto: <string[]>      # which tool names receive the schema
  format: markdown|ddl|compact

redact:
  - regex: <string>
  - field: <path>
  replacement: <string>

audit:
  sink: <path | 'stdout' | 'stderr'>
  logRawArgs: <boolean>
```

Environment variables are expanded in string values with `${VAR}` / `$VAR`
syntax (a single deliberate feature to keep secrets out of config files).

## Error handling philosophy

- **Never silently swallow errors.** Every caught error is either
  re-thrown, written to stderr with a `[januscope]` prefix, or returned
  as a JSON-RPC error to the caller. If we can't parse a frame, we log
  and drop it.
- **Fail open on overlay errors, fail closed on policy errors.** If the
  `audit` overlay can't write to its sink, we log the error and keep
  serving (availability over completeness for non-policy overlays). If
  the `block` overlay can't load its config, we refuse to start — a
  broken policy must never default to "allow."
- **Target process lifecycle.** If the target exits unexpectedly, we log,
  propagate a graceful shutdown to our own stdout (send a final error to
  any pending requests), and exit with the same code.

## Testing strategy

- **Unit tests** for each overlay's pure logic (filter a tools list, apply
  redaction regex, etc.) using Vitest.
- **Integration tests** use a fake MCP server written as a tiny Node script
  that speaks the protocol. We spawn the overlay with that fake server as
  its target, send canned messages on its stdin, and assert on its
  stdout.
- **No real DB required for v0.1 dbSchema tests** — we use SQLite
  in-memory.

See [specs/testing.md](./specs/testing.md) for details.

## Security considerations

- **Config file contains credentials.** We document this in the README and
  rely on standard practice (file permissions, env-var substitution,
  `.env` + `.gitignore`).
- **Process isolation.** The target runs as a child process, inheriting
  the overlay's env unless explicitly overridden. We do not elevate
  privileges.
- **No network listeners opened by JanuScope itself.** The proxy does not bind sockets. Remote MCPs are supported today by spawning the `mcp-remote` stdio↔HTTP bridge as a child process (same process model as any local MCP). Native Streamable HTTP transport inside JanuScope is planned for post-v0.3.
- **Audit log PII.** By default, `logRawArgs` is false — we hash args
  instead of logging them raw. Users opting in to raw arg logging take
  responsibility for securing their audit sink.
