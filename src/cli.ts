#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * JanuScope CLI entry.
 *
 * Usage:
 *   januscope --config <path>
 *   januscope --target "<command>" [--block tool1,tool2] [--instructions "..."] [--audit <sink>]
 *   januscope lenses list
 *   januscope lenses show <name>
 *   januscope lenses search <query>
 *   januscope --version
 *   januscope --help
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { renderBootSummary, shouldPrintBootSummary } from "./boot-summary.js";
import { loadConfigAsync, validateConfig, type OverlayConfig } from "./config.js";
import { runOverlay } from "./index.js";
import { loadLenses, type Lens } from "./lenses.js";
import { probeTarget } from "./probe.js";
import { recordApproval, recordLiveToolsApproval } from "./quarantine.js";

/* ─────────────────── shared types ─────────────────── */

interface RunArgs {
  config?: string;
  target?: string;
  block?: string;
  instructions?: string;
  audit?: string;
  version?: boolean;
  help?: boolean;
}

type LensesSubcommand = "list" | "show" | "search";

interface LensesArgs {
  subcommand?: LensesSubcommand;
  lensName?: string;
  searchQuery?: string;
  help?: boolean;
}

/* ─────────────────── help text ─────────────────── */

const HELP = `JanuScope — policy, context, and guardrails for any MCP server

Usage:
  januscope --config <path>
  januscope --target "<command>" [--block a,b] [--instructions "..."] [--audit <sink>]
  januscope lenses <list|show|search> [args...]
  januscope approve --config <path>

Options:
  -c, --config <path>       YAML or JSON config file
      --target "<cmd>"      Target MCP command (minimal mode, no config file)
      --block a,b,c         Comma-separated tool names to block
      --instructions "..."  Policy text appended to tool descriptions
      --audit <sink>        Audit sink: stderr | stdout | file path
  -v, --version             Print version and exit
  -h, --help                Show this help

Lens discovery:
  januscope lenses list               List every bundled lens
  januscope lenses show <name>        Print a lens's config + README
  januscope lenses search <query>     Find lenses matching a query (name, mcp, or tag)

Quarantine:
  januscope approve --config <path>   Record the lens fingerprint. Required
                                      whenever a lens with \`firstRun: approve\`
                                      drifts from its last-approved surface.

Environment:
  JANUSCOPE_QUIET=1                   Suppress the startup boot summary on
                                      stderr (also: JANUSCOPE_NO_BOOT_SUMMARY=1).

Docs: https://github.com/giancarloerra/januscope
`;

const LENSES_HELP = `januscope lenses — browse the bundled lens library

Usage:
  januscope lenses list                List every bundled lens
  januscope lenses show <name>         Print a lens's config.yaml + README.md
  januscope lenses search <query>      Find lenses by name, MCP package, or tag

See lenses/CONTRIBUTING.md for how to contribute a new lens.
`;

