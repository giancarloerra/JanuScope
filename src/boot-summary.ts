// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * Boot summary — a small stderr block printed by the CLI on startup so
 * the operator can confirm at a glance that JanuScope wrapped the right
 * target with the right policy. Without it, a misconfigured lens looks
 * indistinguishable from a working one until the first tool call returns
 * something unexpected.
 *
 * Design constraints:
 *   - **Stderr-only.** Stdout is the JSON-RPC pipe; touching it kills
 *     the bridge. Every write here goes through the caller's
 *     `process.stderr.write` (we just produce a string).
 *   - **Pure.** This module does no I/O. The CLI decides when to write
 *     and where; library consumers can call `renderBootSummary` from
 *     their own startup path or skip it entirely.
 *   - **Defensive opt-out.** `JANUSCOPE_QUIET=1` (broad silence) and
 *     `JANUSCOPE_NO_BOOT_SUMMARY=1` (specific) both suppress, plus a
 *     defensive `process.stderr.writable === false` check so we never
 *     throw when stderr is closed (e.g. detached daemons).
 *   - **Bounded length.** Long `target.args` get truncated so the
 *     header never spans more than one terminal line in normal cases.
 */
import type { OverlayConfig } from "./config.js";

/**
 * Maximum width for the rendered target command before truncation.
 * Picked to fit comfortably on an 80-col terminal alongside the
 * "JanuScope vX.Y.Z → " prefix.
 */
const TARGET_MAX_WIDTH = 60;

/**
 * Should the CLI print the boot summary?
 *
 * Returns `false` when:
 *   - `JANUSCOPE_QUIET` is set to a truthy value (broad silence flag)
 *   - `JANUSCOPE_NO_BOOT_SUMMARY` is set to a truthy value (specific)
 *   - stderr is not writable (closed by a parent or detached daemon)
 *
 * The env-var checks treat `"0"`, `"false"`, and empty string as off so
 * `JANUSCOPE_QUIET=0` doesn't accidentally silence anything.
 */
export function shouldPrintBootSummary(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isTruthyEnv(env.JANUSCOPE_QUIET)) return false;
  if (isTruthyEnv(env.JANUSCOPE_NO_BOOT_SUMMARY)) return false;
  // Defensive — writing to a closed stderr stream throws EPIPE.
  if (process.stderr && process.stderr.writable === false) return false;
  return true;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (value == null) return false;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "" || trimmed === "0" || trimmed === "false") return false;
  return true;
}

/**
 * Render the boot summary as a multi-line string ending with a
 * newline. Always safe to call; never throws on a malformed-but-valid
 * config (the validator already ran before we get here).
 *
 * Example output for a fully-loaded lens:
 *
 *     [januscope] v0.4.1 wrapping `npx -y postgres-mcp` [internal]
 *       block:        5 rule(s)
 *       sqlGuard:     query (readOnly)
 *       redact:       8 rule(s)
 *       audit:        ~/mcp-audit-postgres.jsonl
 *       instructions: 425 chars (append)
 *     (set JANUSCOPE_QUIET=1 to silence this)
 *
 * The trailing hint is omitted when no overlay is active (an empty
 * summary is just noise).
 */
export function renderBootSummary(config: OverlayConfig, version: string): string {
  const lines: string[] = [];
  const target = describeTarget(config);
  const cls = config.classification ? ` [${config.classification}]` : "";
  lines.push(`[januscope] v${version} wrapping \`${target}\`${cls}`);

  const bullets = describeOverlays(config);
  for (const bullet of bullets) {
    lines.push(`  ${bullet}`);
  }

  if (bullets.length > 0) {
    lines.push(`(set JANUSCOPE_QUIET=1 to silence this)`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Format the target command + args, truncating long arg lists so the
 * header line stays readable. The format mirrors how the operator
 * typed the command in their config: `<command> <arg1> <arg2> ...`.
 */
function describeTarget(config: OverlayConfig): string {
  const cmd = config.target.command;
  const args = config.target.args ?? [];
  const full = args.length > 0 ? `${cmd} ${args.join(" ")}` : cmd;
  if (full.length <= TARGET_MAX_WIDTH) return full;
  return full.slice(0, TARGET_MAX_WIDTH - 1) + "…";
}

/**
 * One bullet per active overlay, in the same order the pipeline
 * registers them. Each bullet shows the overlay name plus the single
 * piece of information most useful for confirming the config loaded
 * correctly (rule counts, target tools, sink paths).
 */
function describeOverlays(config: OverlayConfig): string[] {
  const out: string[] = [];

  if (config.firstRun === "approve") {
    out.push(label("firstRun:") + "approve (lens fingerprint enforced)");
  }

  if (config.block && config.block.length > 0) {
    out.push(label("block:") + `${config.block.length} rule(s)`);
  }

  if (config.rateLimit && config.rateLimit.length > 0) {
    out.push(label("rateLimit:") + `${config.rateLimit.length} rule(s)`);
  }

  if (config.sqlGuard) {
    const tools = config.sqlGuard.tools.join(", ");
    const ro = config.sqlGuard.readOnly ? "readOnly" : "writes-allowed";
    out.push(label("sqlGuard:") + `${tools} (${ro})`);
  }

  if (config.dbSchema) {
    const driver = config.dbSchema.driver ?? "auto";
    const tables = config.dbSchema.tables?.length
      ? `${config.dbSchema.tables.length} table(s)`
      : "all tables";
    out.push(label("dbSchema:") + `${driver}, ${tables}`);
  }

  if (config.contextInjection) {
    const targets = config.contextInjection.injectInto.join(", ");
    const source = config.contextInjection.textFile ? "file" : "inline";
    out.push(label("contextInject:") + `${targets} (${source})`);
  }

  if (config.redact && config.redact.rules.length > 0) {
    out.push(label("redact:") + `${config.redact.rules.length} rule(s)`);
  }

  if (config.audit) {
    out.push(label("audit:") + config.audit.sink);
  }

  if (config.instructions) {
    const text =
      typeof config.instructions === "string" ? config.instructions : config.instructions.text;
    const position =
      typeof config.instructions === "object" && config.instructions.position
        ? config.instructions.position
        : "append";
    if (text && text.trim().length > 0) {
      out.push(label("instructions:") + `${text.length} chars (${position})`);
    }
  }

  if (config.telemetry?.otel) {
    out.push(label("telemetry:") + `OTel → ${config.telemetry.otel.endpoint}`);
  }

  return out;
}

/**
 * Pad the overlay name to a fixed column so values line up. Width
 * matches the longest label below; if a longer name is added, bump
 * this constant (the lint we run against the bundled lenses will
 * catch any actual misalignment in the rendered tests).
 */
function label(name: string): string {
  const COL = 16;
  if (name.length >= COL) return name + " ";
  return name + " ".repeat(COL - name.length);
}
