# Contributing to JanuScope

Thank you for your interest in contributing to JanuScope! This document explains the process for contributing and what to expect.

## Contributor License Agreement

By submitting a pull request, you agree to the [Contributor License Agreement (CLA)](CLA.md). This is necessary because JanuScope is dual-licensed (AGPL-3.0 + commercial). The CLA allows us to offer commercial licenses that include community contributions.

## Getting Started

### Prerequisites

- Node.js 20+
- Git

Optional (for live-probing bundled Lenses against real MCPs):

- API credentials for the target MCP you're verifying (Postgres connection string, Anthropic API key, etc.) — see `.benchmarks/.env.example` for the shape.

### Setup

```bash
git clone https://github.com/giancarloerra/januscope.git
cd januscope
npm install
npm run build
```

### Running Tests

```bash
# Unit + integration tests (no external services)
npm test

# Type checking
npm run typecheck

# Lens static validation (parse all bundled lenses, check block / sqlGuard /
# dbSchema entries are syntactically valid)
npm run validate:lenses

# Lens LIVE validation (spawns each target MCP, diffs block list against the
# real tools/list output). Skips lenses whose env vars aren't set.
npm run validate:lenses:probe

# All of the above
npm run typecheck && npm test && npm run validate:lenses
```

## How to Contribute

### Reporting Bugs

Open a GitHub issue. Include:

- The lens or overlay involved
- A minimal config.yaml (redact secrets!) or the JSON-RPC message shape
- Expected vs actual behaviour
- Node.js version and OS

### Suggesting Features

Open a GitHub issue with the problem you're trying to solve and your proposed approach. We care more about the problem than the solution.

### Contributing a Lens

A Lens is `lenses/<category>/<name>/config.yaml` + `README.md`. The value of JanuScope compounds with every lens, so this is the most-welcomed type of contribution.

Required:

1. **Spawn the target MCP once and run `tools/list`.** The block list, `sqlGuard.tools`, and `dbSchema.injectInto` must reference tool names that actually exist in the installed MCP. Our validator (`npm run validate:lenses:probe`) will diff these for you.
2. **Write from what the MCP returns, not from docs.** Docs drift; `tools/list` output is ground truth. Include a verification date in the lens README.
3. **Defensive globs are fine, but mark them.** A forward-looking `"delete_*"` in a MCP that doesn't expose `delete_*` today is useful — just comment that the glob is defensive so future reviewers don't think it's live.
4. **Fill the frontmatter** in the lens README (`mcp`, `mcpUrl`, `testedVersion`, `testedAt`, `maintainer`, `category`, `status`, `tags`). Our `januscope lenses` CLI parses this.
5. **Quality over quantity.** If the target MCP has a generic `call_rest_api` / `execute_tooling_query` / `api_execute` tool, a proxy-layer Lens often cannot make it safe. Prefer to drop the Lens and document the reason rather than ship something that looks protective but isn't.

See the [`lenses/CONTRIBUTING.md`](lenses/CONTRIBUTING.md) for the detailed lens authoring guide.

### Submitting Pull Requests

1. **Fork** the repository and create a branch from `main`
2. **Make your changes** — follow the existing code style and conventions
3. **Add tests** — new functionality needs test coverage; bug fixes should include a regression test that would have failed before the fix. For `sqlGuard` bugs specifically, add the new payload to the most relevant scenario file in `test/overlays/sqlGuard-*.test.ts` (UDF limits, embedded writes, Postgres admin functions).
4. **Update documentation** — if your changes affect the public API or a lens, update the relevant README.
5. **Verify** — `npm run typecheck && npm test && npm run validate:lenses`.
6. **Open a PR** — include what scenarios you considered and whether the change is a fix, a feature, or a lens update.

### Commit Message Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(redact): add embedded-JSON extraction
fix(sqlGuard): close lo_export bypass
fix(lenses): GitHub lens missing create_pull_request_review
docs: clarify Notion stdio vs hosted MCP
test: pin sqlGuard UDF-name limit
chore: bump typescript
```

Prefix with the type and optional scope, then a short imperative description.

### What Makes a Good PR

- **Focused** — one logical change per PR
- **Tested** — include a regression test where it makes sense; for security-sensitive code (block, sqlGuard, redact) this is mandatory
- **Honest** — if you fix one bypass and document another, say so. We'd rather ship with documented limits than pretend they don't exist
- **Live-probed** — for lens changes, attach the `tools/list` output you verified against
- **Clean history** — squash fixup commits before requesting review
- **Conventional commits** — use the format above

## Code Style

- **TypeScript** with strict mode enabled
- **ESM** (ES modules) — use `.js` extensions in imports
- **Overlay shape** — new overlays implement the `Overlay` interface in `src/pipeline.ts`. Set `kind: "gate"` if the overlay enforces a security boundary (block, sqlGuard); set `kind: "observer"` (or omit) for enhancers (audit, redact, dbSchema, instructions). Gate overlays fail-closed on exception; observers fail-open
- **Logging** — call `ctx.log(level, scope, message, extra)` from inside overlay handlers; never `console.log` in the engine
- **Error messages** — user-friendly, actionable. If a lens config is wrong, the error should name the field and the file
- **JSDoc** on all exported functions
- **SPDX license header** on all source files:
  ```typescript
  // SPDX-License-Identifier: AGPL-3.0-only
  // Copyright (C) 2026 Giancarlo Erra - Altaire Limited
  ```

## Project Structure

```
src/
  cli.ts                    — the `januscope` binary
  config.ts                 — zod schemas for YAML validation
  pipeline.ts               — Overlay interface + gate/observer policy
  rpc.ts                    — JSON-RPC 2.0 helpers
  runtime.ts                — wire stdio transport ↔ overlays
  transport/stdio.ts        — child-process lifecycle, SIGTERM/SIGKILL escalation
  overlays/
    block.ts                — tool-name gate
    sqlGuard.ts             — SQL-level gate (allowlist + denylist modes)
    redact.ts               — regex + JSON field-path scrubbing
    audit.ts                — JSONL log (0o600)
    instructions.ts         — policy text injection into tool descriptions
    db-schema/              — Postgres/MySQL/SQLite schema pre-injection
lenses/                     — bundled `config.yaml` + `README.md` pairs
scripts/validate-lenses.ts  — static + live lens validator
test/overlays/*.test.ts     — per-overlay tests + scenario-specific files
.benchmarks/                — gitignored local benchmark harness
```

## Review Process

- All PRs are reviewed by a maintainer.
- Every PR must leave `npm test` green and `npm run validate:lenses` clean.
- Security-sensitive changes require a regression test that would have failed before the fix.
- One approval required to merge

## Questions?

- Open a [Discussion](https://github.com/giancarloerra/januscope/discussions) for questions
- Check the [README](README.md) for user-facing docs
- Check [`ARCHITECTURE.md`](ARCHITECTURE.md) for the engine internals

Thank you for helping make JanuScope better.
