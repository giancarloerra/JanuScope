#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * CI-friendly validator for the bundled lenses.
 *
 * Modes:
 *   npm run validate:lenses           → structural validation only (YAML
 *                                        + frontmatter + schema).
 *   npm run validate:lenses --strict  → same, but stale lenses fail.
 *   npm run validate:lenses --probe   → structural + DYNAMIC probe:
 *                                        spawn each Lens's target MCP,
 *                                        run tools/list, and confirm
 *                                        every name in `block`,
 *                                        `sqlGuard.tools`, and
 *                                        `dbSchema.injectInto` matches
 *                                        at least one real tool.
 *
 * The probe mode is what would have caught the Notion / Linear / Slack /
 * Atlassian "block list matches zero real tools" bugs. It requires the
 * environment variables each Lens needs (e.g. MONGODB_CONNECTION_STRING).
 * Lenses whose env is not present are skipped with a warning, not a
 * hard failure.
 *
 * Exit codes:
 *   0  structural + (if --probe) dynamic checks all pass
 *   1  at least one lens failed structurally, or (with --probe) at least
 *      one block glob matched zero real tools
 *   2  bad invocation
 */

import { loadLenses, STALE_THRESHOLD_MONTHS, type Lens } from "../src/lenses.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

interface CliArgs {
  /** If true, stale lenses cause a non-zero exit. Default false. */
  strict: boolean;
  /** If true, spawn each Lens's target and compare block lists to tools/list. */
  probe: boolean;
  /** Per-lens probe timeout in ms. Default 90s (covers npx cold-start). */
  probeTimeoutMs: number;
  /** Override the lenses root directory (useful in CI monorepos). */
  rootDir?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { strict: false, probe: false, probeTimeoutMs: 90_000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--strict") {
      out.strict = true;
      continue;
    }
    if (arg === "--probe") {
      out.probe = true;
      continue;
    }
    if (arg === "--probe-timeout") {
      const next = argv[++i];
      if (!next) throw new Error("--probe-timeout requires ms");
      out.probeTimeoutMs = Number.parseInt(next, 10);
      // probeLens waits 2000ms before sending initialize/tools/list,
      // then waits for the MCP to respond. A total budget below ~5000ms
      // would time out before any meaningful work can happen.
      const MIN_PROBE_TIMEOUT_MS = 15000;
      if (!Number.isFinite(out.probeTimeoutMs) || out.probeTimeoutMs < MIN_PROBE_TIMEOUT_MS) {
        throw new Error(
          `--probe-timeout must be an integer >= ${MIN_PROBE_TIMEOUT_MS}ms (probeLens waits 12s for MCP startup before tools/list; mcp-remote needs 5-7s to connect HTTPS + load OAuth token).`,
        );
      }
      continue;
    }
    if (arg === "--root") {
      const next = argv[++i];
      if (!next) throw new Error("--root requires a path");
      out.rootDir = next;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP);
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

const HELP = `validate-lenses — verify every bundled lens parses and has valid metadata

Options:
  --root <dir>             Override the lenses root directory
  --strict                 Treat stale lenses as errors (default: warnings only)
  --probe                  Spawn each Lens's target MCP and verify block /
                           sqlGuard.tools / dbSchema.injectInto names against
                           the live tools/list output
  --probe-timeout <ms>     Per-lens probe timeout (default 90000)
  -h, --help               Show this help

Exit codes:
  0  all lenses parsed and (if --probe) probed clean
  1  at least one lens failed to load or had a zero-match block glob
  2  bad invocation

Docs: ../lenses/CONTRIBUTING.md
`;

/* ─────────────────── probe engine ─────────────────── */

interface ProbeOutcome {
  lensName: string;
  skipped: boolean;
  skipReason?: string;
  toolNames: string[];
  /** Literal block-rule names that match ZERO real tools. ERROR. */
  unmatchedBlockLiterals: string[];
  /** Glob block rules that match zero tools. WARN (likely defensive forward-facing glob). */
  unmatchedBlockGlobs: string[];
  /** Every name in sqlGuard.tools / dbSchema.injectInto is a literal → ERROR when missing. */
  unmatchedSqlGuardTools: string[];
  unmatchedDbSchemaTools: string[];
  spawnError?: string;
}

function compileGlob(rule: string): (name: string) => boolean {
  if (!rule.includes("*")) return (n) => n === rule;
  const escaped = rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^:]*");
  const re = new RegExp(`^${escaped}$`);
  return (n) => re.test(n);
}

function missingEnvVars(lens: Lens): string[] {
  // Deep-walk config looking for unexpanded "<UNSET:VAR>" placeholders.
  // loadLenses already substitutes env vars; any that were missing became
  // placeholders of the form <UNSET:NAME>.
  const missing = new Set<string>();
  const pattern = /<UNSET:([A-Za-z_][A-Za-z0-9_]*)>/g;
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      for (const m of value.matchAll(pattern)) missing.add(m[1]!);
      return;
    }
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) walk(v);
    }
  };
  walk(lens.config);
  return Array.from(missing).sort();
}