/* ─────────────────── entry / dispatch ─────────────────── */

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // Subcommand dispatch: `januscope lenses ...` delegates to a separate
  // parser so the run-mode flags don't interfere.
  if (argv[0] === "lenses") {
    return runLensesSubcommand(argv.slice(1));
  }
  if (argv[0] === "approve") {
    return runApproveSubcommand(argv.slice(1));
  }

  let args: RunArgs;
  try {
    args = parseRunArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(HELP);
    return 2;
  }

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.version) {
    process.stdout.write(readPackageVersion() + "\n");
    return 0;
  }

  let config: OverlayConfig;
  try {
    if (args.config) {
      // `--config` accepts either a path to a YAML/JSON file or the
      // bare name of a bundled lens (e.g. `postgres-crystaldba`). We
      // detect the difference by shape rather than by trying both,
      // so `--config nonexistent-lens` doesn't fall back to "treat
      // it as a relative path" and produce a confusing fs error.
      const resolvedPath = resolveConfigArg(args.config);
      // Async path supports `${vault://…}` / `${aws-sm://…}` /
      // `${1pw://…}` references transparently; it degrades to
      // the sync path's behaviour for plain env-var configs.
      config = await loadConfigAsync(resolvedPath);
    } else {
      config = buildConfigFromFlags(args);
    }
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  // Boot summary — prints to stderr the version, target, and one line
  // per active overlay so the operator can confirm at a glance that
  // the wrap is live and the right policy is loaded. Stdout is the
  // JSON-RPC pipe and is never touched here. Suppress with
  // JANUSCOPE_QUIET=1 (broad) or JANUSCOPE_NO_BOOT_SUMMARY=1 (specific).
  // The try/catch is defensive — a write to a closed stderr would
  // throw EPIPE; cosmetic logging must never break the bridge.
  if (shouldPrintBootSummary()) {
    try {
      process.stderr.write(renderBootSummary(config, readPackageVersion()));
    } catch {
      /* ignore — never let cosmetic logging block the bridge */
    }
  }

  try {
    await runOverlay({ config });
    return 0;
  } catch (err) {
    process.stderr.write(
      `fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    return 1;
  }
}

/* ─────────────────── run-mode arg parsing ─────────────────── */

function parseRunArgs(argv: string[]): RunArgs {
  const out: RunArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--config":
      case "-c": {
        const next = argv[++i];
        if (!next) throw new Error("--config requires a path");
        out.config = next;
        break;
      }
      case "--target": {
        const next = argv[++i];
        if (!next) throw new Error("--target requires a command");
        out.target = next;
        break;
      }
      case "--block": {
        const next = argv[++i];
        if (!next) throw new Error("--block requires a comma-separated list");
        out.block = next;
        break;
      }
      case "--instructions": {
        const next = argv[++i];
        if (!next) throw new Error("--instructions requires a string");
        out.instructions = next;
        break;
      }
      case "--audit": {
        const next = argv[++i];
        if (!next) throw new Error("--audit requires a sink");
        out.audit = next;
        break;
      }
      case "--version":
      case "-v":
        out.version = true;
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

/* ─────────────────── lenses subcommand ─────────────────── */

async function runLensesSubcommand(argv: string[]): Promise<number> {
  let args: LensesArgs;
  try {
    args = parseLensesArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(LENSES_HELP);
    return 2;
  }

  if (args.help) {
    process.stdout.write(LENSES_HELP);
    return 0;
  }
  if (!args.subcommand) {
    process.stdout.write(LENSES_HELP);
    return 0;
  }

  const result = loadLenses();
  const lenses = result.lenses;
  const errors = result.errors;

  if (errors.length > 0) {
    process.stderr.write(
      `warning: ${errors.length} lens(es) failed to load; run 'npm run validate:lenses' for details\n`,
    );
  }

  switch (args.subcommand) {
    case "list":
      return runLensesList(lenses);
    case "show":
      if (!args.lensName) {
        process.stderr.write("error: 'lenses show' requires a lens name\n");
        process.stderr.write(LENSES_HELP);
        return 2;
      }
      return runLensesShow(lenses, args.lensName);
    case "search":
      if (!args.searchQuery) {
        process.stderr.write("error: 'lenses search' requires a query\n");
        process.stderr.write(LENSES_HELP);
        return 2;
      }
      return runLensesSearch(lenses, args.searchQuery);
  }
}

function parseLensesArgs(argv: string[]): LensesArgs {
  const out: LensesArgs = {};
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (!out.subcommand) {
      if (arg === "list" || arg === "show" || arg === "search") {
        out.subcommand = arg;
        continue;
      }
      throw new Error(`unknown lenses subcommand: ${arg}`);
    }
    // Positional argument after the subcommand.
    if (out.subcommand === "show" && out.lensName === undefined) {
      out.lensName = arg;
      continue;
    }
    if (out.subcommand === "search" && out.searchQuery === undefined) {
      out.searchQuery = arg;
      continue;
    }
    throw new Error(`unexpected argument: ${arg}`);
  }
  return out;
}

function runLensesList(lenses: Lens[]): number {
  if (lenses.length === 0) {
    process.stdout.write("No lenses found.\n");
    return 0;
  }
  const byCategory = new Map<string, Lens[]>();
  for (const lens of lenses) {
    const existing = byCategory.get(lens.metadata.category);
    if (existing) existing.push(lens);
    else byCategory.set(lens.metadata.category, [lens]);
  }
  const nameWidth = Math.max(...lenses.map((l) => l.name.length), 20);
  for (const [category, group] of [...byCategory.entries()].sort()) {
    process.stdout.write(`\n${category}\n`);
    process.stdout.write("".padEnd(category.length, "-") + "\n");
    for (const lens of group) {
      const stale = lens.isStale ? " (stale)" : "";
      process.stdout.write(`  ${lens.name.padEnd(nameWidth)}  ${lens.metadata.mcp}${stale}\n`);
    }
  }
  process.stdout.write(`\n${lenses.length} lens(es) total.\n`);
  return 0;
}

function runLensesShow(lenses: Lens[], name: string): number {
  const lens = lenses.find((l) => l.name === name);
  if (!lens) {
    process.stderr.write(`error: no lens named '${name}'\n`);
    const suggestions = lenses
      .filter((l) => l.name.includes(name) || name.includes(l.name))
      .slice(0, 3);
    if (suggestions.length > 0) {
      process.stderr.write(`did you mean: ${suggestions.map((l) => l.name).join(", ")}?\n`);
    } else {
      process.stderr.write(`run 'januscope lenses list' to see all lenses.\n`);
    }
    return 1;
  }
  process.stdout.write(`# Lens: ${lens.name}\n`);
  process.stdout.write(`Location: ${lens.relativePath}\n`);
  process.stdout.write(`MCP: ${lens.metadata.mcp} (${lens.metadata.mcpUrl})\n`);
  process.stdout.write(
    `Maintainer: ${lens.metadata.maintainer} | Tested: ${lens.metadata.testedAt} (${lens.metadata.testedVersion})\n`,
  );
  if (lens.isStale) {
    process.stdout.write(`Status: active but stale (tested more than 6 months ago)\n`);
  } else {
    process.stdout.write(`Status: ${lens.metadata.status}\n`);
  }
  process.stdout.write("\n");
  process.stdout.write("--- README.md ---\n\n");
  process.stdout.write(lens.readme);
  if (!lens.readme.endsWith("\n")) process.stdout.write("\n");
  process.stdout.write("\n--- config.yaml ---\n\n");
  try {
    process.stdout.write(readFileSync(join(lens.absolutePath, "config.yaml"), "utf8"));
  } catch (err) {
    process.stderr.write(
      `warning: could not re-read config.yaml: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  return 0;
}

function runLensesSearch(lenses: Lens[], rawQuery: string): number {
  const query = rawQuery.toLowerCase();
  const matches = lenses.filter((l) => {
    const haystack = [
      l.name.toLowerCase(),
      l.metadata.mcp.toLowerCase(),
      l.metadata.category.toLowerCase(),
      ...(l.metadata.tags ?? []).map((t) => t.toLowerCase()),
    ];
    return haystack.some((h) => h.includes(query));
  });
  if (matches.length === 0) {
    process.stdout.write(`No lenses match '${rawQuery}'.\n`);
    return 0;
  }
  const nameWidth = Math.max(...matches.map((l) => l.name.length), 20);
  for (const lens of matches) {
    const tags = lens.metadata.tags ? ` [${lens.metadata.tags.join(", ")}]` : "";
    process.stdout.write(`  ${lens.name.padEnd(nameWidth)}  ${lens.metadata.mcp}${tags}\n`);
  }
  process.stdout.write(`\n${matches.length} match(es).\n`);
  return 0;
}

/* ─────────────────── approve subcommand ─────────────────── */

const APPROVE_HELP = `januscope approve — record a fingerprint approval for a lens

Usage:
  januscope approve --config <path> [--no-probe] [--probe-timeout <ms>]

What it does:
  1. Records the STATIC fingerprint (target command, block list,
     sqlGuard tools, rateLimit rules, redact rule shapes) to
     ~/.januscope/approved.json.
  2. Probes the live target MCP (sends initialize + tools/list) and
     records the LIVE tools fingerprint alongside.

Subsequent launches of a lens with \`firstRun: approve\` compare both
fingerprints against this baseline; either one drifting refuses
startup (static layer) or rewrites tools/list to a JSON-RPC error
(live layer) until you re-run approve.

Options:
  --config <path>       The lens config to approve.
  --no-probe            Skip the live probe and record only the
                        static fingerprint. The live fingerprint
                        will TOFU on the first actual run instead.
                        Useful when the target's env vars are not
                        available at approve time.
  --probe-timeout <ms>  Per-probe timeout (default 90000).
`;

async function runApproveSubcommand(argv: string[]): Promise<number> {
  let configPath: string | undefined;
  let probe = true;
  let probeTimeoutMs = 90_000;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      process.stdout.write(APPROVE_HELP);
      return 0;
    }
    if (a === "--config" || a === "-c") {
      const next = argv[++i];
      if (!next) {
        process.stderr.write("error: --config requires a path\n");
        return 2;
      }
      configPath = next;
    } else if (a === "--no-probe") {
      probe = false;
    } else if (a === "--probe-timeout") {
      const next = argv[++i];
      if (!next) {
        process.stderr.write("error: --probe-timeout requires ms\n");
        return 2;
      }
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed < 15_000) {
        process.stderr.write("error: --probe-timeout must be an integer >= 15000ms\n");
        return 2;
      }
      probeTimeoutMs = parsed;
    } else {
      process.stderr.write(`error: unknown argument: ${a}\n`);
      process.stderr.write(APPROVE_HELP);
      return 2;
    }
  }
  if (!configPath) {
    process.stderr.write("error: --config is required\n");
    process.stderr.write(APPROVE_HELP);
    return 2;
  }

  let config: OverlayConfig;
  let resolvedPath: string;
  try {
    // Same path-vs-name auto-detection as the main run-mode dispatcher
    // (see resolveConfigArg). Lets `januscope approve --config <name>`
    // work for bundled lenses without forcing the operator to chase
    // down an absolute path.
    resolvedPath = resolveConfigArg(configPath);
    config = await loadConfigAsync(resolvedPath);
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  resolvedPath = resolve(resolvedPath);

  // Step 1 — static. Always runs. The live probe below depends on
  // the static entry already existing in approved.json (so the live
  // fingerprint attaches to a known identity).
  const staticResult = recordApproval(config, { configPath: resolvedPath });

  // Step 2 — live. Spawns the target, drives the standard MCP
  // handshake, captures tools/list, hashes the result, persists.
  // Skipped only when --no-probe is set or when the operator's
  // intent is "lens is approved but I'll let the live layer TOFU
  // on next run". The default is to probe so an interactive
  // operator gets atomic re-baselining of both layers.
  let liveResult: { fingerprint: string; toolCount: number; serverInfo: string } | null = null;
  let probeError: string | null = null;
  if (probe) {
    try {
      const probed = await probeTarget(config, { timeoutMs: probeTimeoutMs });
      const recorded = recordLiveToolsApproval(config, probed.tools);
      liveResult = {
        fingerprint: recorded.fingerprint,
        toolCount: probed.tools.length,
        serverInfo: `${probed.serverInfo.name} v${probed.serverInfo.version}`,
      };
    } catch (err) {
      probeError = err instanceof Error ? err.message : String(err);
    }
  }

  process.stdout.write(`januscope approve — recorded approval\n\n`);
  process.stdout.write(
    `  target:       ${config.target.command} ${(config.target.args ?? []).join(" ")}\n`,
  );
  process.stdout.write(`  block rules:  ${config.block?.length ?? 0}\n`);
  process.stdout.write(`  sqlGuard:     ${config.sqlGuard ? "yes" : "no"}\n`);
  process.stdout.write(`  rateLimit:    ${config.rateLimit?.length ?? 0} rule(s)\n`);
  process.stdout.write(`  redact rules: ${config.redact?.rules.length ?? 0}\n`);
  process.stdout.write(`\n  identity:          ${staticResult.identity.slice(0, 16)}…\n`);
  process.stdout.write(`  static fingerprint: ${staticResult.fingerprint.slice(0, 16)}…\n`);
  if (liveResult) {
    process.stdout.write(
      `  live fingerprint:   ${liveResult.fingerprint.slice(0, 16)}… (${liveResult.toolCount} tools, ${liveResult.serverInfo})\n`,
    );
  } else if (probe && probeError) {
    process.stdout.write(`  live fingerprint:   <probe failed>\n`);
  } else {
    process.stdout.write(`  live fingerprint:   <skipped, will TOFU on first run>\n`);
  }
  process.stdout.write(`  stored at:         ${staticResult.path}\n`);

  if (probe && probeError) {
    process.stderr.write(
      `\nwarning: live probe failed — only the static fingerprint was recorded.\n` +
        `  reason: ${probeError}\n` +
        `  The live fingerprint will TOFU on the next actual run, OR you can\n` +
        `  re-run \`januscope approve --config <path>\` once the target is reachable.\n` +
        `  Pass --no-probe to suppress this warning if the static-only baseline\n` +
        `  is what you want.\n`,
    );
  }

  process.stdout.write(
    `\nThe lens can now start under \`firstRun: approve\`. Any change to the\n` +
      `static lens surface (block list, sqlGuard, rateLimit, redact rules,\n` +
      `target command) refuses startup; any change to the upstream MCP's\n` +
      `live tools/list (names, descriptions, input schemas, annotations)\n` +
      `rewrites tools/list to a JSON-RPC error. Either condition is cleared\n` +
      `by re-running \`januscope approve --config <path>\`.\n`,
  );
  // Probe failure is a soft failure: the static layer is recorded,
  // and the operator has a clear remediation. Exit 0 so re-running
  // the command isn't blocked by, e.g., temporarily unreachable
  // credentials. Exit 0 also for the no-probe path.
  return 0;
}

/* ─────────────────── helpers ─────────────────── */

/**
 * Resolve a `--config` argument to a YAML/JSON path on disk.
 *
 * The argument is either:
 *   - the **bare name** of a bundled lens (e.g. `postgres-crystaldba`),
 *     in which case we look it up in the bundled lens registry and
 *     return the absolute path of its `config.yaml`; or
 *   - a **path** to a YAML/JSON file (anything else), passed through
 *     untouched so the existing loader can resolve it (relative,
 *     absolute, `~`-prefixed, all handled downstream).
 *
 * The detection is shape-based, not "try one then the other": we want
 * `--config postgres-typo` to fail fast with "no such bundled lens",
 * not silently fall through to a confusing fs error about a relative
 * path that doesn't exist.
 *
 * Anything that contains a path separator, starts with `.` or `~`, or
 * ends in a YAML/JSON extension is a path. Everything else is a
 * bundled-lens name. Lens names are always kebab-case identifiers
 * with no dots or slashes, so the heuristic is unambiguous.
 */
function resolveConfigArg(value: string): string {
  if (looksLikePath(value)) return value;
  const result = loadLenses();
  const found = result.lenses.find((l) => l.name === value);
  if (!found) {
    const available = result.lenses.map((l) => l.name).sort();
    const sample = available.slice(0, 6).join(", ");
    throw new Error(
      `no bundled lens named "${value}" and value does not look like a path.\n` +
        `  Available bundled lenses (${available.length} total): ${sample}${available.length > 6 ? ", ..." : ""}\n` +
        `  Run \`januscope lenses list\` for the full list, or pass a YAML/JSON path.`,
    );
  }
  return join(found.absolutePath, "config.yaml");
}

function looksLikePath(value: string): boolean {
  if (value.length === 0) return false;
  // Path separators (POSIX or Windows).
  if (value.includes("/") || value.includes("\\")) return true;
  // Relative or home-relative prefixes.
  if (value.startsWith(".") || value.startsWith("~")) return true;
  // YAML / JSON extensions.
  const lower = value.toLowerCase();
  if (lower.endsWith(".yaml") || lower.endsWith(".yml") || lower.endsWith(".json")) return true;
  return false;
}

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/cli.js -> ../package.json
  const candidates = [join(here, "..", "package.json"), join(here, "..", "..", "package.json")];
  for (const path of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(path, "utf8")) as { version?: string };
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      /* try next */
    }
  }
  return "0.0.0";
}

function buildConfigFromFlags(args: RunArgs): OverlayConfig {
  if (!args.target) {
    throw new Error("either --config or --target is required (try --help)");
  }
  const [command, ...rest] = tokenizeCommand(args.target);
  if (!command) {
    throw new Error("--target is empty");
  }
  const raw: Record<string, unknown> = {
    target: { command, args: rest },
  };
  if (args.block) {
    raw.block = args.block
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (args.instructions) {
    raw.instructions = args.instructions;
  }
  if (args.audit) {
    raw.audit = { sink: args.audit };
  }
  return validateConfig(raw);
}

/**
 * Small shell-like tokenizer: splits on whitespace, respects single
 * and double quotes. Sufficient for the `--target` CLI convenience
 * flag; for anything complex use a config file.
 */
function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/* ─────────────────── direct-invocation guard ─────────────────── */

// When run directly (not imported), invoke main and set exit code.
// Compare normalised filesystem paths so this works on Windows too,
// where `file://` URLs use backslash/encoding conventions that differ
// from process.argv[1].
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  void main().then((code) => {
    process.exit(code);
  });
}
