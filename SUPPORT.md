# Support

## Getting Help

### Documentation

- **[README](README.md)** — Quick start, lenses, benchmarks, configuration reference, FAQ
- **[Contributing guide](CONTRIBUTING.md)** — How to add a lens or improve the engine
- **[Security policy](SECURITY.md)** — Threat model, what JanuScope guarantees, how to report vulnerabilities
- **[lenses/CONTRIBUTING.md](lenses/CONTRIBUTING.md)** — Detailed lens authoring guide (tool-list probing, defensive globs, verification dates)

### Community

- **[GitHub Issues](https://github.com/giancarloerra/januscope/issues)** — Report bugs, request features, or suggest a new lens
- **[GitHub Discussions](https://github.com/giancarloerra/januscope/discussions)** — "How do I…" questions and show-and-tell

## Troubleshooting

Before opening an issue, try:

1. **Check the FAQ** in the [README](README.md#faq).
2. **Run the lens validator** — `npm run validate:lenses` catches most misconfigurations (mutually exclusive options, missing env vars, syntactically invalid block patterns).
3. **Live-probe the lens** — `npm run validate:lenses:probe` (with the target MCP's env vars set) spawns each MCP and diffs the configured block list against the real `tools/list` output. This is the same check we use to catch tool-name drift across upstream versions.
4. **Verify tool names directly** —
   ```bash
   echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | <your-mcp-command>
   ```
   and compare the returned `tools[].name` against your lens's `block:` / `sqlGuard.tools:` / `dbSchema.injectInto:`.
5. **Raise the log level** — `januscope` writes `[januscope:<overlay>] info|warn|error` lines to stderr. If a tool call doesn't look like it's being blocked when it should be, the log usually names the matching / non-matching overlay.
6. **Search existing issues** — your question may already have an answer.

## Common Issues

| Problem                                                         | Likely cause                                                                                                       | Fix                                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `block` seems to hide nothing                                   | Real tool names differ from your lens (e.g. `linear_create_issue` vs `create_issue`)                               | Run `tools/list` against the MCP and update literals / globs                                                          |
| `sqlGuard` rejects a SELECT with `FOR UPDATE`                   | It shouldn't — the guard blanks `FOR UPDATE` before scanning                                                       | File a bug with the exact SQL                                                                                         |
| `dbSchema` returns empty tables on Postgres                     | Your tables live in a non-`public` schema                                                                          | Add `dbSchema.schemas: ["analytics", "core", …]` to the lens                                                          |
| Audit file empty                                                | Sink path wrong or permission denied                                                                               | JanuScope auto-creates the parent dir with `0o600` perms since v0.3.2 — check the startup log for `[januscope:audit]` |
| Proxy refuses a request with `-32603 "gate overlay '…' failed"` | A `block` or `sqlGuard` handler threw on a malformed payload and the pipeline fail-closed (the intended behaviour) | Report the payload that triggered it                                                                                  |

## Commercial Support

For commercial licensing (non-AGPL use), enterprise support, or custom lens development, contact **[giancarlo@altaire.com](mailto:giancarlo@altaire.com)**.
