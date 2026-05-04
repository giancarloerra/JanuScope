# Changelog

All notable changes to JanuScope are documented here.
This project uses [Conventional Commits](https://www.conventionalcommits.org/) and [Semantic Versioning](https://semver.org/).

## [0.3.0] — initial public release

Initial public release of the core engine and bundled Lens catalogue.

### Engine

- Six composable overlays: `block`, `sqlGuard`, `dbSchema`, `instructions`, `redact`, `audit`.
- Overlay kind model (`gate` vs `observer`) — security overlays (`block`, `sqlGuard`) fail-closed on handler exceptions; enhancement overlays (`audit`, `redact`, `dbSchema`, `instructions`) fail-open to preserve availability.
- `sqlGuard` allowlist mode with leading-verb analysis plus an embedded-write scan covering:
  - Data-modifying CTEs (`WITH x AS (DELETE …) SELECT …`)
  - `SELECT … INTO <table> FROM …` (CREATE TABLE AS in disguise)
  - `EXPLAIN ANALYZE` with a DML body
  - Postgres admin / filesystem / session functions (`lo_import`, `lo_export`, `pg_read_file`, `pg_write_file`, `pg_sleep`, `pg_terminate_backend`, `dblink*`, `COPY … PROGRAM`, etc.)
  - Row-locking clauses (`FOR UPDATE`, `FOR SHARE`) correctly whitelisted so legitimate reads pass through.
- `redact` with regex + JSON field-path rules. Field rules auto-parse JSON-inside-text content blocks and can extract a single embedded JSON object/array from a narrative envelope (e.g. MongoDB's `<untrusted-user-data-…>` wrapper). Regex supports PCRE-style inline flag prefixes (`(?i)`, `(?is)`, `(?m)`, `(?s)`).
- `audit` writes JSONL with SHA-256-hashed args by default, 0o600 file mode, auto-created parent directories, clean fd teardown. Full schema documented in the README.
- `dbSchema` introspection for Postgres / MySQL / SQLite with multi-schema support on Postgres.
- stdio transport with 3-stage child-process lifecycle (stdin-close → SIGTERM → SIGKILL) and proper shutdown on crash.

### Lenses

12 bundled Lenses, one per service, each pointing at the official vendor MCP where one exists:

- **Databases**: `postgres-crystaldba`, `mysql-benborla29`, `mongodb-official`, `clickhouse-official`, `redis-official`, `sqlite-panasenco`
- **Developer tools**: `github-official`, `filesystem-mcp-official`
- **SaaS**: `stripe-official`, `notion-official`, `atlassian-official`, `linear-remote`

All 12 live-probed against real target MCPs with `validate:lenses:probe`.

### CLI

- `januscope --config <path>` (or `--target <bin>`) for day-to-day use.
- `januscope lenses list / show / search` for browsing the bundled catalogue.
- `npm run validate:lenses` for static validation, `npm run validate:lenses:probe` for live `tools/list` verification against each target MCP.

### Library API

- `runOverlay(config, hooks)` for embedding the engine in custom gateways.
- `loadConfig(path)` for YAML → zod-validated config.

### Benchmarks

Published numbers are medians of 4 independent runs against `claude-sonnet-4-5` over a real Laravel/Postgres database:

- Single-question: −34% tokens, −86% tool calls, ≈3× wall-clock.
- 3-question session (prompt caching enabled): −84% tokens, −84% tool calls, ≈3× wall-clock.
- Safety (adversarial prompts): 4/4 runs where the JanuScope-wrapped pipeline blocked every PII/mutation leak; raw pipeline leaked a user email in 2/4 runs.

Raw runs and aggregator script in `.benchmarks/` (gitignored — supply your own API key and DB).

### Documentation

- Full README with quick-start, six-overlay walkthrough, configuration reference, logging & audit schema, FAQ, and license model.
- `ARCHITECTURE.md` — engine internals, pipeline ordering, JSON-RPC handling.
- `lenses/CONTRIBUTING.md` — how to submit a new Lens.
- `CONTRIBUTING.md`, `SECURITY.md`, `SUPPORT.md`, `CODE_OF_CONDUCT.md`, `CLA.md`, `LICENSE` (AGPL-3.0-only), `LICENSE-COMMERCIAL`, `THIRD-PARTY-LICENSES`.

### Tested on

Node 20+, macOS / Linux / Windows.
