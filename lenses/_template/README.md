---
mcp: "<npm-package-or-repo-path>"
mcpUrl: https://github.com/<org>/<repo>
testedVersion: "X.Y"
testedAt: "YYYY-MM-DD"
maintainer: "@your-github-handle"
category: databases
# "probed" if you captured a live tools/list (preferred; ship an
# `npm run validate:lenses:probe` transcript in the PR). Use
# "unverified" only if you lacked credentials — see CONTRIBUTING.md
# for the full enum.
status: probed
tags: [lowercase, tag, list]
---

# <Human-readable MCP name> — JanuScope Lens

> **This is a template.** Delete this file's top banner, rename the parent folder, and fill in the real content before submitting. See `lenses/CONTRIBUTING.md` for the full guide.

Wraps [`<mcp-package>`](<mcpUrl from frontmatter>). One-paragraph description of what the target MCP does and when you'd use it.

## What this lens does

Summarise which overlays are used and why. Bullet points, one per overlay:

- **`block`** — what's blocked, and why
- **`instructions`** — summary of the policy text
- **`dbSchema`** — _(if applicable)_ what's introspected
- **`redact`** — what patterns are scrubbed
- **`audit`** — where the log lands

## Tool names this lens assumes

| Tool            | Kind  | Treatment      |
| --------------- | ----- | -------------- |
| `example_read`  | read  | passes through |
| `example_write` | write | **blocked**    |

Document the tool names your `block` / `dbSchema.injectInto` lists depend on. If the target MCP renames them in a future version, that's what someone debugging a broken lens needs to know.

## Customising

Required environment variables:

| Variable     | Purpose                |
| ------------ | ---------------------- |
| `<VAR_NAME>` | What the user must set |

Common adjustments:

- Notes on which fields a user typically changes.

## Usage

```json
{
  "mcpServers": {
    "my-<name>": {
      "command": "januscope",
      "args": ["--config", "/absolute/path/to/this/config.yaml"]
    }
  }
}
```

## Changelog

- **YYYY-MM-DD** — Initial contribution (@your-github-handle).
