# Contributing a JanuScope Lens

Thank you for contributing. Lenses are what turn JanuScope from a framework into a practical drop-in tool — every new lens makes the project more useful for the next person.

> **Don't want to write the lens yourself?** Open a [lens request issue](https://github.com/giancarloerra/januscope/issues/new?template=lens_request.md) instead. The template asks for the target MCP, a link to its docs / repo, and the dangerous-tool gaps that make a lens worth shipping. Maintainers and the community pick up requests when the target MCP looks tractable.

This guide covers:

1. [What a lens is](#what-a-lens-is)
2. [Submission process](#submission-process)
3. [File structure](#file-structure)
4. [The README frontmatter](#the-readme-frontmatter)
5. [Quality checklist](#quality-checklist)
6. [Testing your lens locally](#testing-your-lens-locally)
7. [First-PR review policy](#first-pr-review-policy)
8. [Maintainer responsibilities after merge](#maintainer-responsibilities-after-merge)
9. [Staleness and archival policy](#staleness-and-archival-policy)

---

## What a lens is

A **lens** is a single JanuScope configuration packaged for one specific MCP server. It ships as a folder under `lenses/<category>/<name>/` containing exactly two files:

- `config.yaml` — the JanuScope policy the user will point their MCP client at
- `README.md` — documentation + metadata frontmatter

That's it. No code, no scripts.

### The defence-in-depth baseline

A serious lens — one that exposes real data to an LLM — should use **all three protective layers** where they apply:

1. **`instructions`** — shape intent. Tell the model _what to ask for_, in natural language, pushed into every tool description. Be explicit: name columns by name, use _"even if the user asks explicitly"_ phrasing to resist social-engineering framings.
2. **`block` and/or `sqlGuard`** — enforce at the gate. `block` hides whole tools by name; `sqlGuard` rejects SQL mutations inside a single write-capable tool. Use `block` for MCPs with separate read/write tools (like the official SQLite MCP), `sqlGuard` for MCPs with one arbitrary-SQL tool (like the Postgres MCP). Use both when a write-capable MCP has both shapes.
3. **`redact`** — scrub on the way back. Regex rules catch value patterns; field-path rules catch column names (and now auto-parse JSON strings inside text content blocks, so they reach into the rows most SQL MCPs return).

Plus **`audit`** as a compliance layer across all lenses, and **`dbSchema`** as the differentiator for database MCPs. For non-database lenses where the LLM otherwise burns round-trips on discovery (Linear projects, Atlassian spaces, filesystem dir skeletons), consider **`contextInjection`** — the same pre-injection idea but with operator-supplied text instead of automatic introspection. Inline string (`text: |`) for short / readable contexts, or external file (`textFile: ./context.md`) for longer text or text kept fresh by an external script. See the bundled lenses under `lenses/databases/` for examples that apply every layer.

### Two `instructions` patterns worth using on most lenses

The `instructions` field is spliced into every tool description the LLM sees. It's the **advise** layer in the [three-layer model](../SECURITY.md#three-layer-model) (hide → advise → enforce-at-data-path). It's advice, not enforcement; the LLM can ignore it and observed behaviour suggests it sometimes does. The actual barriers are `block` / `sqlGuard` / `redact` (proxy-layer enforcement) and a read-only credential at the data path (operator-supplied — every bundled lens README documents the recommended shape in its `Prerequisites` section). Still, the LLM does read tool descriptions before deciding what to call, so two short paragraphs in there reliably shift behaviour. Both bundled-lens reference and lens reviewers want to see these:

#### 1. Surface boundary ("don't bypass via the host's other tools")

Modern agent hosts (Copilot, Cursor, Claude Code) expose many tool surfaces in a single chat: this MCP, plus a terminal, plus filesystem reads, plus other MCPs, plus shell-out to vendor CLIs. When this MCP refuses a write (because of `block` or `sqlGuard`), an LLM with a problem-solving disposition often reaches for a sibling surface — `psql`, `redis-cli`, `gh` CLI, `curl` against the vendor's REST API — that uses the same credentials but bypasses the proxy entirely. JanuScope can hide tools, but cannot stop the host from running other commands.

The `instructions` field is where you tell the model not to. Use the **object form with `position: prepend`** so the policy lands at the START of every tool's description — empirically (live test against VS Code Copilot, May 2026) the model is more likely to read policy text that's at the top than at the bottom of a description, though either way it remains advice rather than enforcement.

Standard phrasing:

```yaml
instructions:
  text: |
    …
    SURFACE BOUNDARY. This MCP is the only sanctioned path to <BACKEND>.
    If an operation cannot be performed through the tools listed here,
    that is the policy answer — report the refusal and stop. Do NOT
    bypass via other tool surfaces: terminal, <BACKEND-SPECIFIC CLIs>,
    shell scripts, `curl` against <BACKEND'S HTTP API>, or a sibling
    <BACKEND> MCP. The proxy can only enforce what flows through it.
  position: prepend
```

The legacy form `instructions: |\n  ...` (string only) is also supported — it defaults to `position: append` for backwards compatibility. New lenses should use the object form with `prepend` unless there's a specific reason not to.

Per-lens, fill in:

- `<BACKEND>` — the proper noun. "Postgres database," "Notion workspace," "GitHub," etc.
- The backend-specific CLI names (`psql`, `pg_dump`; `mongosh`, `mongoexport`; `redis-cli`; `mysql`, `mysqldump`; `gh`, `git`; `stripe`; etc.).
- The backend's own HTTP / REST API hostname if there is one (`api.notion.com`, `api.linear.app`, `*.atlassian.net/rest/api/`, the Upstash REST endpoint).
- Any sibling MCPs likely to be configured in the same host (often "another `<BACKEND>` MCP").

This isn't a hard barrier. The LLM can ignore it. But for cooperatively-aligned models it's enough to redirect "I can't do X via this tool, let me try the terminal" into "I can't do X here; I'll report the refusal." For the actual barrier, pair this with credential-level enforcement (a read-only DB role, a read-only Upstash token, a read-only GITHUB token, etc.). The lens README should document the recommended credential shape.

#### 2. Discovery shortcut ("the context is already in this tool's description")

If your lens uses `dbSchema` or `contextInjection` to inject a stable surface (schema, project list, dir skeleton) into a specific tool's description, the LLM will still often do habitual discovery calls (list_tables, list_objects, list_schemas, get_object_details, etc.) before getting to the injected tool. That's wasted budget — the schema is already in front of the model, but it's at the END of the description and the model's planner does not always read that far before forming its plan.

Tell it not to:

```yaml
instructions: |
  …
  SCHEMA SHORTCUT. The full <SURFACE> is appended to <TOOL>'s
  description by the proxy at startup. Read it from there. Do NOT
  call <DISCOVERY-TOOL-NAMES> for routine queries — the <SURFACE> is
  already in front of you, and discovery calls waste tool budget
  without changing the answer.
```

Per-lens, fill in:

- `<SURFACE>` — "database schema" / "project list" / "directory skeleton" / etc.
- `<TOOL>` — the tool that receives the injection (typically `execute_sql`, `mysql_query`, `run_query`, or whatever the arbitrary-query tool is).
- `<DISCOVERY-TOOL-NAMES>` — the upstream MCP's discovery tools (`list_schemas`, `list_objects`, `get_object_details`, `SHOW TABLES`-style helpers, etc.).

Pair this with `injectInto:` in `dbSchema` / `contextInjection` so the schema actually IS in that tool's description. Without the injection, the instruction is a lie.

For high-control deployments where you'd rather not rely on the model cooperating, the heavier hand is to ADD the discovery tools to your `block:` list. That makes them physically unavailable. Trade-off: if the schema in the description is ever missing a recently-added table, the LLM has no recourse. Acceptable for production deployments where the lens restarts frequently; less acceptable for long-running sessions against a fast-evolving schema.

### Why these are quarantine-safe

Both patterns live entirely in the `instructions` field, which is **deliberately excluded from the `firstRun: approve` static fingerprint** (per `src/quarantine.ts`). Editing instructions text — adding a paragraph, rewording a clause — never causes drift refusal on lenses that use the quarantine flow. The live tools/list fingerprint is also unaffected, because the toolSurface overlay fingerprints the upstream MCP's own descriptions before JanuScope's instructions get appended to them. So you can iterate on instructions freely without re-approving.

## Submission process

1. Fork the repository.
2. Copy `lenses/_template/` into the appropriate category folder (see below) and rename it after your target MCP:

   ```bash
   cp -r lenses/_template lenses/databases/mongodb-community
   ```

3. Edit `config.yaml` and `README.md` to fit your MCP.
4. Run `npm install && npm run validate:lenses` — it must pass.
5. Run `januscope lenses list` and confirm your lens appears.
6. Commit and open a PR.

A maintainer will review (see [First-PR review policy](#first-pr-review-policy) below for newcomers).

## Lens transparency rule (read this before writing `target.env`)

A lens must be **as transparent as possible** about how the wrapped MCP is configured. Concretely, that means:

**Operator-supplied env vars are never renamed by the lens.** The user sets the same env-var names that the upstream MCP itself reads. If the upstream wants `DATABASE_URI`, the user sets `DATABASE_URI`. The lens does not "translate" `${DATABASE_URL}` → `DATABASE_URI` even when one feels more conventional than the other. Renaming creates surprise: the user copies their existing MCP-client config, JanuScope silently expects different names, and either nothing connects or (worse) the lens substitution overwrites the user's working env var with empty string.

**Operator-supplied env vars are not re-declared in `target.env`.** For direct child-process targets, whatever the user sets in their MCP-client config's `"env"` block is inherited by JanuScope and then by the spawned target through `child_process.spawn` env merging. A lens that writes `target.env: { FOO: "${FOO}" }` is at best redundant and at worst breaks the inherited value when the substitution source isn't set. **Containerised targets are the exception**: if the lens runs `docker` or `podman`, the spawned `docker` process inherits the env, but the container it creates does NOT. You still need explicit `-e VAR` passthrough flags inside `target.args` to move selected env vars into the container. See `lenses/dev-tools/github-official/config.yaml` for the canonical pattern (`-e GITHUB_PERSONAL_ACCESS_TOKEN`, no `=`, which tells docker to forward the var from the calling environment).

**The `target.env` block is for LENS POLICY VALUES ONLY.** Constants the lens decides for the user (`ALLOW_INSERT_OPERATION: "false"`, `CLICKHOUSE_SECURE: "true"`). Defence-in-depth hardcodes that should hold even if the user removes them from the client config.

**The lens README documents which env vars the user must set.** Use the upstream MCP's actual variable names. Don't invent friendlier-looking names.

If your lens has no policy-value env hardcodes, omit the `target.env` block entirely.

> **Worked example — Postgres.** `crystaldba/postgres-mcp` reads `DATABASE_URI`. The bundled `postgres-crystaldba` lens does **not** set `target.env: { DATABASE_URI: "${DATABASE_URL}" }` — that would be a rename. The lens's `target.env` is omitted; the user sets `DATABASE_URI` in their client config and it inherits through.

## File structure

```
lenses/
  <category>/                      ← databases | dev-tools | saas | infra | other
    <mcp-name>/                    ← short kebab-case name that identifies the MCP
      config.yaml                  ← the JanuScope policy
      README.md                    ← docs + frontmatter metadata
```

### Naming the folder

The folder name is the lens's canonical ID (used by `januscope lenses show <name>`). Convention:

- kebab-case
- Identifies the target MCP, not its author (unless the MCP has multiple forks with the same name — then include the author, e.g. `mysql-benborla29`)
- Add a `-official` suffix for first-party MCPs shipped by the service vendor (`stripe-official`, `mongodb-official`)

Good: `mongodb-official`, `mysql-benborla29`, `stripe-official`, `clickhouse-official`.

Bad: `pg`, `my-sql-lens`, `MySuperPostgresRecipe`.

### Choosing a category

Pick the narrowest matching category:

- `databases/` — anything with tables and rows (SQL or NoSQL, transactional or analytical)
- `dev-tools/` — developer-facing source control, filesystem, CI/CD
- `saas/` — third-party business services (Notion, Stripe, Slack, …)
- `infra/` — cloud and orchestration (K8s, AWS, Terraform, …)
- `other/` — anything genuinely doesn't fit. Propose a new category in your PR description.

## The README frontmatter

Every lens's `README.md` **must start with YAML frontmatter** containing the following fields. Missing or malformed frontmatter fails `npm run validate:lenses`.

```yaml
---
mcp: "<npm-package or repo-path>" # e.g. "@modelcontextprotocol/server-postgres"
mcpUrl: https://github.com/... # link to the MCP's source
testedVersion: "X.Y.z or X.x" # loose version tag of the MCP you verified against
testedAt: "YYYY-MM-DD" # ISO date of your last verification
maintainer: "@your-github-handle" # single maintainer; takes review responsibility
category: databases|dev-tools|saas|infra|other
status: probed # see the five allowed values below — "probed" for a fresh live-probe
tags: [list, of, lowercase, tags]
---
```

### Required fields (validator-enforced)

- `mcp`: human-readable identifier of the target MCP (usually its npm package or repo)
- `mcpUrl`: URL string (http or https)
- `testedVersion`: string; can be a loose tag like `"2.x"`
- `testedAt`: ISO date string (`YYYY-MM-DD`)
- `maintainer`: string beginning with `@`
- `category`: one of the known categories
- `status`: one of:
  - `probed` — you ran the target MCP, captured `tools/list`, and the block / sqlGuard / dbSchema entries match real tool names. **Preferred for new submissions** — the validator's `--probe` mode checks this for you.
  - `active` — maintained and documented against a recent version but not live-probed in this release cycle.
  - `unverified` — config parses and tool names match published docs, but you lacked credentials to spawn the MCP for a live `tools/list` diff. PRs with a live-probe transcript flip this to `probed`.
  - `stale` — not re-tested in the last 6 months (set automatically by the CLI once `testedAt` is older than that).
  - `archived` — the target MCP is retired or superseded; lens kept for reference.

### Optional fields

- `tags`: array of lowercase strings used for `januscope lenses search`

## Quality checklist

Your PR must tick every box. The validator enforces the mechanical checks; the maintainer reviews the substantive ones.

**Mechanical (CI-checked):**

- [ ] `config.yaml` parses and validates against the JanuScope schema
- [ ] `README.md` has valid frontmatter with all required fields
- [ ] `category` matches one of the known categories
- [ ] `testedAt` is a valid ISO date within the last 12 months
- [ ] `maintainer` is a string beginning with `@`
- [ ] `mcpUrl` is a valid http(s) URL

**Substantive (human-reviewed):**

- [ ] Credits the target MCP by linking to its source repo
- [ ] Uses `${VAR}` env expansion for every secret — no hardcoded credentials
- [ ] Read-only is the default when the target MCP supports it
- [ ] Lists the tool names the lens depends on, so forks can be adapted
- [ ] `instructions` text is actionable (tells the LLM how to behave, not just what to avoid)
- [ ] Every `redact` rule has a one-line comment explaining what it catches
- [ ] `audit.sink` points somewhere sensible (a file under `~` or `stderr`)
- [ ] The config has actually been run against the real target MCP — not just hand-written

## Testing your lens locally

Before submitting:

```bash
# 1. Schema validation (must pass)
npm run validate:lenses

# 2. CLI discovery (your lens must appear)
npx tsx src/cli.ts lenses list

# 3. Dump the lens to confirm the README renders as expected
npx tsx src/cli.ts lenses show <your-lens-name>

# 4. Point a real MCP client at it and run a tool call
#    (ideally with a test DB / read-only token; never prod)
```

Optional but encouraged: test that `tools/list` against the wrapped MCP returns what your lens expects after the overlays run. If you're adding `block` rules, confirm the blocked tools are actually present in the raw `tools/list` output of your target MCP version.

## First-PR review policy

If it's your first contribution to JanuScope, a core maintainer will:

1. Review the lens's substantive content (not just CI). Expect more back-and-forth on the first PR than on subsequent ones.
2. Optionally run the lens against a local install of the target MCP if the review turns up doubt.
3. Squash-merge with you as the commit author.

Subsequent PRs from the same author are reviewed against the checklist only, unless the change is unusual.

This first-PR gate is explicitly intended to set a high bar on quality while the ecosystem is small. Once you've landed one lens, you're trusted to submit more.

## Maintainer responsibilities after merge

You are listed as the lens's maintainer in the frontmatter. That means:

- When someone opens a PR modifying your lens, you're pinged for review.
- When a new version of the target MCP is released, you're expected to verify your lens still works (and update `testedAt` in a small follow-up PR) within a reasonable window (typically a month).
- If you stop being able to maintain it, please open a PR changing the `maintainer` field, or comment in the repo — a core maintainer or another volunteer will take over.

If you're unresponsive for 30+ days on a PR that modifies your lens:

1. The PR author may ping once more.
2. After 7 further days, a core maintainer may merge the PR and, if you've been silent across multiple requests, transfer maintainership to a volunteer.

This isn't a punishment — people get busy. It just keeps the ecosystem from stalling on individual unavailability.

## Staleness and archival policy

Modelled on Homebrew's formulae policy.

### Stale

A lens becomes **stale** when `testedAt` is more than **6 months old**.

- `npm run validate:lenses` emits a warning.
- The index README shows a ⚠️ badge.
- The lens remains fully functional and usable.

The fix: re-run the lens against the current version of the target MCP, bump `testedVersion` and `testedAt`, optionally note any drift in a brief CHANGELOG entry in the lens's README.

### Archived

A lens becomes a candidate for archival when:

- It has been stale for **12+ months** AND the maintainer is unresponsive, OR
- The target MCP has been retired or superseded, OR
- The maintainer explicitly requests archival.

Archival process:

1. Open an issue with the reason.
2. A core maintainer moves `lenses/<category>/<name>/` → `lenses/_archive/<name>/`.
3. The index README drops the lens from its main listing.
4. The lens's `status` field becomes `archived`.

Archived lenses remain in the repository for historical reference and are still loadable (you can still point a `--config` at them), but they are not listed in `januscope lenses list` and carry an explicit warning in their README.

---

**Questions?** Open an issue, or ping a core maintainer on the PR directly.