async function probeLens(lens: Lens, timeoutMs: number): Promise<ProbeOutcome> {
  const outcome: ProbeOutcome = {
    lensName: lens.name,
    skipped: false,
    toolNames: [],
    unmatchedBlockLiterals: [],
    unmatchedBlockGlobs: [],
    unmatchedSqlGuardTools: [],
    unmatchedDbSchemaTools: [],
  };

  const missing = missingEnvVars(lens);
  if (missing.length > 0) {
    outcome.skipped = true;
    outcome.skipReason = `missing env vars: ${missing.join(", ")}`;
    return outcome;
  }

  const target = lens.config.target;
  const env = { ...process.env, ...(target.env ?? {}) };
  const child = spawn(target.command, target.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
    ...(target.cwd ? { cwd: target.cwd } : {}),
  }) as ChildProcessWithoutNullStreams;

  const done = new Promise<void>((resolveP) => {
    let resolved = false;
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        resolveP();
      }, 1500);
    };

    let buf = "";
    let initResponded = false;
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines[lines.length - 1]!;
      for (const line of lines.slice(0, -1)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as {
            id?: number;
            result?: { tools?: Array<{ name: string }> };
            error?: { code: number; message: string };
          };
          // Proper MCP handshake: once the `initialize` response arrives
          // (id=1), THEN send notifications/initialized + tools/list.
          // Firing all three at once works for fast local MCPs but
          // slower remote ones (atlassian, notion via mcp-remote) can
          // drop the second/third request before the MCP session is
          // fully established.
          if (msg.id === 1 && !initResponded) {
            initResponded = true;
            try {
              child.stdin.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  method: "notifications/initialized",
                }) + "\n",
              );
              child.stdin.write(
                JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n",
              );
            } catch {
              /* child may have exited already */
            }
          } else if (msg.id === 2 && msg.result?.tools) {
            outcome.toolNames = msg.result.tools.map((t) => t.name);
            finish();
          } else if (msg.id === 2 && msg.error) {
            outcome.spawnError = `tools/list error ${msg.error.code}: ${msg.error.message}`;
            finish();
          }
        } catch {
          /* ignore non-JSON frames */
        }
      }
    });
    child.stderr.on("data", () => {
      /* swallow; some MCPs log banners to stderr */
    });
    child.on("error", (err) => {
      outcome.spawnError = `spawn error: ${err.message}`;
      finish();
    });
    child.on("exit", (code) => {
      if (outcome.toolNames.length === 0 && !outcome.spawnError) {
        outcome.spawnError = `target exited (code=${code ?? "?"}) before tools/list returned`;
      }
      finish();
    });

    // Send ONLY `initialize` after a startup delay. The
    // notifications/initialized + tools/list follow-ups are sent from
    // the stdout handler once the init response (id=1) arrives — that
    // handshake sequencing matters for slower remote MCPs like
    // mcp-remote-bridged Atlassian / Notion.
    //
    // Delay is long enough for the slowest-starting targets (mcp-remote
    // needs ~5-7s to read cached OAuth token + establish HTTPS + set up
    // the Streamable HTTP transport). Measured empirically; local MCPs
    // start in ~1-2s so a 12s delay adds a small constant to their
    // total but keeps the logic uniform.
    setTimeout(() => {
      try {
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "januscope-probe", version: "0" },
            },
          }) + "\n",
        );
      } catch {
        /* child may have exited already */
      }
    }, 12000);

    setTimeout(() => {
      if (outcome.toolNames.length === 0 && !outcome.spawnError) {
        outcome.spawnError = `probe timed out after ${timeoutMs}ms`;
      }
      finish();
    }, timeoutMs);
  });

  await done;

  if (outcome.spawnError) return outcome;

  // Compare block rules against real tool names. Split literals vs
  // globs so we don't false-flag defensive forward-looking patterns
  // like `linear_delete_*` on an MCP that doesn't (yet) have delete.
  if (lens.config.block) {
    for (const rule of lens.config.block) {
      const match = compileGlob(rule);
      const matched = outcome.toolNames.some(match);
      if (!matched) {
        if (rule.includes("*")) outcome.unmatchedBlockGlobs.push(rule);
        else outcome.unmatchedBlockLiterals.push(rule);
      }
    }
  }
  // sqlGuard.tools
  if (lens.config.sqlGuard?.tools) {
    for (const t of lens.config.sqlGuard.tools) {
      if (!outcome.toolNames.includes(t)) {
        outcome.unmatchedSqlGuardTools.push(t);
      }
    }
  }
  // dbSchema.injectInto
  if (lens.config.dbSchema?.injectInto) {
    for (const t of lens.config.dbSchema.injectInto) {
      if (!outcome.toolNames.includes(t)) {
        outcome.unmatchedDbSchemaTools.push(t);
      }
    }
  }
  return outcome;
}

/* ─────────────────── main ─────────────────── */

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(HELP);
    return 2;
  }

  const result = loadLenses(args.rootDir ? { rootDir: args.rootDir } : {});
  const { lenses, errors } = result;

  const staleLenses = lenses.filter((l) => l.isStale);

  // ─── Structural report ───
  process.stdout.write(`Checked ${lenses.length + errors.length} lens candidate(s)\n\n`);
  if (lenses.length > 0) {
    process.stdout.write(`✓ Valid lenses (${lenses.length}):\n`);
    for (const lens of lenses) {
      const staleFlag = lens.isStale ? ` ⚠ stale (testedAt ${lens.metadata.testedAt})` : "";
      process.stdout.write(
        `  - ${lens.relativePath.padEnd(45)} ${lens.metadata.mcp}${staleFlag}\n`,
      );
    }
    process.stdout.write("\n");
  }
  if (staleLenses.length > 0 && !args.strict) {
    process.stdout.write(
      `⚠ ${staleLenses.length} lens(es) exceed the ${STALE_THRESHOLD_MONTHS}-month testedAt threshold.\n` +
        `  Re-run the lens against its target MCP and bump testedAt in the README frontmatter.\n` +
        `  Use --strict to fail on stale lenses.\n\n`,
    );
  }
  if (errors.length > 0) {
    process.stderr.write(`✗ ${errors.length} invalid lens(es):\n\n`);
    for (const e of errors) {
      process.stderr.write(`  ${e.relativePath}\n`);
      for (const line of e.errors) process.stderr.write(`    ${line}\n`);
      process.stderr.write("\n");
    }
    process.stderr.write(
      `See lenses/CONTRIBUTING.md for the required file layout and frontmatter fields.\n`,
    );
    return 1;
  }

  // ─── Probe mode ───
  if (args.probe) {
    process.stdout.write(
      `Probing ${lenses.length} lens target(s) (per-lens timeout ${args.probeTimeoutMs}ms)…\n\n`,
    );
    let probeFailures = 0;
    const skipped: ProbeOutcome[] = [];
    for (const lens of lenses) {
      process.stdout.write(`  ${lens.name}: `);
      const outcome = await probeLens(lens, args.probeTimeoutMs);
      if (outcome.skipped) {
        skipped.push(outcome);
        process.stdout.write(`skipped (${outcome.skipReason})\n`);
        continue;
      }
      if (outcome.spawnError) {
        process.stdout.write(`unreachable (${outcome.spawnError})\n`);
        // Not a hard failure — the target may not be installable in CI.
        // Treat as a warning.
        continue;
      }
      const hardProblems =
        outcome.unmatchedBlockLiterals.length +
        outcome.unmatchedSqlGuardTools.length +
        outcome.unmatchedDbSchemaTools.length;
      const warnOnly = outcome.unmatchedBlockGlobs.length;

      if (hardProblems === 0 && warnOnly === 0) {
        process.stdout.write(`OK (${outcome.toolNames.length} tools, all rules matched)\n`);
      } else {
        if (hardProblems > 0) {
          probeFailures++;
          process.stdout.write(`PROBLEMS (${outcome.toolNames.length} tools exposed):\n`);
        } else {
          process.stdout.write(`OK with warnings (${outcome.toolNames.length} tools exposed):\n`);
        }
        if (outcome.unmatchedBlockLiterals.length > 0) {
          process.stdout.write(
            `      ✗ block literals matching no real tool (LIKELY BUG): ${outcome.unmatchedBlockLiterals.join(", ")}\n`,
          );
        }
        if (outcome.unmatchedBlockGlobs.length > 0) {
          process.stdout.write(
            `      ⚠ block globs matching no current tool (defensive forward-looking patterns): ${outcome.unmatchedBlockGlobs.join(", ")}\n`,
          );
        }
        if (outcome.unmatchedSqlGuardTools.length > 0) {
          process.stdout.write(
            `      ✗ sqlGuard.tools missing from tools/list: ${outcome.unmatchedSqlGuardTools.join(", ")}\n`,
          );
        }
        if (outcome.unmatchedDbSchemaTools.length > 0) {
          process.stdout.write(
            `      ✗ dbSchema.injectInto missing from tools/list: ${outcome.unmatchedDbSchemaTools.join(", ")}\n`,
          );
        }
      }
    }
    process.stdout.write("\n");
    if (skipped.length > 0) {
      process.stdout.write(
        `(${skipped.length} lens(es) skipped — run with the needed env vars to probe them.)\n`,
      );
    }
    if (probeFailures > 0) {
      process.stderr.write(
        `✗ --probe: ${probeFailures} lens(es) have block/sqlGuard/dbSchema names that match no real tool.\n`,
      );
      return 1;
    }
    process.stdout.write(
      "✔ --probe: every populated block / sqlGuard / dbSchema name matched at least one real tool.\n",
    );
  }

  if (args.strict && staleLenses.length > 0) {
    process.stderr.write(
      `✗ --strict: ${staleLenses.length} lens(es) are stale. Refresh testedAt to proceed.\n`,
    );
    return 1;
  }

  if (!args.probe) {
    process.stdout.write(`✔ All lenses valid${args.strict ? " (strict mode)" : ""}.\n`);
  }
  return 0;
}

void main().then((code) => {
  process.exit(code);
});
