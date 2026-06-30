// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * First-use quarantine — drift defence at two layers.
 *
 * When a lens opts in with `firstRun: approve`, JanuScope tracks two
 * fingerprints per identity in `~/.januscope/approved.json`:
 *
 *   1. **Static lens fingerprint** (`fingerprint`): hashes the lens
 *      config surface that affects what the proxy enforces — target
 *      command, block rules, sqlGuard tools, rateLimit rules, redact
 *      rule shapes, classification. Computed before the target is
 *      spawned. Catches: "the operator (or an attacker) edited the
 *      lens YAML and weakened a rule."
 *
 *   2. **Live tools fingerprint** (`live_tools_fingerprint`): hashes
 *      the upstream MCP's actual `tools/list` response — every
 *      tool's name, description, inputSchema, and annotations.
 *      Computed when the first `tools/list` response arrives at the
 *      proxy. Catches: "the upstream MCP added / removed / renamed
 *      a tool, or quietly mutated a tool description (a known
 *      prompt-injection vector)."
 *
 * The two layers complement each other. The static layer cannot see
 * upstream changes; the live layer cannot see lens-config edits that
 * never reach `tools/list` (e.g. a redact rule weakened to leak
 * secrets). Together they cover the realistic threat model for a
 * "trust-on-first-use" local proxy.
 *
 * Behaviour for each layer (independent state machines):
 *
 *   - **First launch** (no entry present): trust-on-first-use. The
 *     fingerprint is recorded as the baseline and the pipeline
 *     proceeds. A structured info line tells the operator what was
 *     approved.
 *   - **Subsequent launch, matching fingerprint**: silent pass-through.
 *   - **Subsequent launch, drift**: refuse to start (static layer)
 *     OR rewrite the `tools/list` response into a JSON-RPC error
 *     (live layer, since the target is already up by then). Both
 *     surface the same remediation path: re-run `januscope approve
 *     --config <path>` or delete the stale entry.
 *
 * The point is not that the operator vets the opaque hex strings,
 * but that ANY drift blocks the surface until acknowledged. A
 * malicious MCP that slipped a new tool into its `tools/list`
 * between runs can't go unnoticed.
 *
 * stdin-safe by design: reads / writes happen entirely on the
 * filesystem, never on the stdio transport. The `januscope approve`
 * CLI is the interactive path, invoked OUT OF BAND by the operator.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OverlayConfig } from "./config.js";

/** Names of components we hash — mirrors FingerprintComponents keys. */
export type FingerprintComponentName =
  "target" | "block" | "sqlGuard" | "rateLimit" | "redact" | "classification";

/** Result of checking an approved.json entry against the current config. */
export type QuarantineCheckResult =
  | { kind: "approved"; fingerprint: string }
  | { kind: "tofu"; fingerprint: string; stored: boolean }
  | {
      kind: "drift";
      currentFingerprint: string;
      approvedFingerprint: string;
      approvedAt: string;
      /**
       * The component names whose sub-hashes differ. Lets the caller
       * produce an actionable error ("block list changed") instead of
       * a vague "something changed".
       */
      changedComponents: FingerprintComponentName[];
    };

/** Structure of `~/.januscope/approved.json`. */
interface ApprovalsFile {
  version: 1;
  approvals: Record<
    string,
    {
      fingerprint: string;
      approved_at: string;
      target_command: string;
      config_path?: string;
      /**
       * Optional per-component sub-hashes. Older approvals written
       * before component tracking landed don't have this field; drift
       * falls back to "unknown" in that case.
       */
      components?: Partial<FingerprintComponents>;
      /**
       * Hash of the upstream MCP's tools/list response (tool names +
       * descriptions + inputSchemas + annotations) captured on the
       * first run. Optional because the static fingerprint can be
       * recorded before the live one (the `january approve` CLI does
       * not spawn the target). When absent, the live-tools overlay
       * TOFUs it on first launch and writes it back here.
       */
      live_tools_fingerprint?: string;
      /** ISO-8601 of when live_tools_fingerprint was first captured. */
      live_tools_approved_at?: string;
    }
  >;
}

/**
 * The shape of one tool in an MCP `tools/list` response. We hash
 * `name + description + inputSchema + annotations` because those are
 * the parts an attacker might mutate to do tool poisoning (rename a
 * benign tool, slip an instruction into a description, change the
 * accepted argument shape). Other top-level fields (e.g. cosmetic
 * vendor extensions) are folded in via `extra` so the hash stays
 * sensitive to any drift, not just the four fields we name.
 */
export interface LiveTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
  [key: string]: unknown;
}

const APPROVALS_PATH_DEFAULT = join(homedir(), ".januscope", "approved.json");

export interface QuarantineOptions {
  /** Override storage path (mostly for tests). */
  approvalsPath?: string;
  /** Absolute path of the lens config file (recorded for auditability). */
  configPath?: string;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /**
   * When true, a fresh entry is written to `approvalsPath` on TOFU.
   * When false, TOFU is "observed" but not persisted — the CLI
   * `januscope approve` uses this to preview without committing.
   */
  persistOnTofu?: boolean;
}

/**
 * Compute a stable identity key for this lens — hash of the command,
 * its args, and the *names* of the env vars the target expects.
 * Same MCP binary behind the same invocation maps to the same
 * identity, even if the user moves the config file or rotates
 * credentials. Two lenses that spawn the same binary but require
 * different env-var sets (e.g. prod vs test Stripe keys) map to
 * different identities, so approving one does NOT silently approve
 * the other.
 *
 * Env values are deliberately NOT part of identity — rotating a
 * secret should not force re-approval, or nobody will read the
 * prompt when it matters.
 */
export function computeIdentity(config: OverlayConfig): string {
  const envKeys = Object.keys(config.target.env ?? {}).sort();
  const parts = {
    command: config.target.command,
    args: config.target.args ?? [],
    envKeys,
  };
  return sha256Hex(JSON.stringify(parts));
}

/**
 * The set of components we hash into the fingerprint. Each component
 * gets its own sub-hash so a drift message can name precisely what
 * changed ("block list drifted", not just "something drifted").
 *
 * Deliberately EXCLUDED from the surface:
 *   - `instructions` / `dbSchema` / `audit` — changing policy text,
 *     DB introspection settings, or log sinks should not require
 *     re-approval. These don't affect what tools exist or what they
 *     can do.
 *   - `target.env` values — rotating a secret must not force
 *     re-approval, or users learn to auto-approve and the quarantine
 *     becomes theatre. The env var *keys* are in `computeIdentity`,
 *     so a lens requiring a different credential set maps to a
 *     different identity rather than the same identity with drift.
 *   - `redact.replacement` — cosmetic; doesn't change what is
 *     redacted, only the placeholder shown.
 */
interface FingerprintComponents {
  target: string;
  block: string;
  sqlGuard: string;
  rateLimit: string;
  redact: string;
  classification: string;
}

export interface Fingerprint {
  overall: string;
  components: FingerprintComponents;
}

/**
 * Fingerprint of the *static* lens surface that the operator
 * cares about approving. Order-insensitive on lists; stable across
 * key reorderings of objects. Returns both a combined hash (for
 * equality checks) and per-component hashes (for drift diffs).
 */
export function computeFingerprint(config: OverlayConfig): Fingerprint {
  const components: FingerprintComponents = {
    target: hashComponent({
      command: config.target.command,
      args: config.target.args ?? [],
    }),
    block: hashComponent(sortedStrings(config.block)),
    sqlGuard: hashComponent(
      config.sqlGuard
        ? {
            tools: sortedStrings(config.sqlGuard.tools),
            mode: config.sqlGuard.mode,
            readOnly: config.sqlGuard.readOnly,
            sqlArg: config.sqlGuard.sqlArg,
            extraReadVerbs: sortedStrings(config.sqlGuard.extraReadVerbs),
            extraWriteKeywords: sortedStrings(config.sqlGuard.extraWriteKeywords),
          }
        : null,
    ),
    rateLimit: hashComponent(
      config.rateLimit
        ? [...config.rateLimit]
            .sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0))
            .map((r) => ({ tool: r.tool, perMinute: r.perMinute }))
        : null,
    ),
    redact: hashComponent(
      config.redact
        ? {
            // Rule *shapes* only: hash the key (regex vs field) and
            // the value string. Replacement text is not part of the
            // surface because changing it doesn't affect what gets
            // redacted.
            rules: [...config.redact.rules]
              .map((r) =>
                "regex" in r
                  ? { k: "regex" as const, v: r.regex }
                  : { k: "field" as const, v: r.field },
              )
              .sort((a, b) => (a.v < b.v ? -1 : a.v > b.v ? 1 : 0)),
            applyTo: config.redact.applyTo,
          }
        : null,
    ),
    classification: hashComponent(config.classification ?? null),
  };
  const overall = sha256Hex(JSON.stringify(components));
  return { overall, components };
}

/** Back-compat-friendly string form (just the overall hash). */
export function computeFingerprintHash(config: OverlayConfig): string {
  return computeFingerprint(config).overall;
}

function hashComponent(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
}

/**
 * Check the fingerprint against the persisted approvals file.
 *
 * On TOFU, writes a new entry to the file (unless `persistOnTofu` is
 * false). On drift, returns the drift result but does NOT modify the
 * file — the caller decides whether to refuse startup.
 */
export function checkQuarantine(
  config: OverlayConfig,
  options: QuarantineOptions = {},
): QuarantineCheckResult {
  const path = options.approvalsPath ?? APPROVALS_PATH_DEFAULT;
  const persistOnTofu = options.persistOnTofu ?? true;
  const now = options.now ?? (() => new Date());

  const identity = computeIdentity(config);
  const fingerprint = computeFingerprint(config);

  const approvals = loadApprovals(path);
  const entry = approvals.approvals[identity];

  if (!entry) {
    // TOFU — record this fingerprint as the baseline.
    let stored = false;
    if (persistOnTofu) {
      approvals.approvals[identity] = {
        fingerprint: fingerprint.overall,
        components: fingerprint.components,
        approved_at: now().toISOString(),
        target_command: [config.target.command, ...(config.target.args ?? [])].join(" "),
        ...(options.configPath ? { config_path: options.configPath } : {}),
      };
      saveApprovals(path, approvals);
      stored = true;
    }
    return { kind: "tofu", fingerprint: fingerprint.overall, stored };
  }

  if (entry.fingerprint === fingerprint.overall) {
    return { kind: "approved", fingerprint: fingerprint.overall };
  }

  return {
    kind: "drift",
    currentFingerprint: fingerprint.overall,
    approvedFingerprint: entry.fingerprint,
    approvedAt: entry.approved_at,
    changedComponents: diffComponents(entry.components, fingerprint.components),
  };
}

function diffComponents(
  approved: Partial<FingerprintComponents> | undefined,
  current: FingerprintComponents,
): FingerprintComponentName[] {
  // Without stored components (older approval), we can't locate the
  // drift — return empty, the caller knows to fall back to "unknown".
  if (!approved) return [];
  const names: FingerprintComponentName[] = [
    "target",
    "block",
    "sqlGuard",
    "rateLimit",
    "redact",
    "classification",
  ];
  return names.filter((n) => approved[n] !== undefined && approved[n] !== current[n]);
}

/**
 * Force-approve (or update) an identity to a given fingerprint.
 * Used by the `januscope approve` CLI path.
 */
export function recordApproval(
  config: OverlayConfig,
  options: QuarantineOptions = {},
): { identity: string; fingerprint: string; path: string } {
  const path = options.approvalsPath ?? APPROVALS_PATH_DEFAULT;
  const now = options.now ?? (() => new Date());
  const identity = computeIdentity(config);
  const fingerprint = computeFingerprint(config);

  const approvals = loadApprovals(path);
  approvals.approvals[identity] = {
    fingerprint: fingerprint.overall,
    components: fingerprint.components,
    approved_at: now().toISOString(),
    target_command: [config.target.command, ...(config.target.args ?? [])].join(" "),
    ...(options.configPath ? { config_path: options.configPath } : {}),
  };
  saveApprovals(path, approvals);
  return { identity, fingerprint: fingerprint.overall, path };
}

function loadApprovals(path: string): ApprovalsFile {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "version" in parsed &&
      "approvals" in parsed &&
      (parsed as { version?: unknown }).version === 1
    ) {
      return parsed as ApprovalsFile;
    }
    // Malformed — treat as empty rather than crash. The next TOFU
    // will overwrite it cleanly.
    return { version: 1, approvals: {} };
  } catch {
    return { version: 1, approvals: {} };
  }
}

function saveApprovals(path: string, approvals: ApprovalsFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Atomic write via tempfile + rename. `writeFileSync` is NOT
  // atomic — a crash mid-write leaves a truncated file, which our
  // loader then treats as "no approvals" and silently re-TOFUs on
  // next launch. The tempfile name includes pid + timestamp so two
  // concurrent writers don't clobber each other's staging file.
  // `renameSync` on POSIX is atomic within the same filesystem,
  // which the os-native `~/.januscope/` always is.
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  // 0o600: this file lists every MCP the operator has approved, with
  // paths and command lines. Not a secret, but not public either.
  writeFileSync(tmp, JSON.stringify(approvals, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function sortedStrings(arr: ReadonlyArray<string> | undefined): string[] | null {
  if (!arr || arr.length === 0) return null;
  return [...arr].sort();
}

/* ─────────────────── live tools/list fingerprinting ─────────────────── */

/**
 * Compute a stable hash of an upstream MCP's `tools/list` response.
 * Sensitive to:
 *   - Tool names (a renamed tool is a different surface).
 *   - Tool descriptions (the prompt-injection vector — a description
 *     change is exactly what tool poisoning looks like).
 *   - inputSchema (changing a tool's arg shape changes what callers
 *     can do with it).
 *   - annotations (if present; MCP supports things like
 *     `destructiveHint`, `idempotentHint`).
 *   - Any other fields the upstream returns (folded in via `extra`).
 *
 * Order-insensitive: tools are sorted by name first so the upstream's
 * iteration order doesn't cause spurious drift.
 *
 * Returns a sha256 hex digest. The same `tools/list` payload always
 * hashes to the same string, regardless of object-key order or array
 * ordering.
 */
export function computeLiveToolsFingerprint(tools: ReadonlyArray<LiveTool>): string {
  const canonical = [...tools]
    .map((t) => canonicalTool(t))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sha256Hex(canonicalJson(canonical));
}

/**
 * Convert a tool object to a canonical shape for hashing. Pulls out
 * the well-known fields explicitly (so a rename / addition of a
 * field stays observable) and dumps everything else into `extra` so
 * forward-compat fields are still part of the hash.
 */
function canonicalTool(t: LiveTool): {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations: unknown;
  extra: Record<string, unknown>;
} {
  const { name, description, inputSchema, annotations, ...rest } = t;
  return {
    name,
    description: typeof description === "string" ? description : "",
    inputSchema: inputSchema ?? null,
    annotations: annotations ?? null,
    extra: rest,
  };
}

/**
 * JSON-stringify with object keys sorted recursively. Two payloads
 * that differ only in key order hash identically — important because
 * MCP servers don't guarantee field-emission order.
 *
 * Prototype-pollution-safe: builds the canonical object with
 * `Object.create(null)` so the result has no `Object.prototype` to
 * pollute, and explicitly skips `__proto__` / `constructor` /
 * `prototype` keys when copying. A malicious upstream MCP returning
 * a tool with `name: "__proto__"` (or smuggling the same string
 * through inputSchema) cannot mutate the proxy process's prototype
 * chain via this path.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysRecursive(value));
}

const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function sortKeysRecursive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysRecursive);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Object.create(null) returns a prototype-less object; assigning
    // to `__proto__` on it sets a literal own property rather than
    // re-pointing the prototype chain. We still skip the canonical
    // pollution keys defensively so the canonical hash stays stable
    // (a payload that adds `__proto__: "x"` to one of its fields
    // produces the same fingerprint as a payload without it).
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const k of Object.keys(obj).sort()) {
      if (POLLUTION_KEYS.has(k)) continue;
      sorted[k] = sortKeysRecursive(obj[k]);
    }
    return sorted;
  }
  return value;
}

/** Result of checking the live-tools fingerprint against the approvals file. */
export type LiveToolsCheckResult =
  | { kind: "approved"; fingerprint: string }
  | { kind: "tofu"; fingerprint: string; stored: boolean }
  | { kind: "drift"; currentFingerprint: string; approvedFingerprint: string; approvedAt: string }
  | { kind: "no-static-approval"; fingerprint: string };

/**
 * Check the live-tools fingerprint against the persisted approvals
 * file for this lens identity. The static approval must already
 * exist — without it we don't know which identity to attach the live
 * fingerprint to (and the static layer wouldn't have let the call
 * reach this point anyway).
 *
 * On TOFU (no live fingerprint stored yet for an existing static
 * approval), persists the fingerprint unless `persistOnTofu: false`.
 * On drift, returns the result but does NOT modify the file — the
 * caller decides what to do (typically: rewrite the response to an
 * error and refuse the rest of the session).
 */
export function checkLiveTools(
  config: OverlayConfig,
  tools: ReadonlyArray<LiveTool>,
  options: QuarantineOptions = {},
): LiveToolsCheckResult {
  const path = options.approvalsPath ?? APPROVALS_PATH_DEFAULT;
  const persistOnTofu = options.persistOnTofu ?? true;
  const now = options.now ?? (() => new Date());

  const identity = computeIdentity(config);
  const fingerprint = computeLiveToolsFingerprint(tools);

  const approvals = loadApprovals(path);
  const entry = approvals.approvals[identity];

  // No static approval at all means the static layer hasn't run /
  // succeeded yet. Don't auto-create a half-state entry; surface the
  // condition so the caller can log it.
  if (!entry) {
    return { kind: "no-static-approval", fingerprint };
  }

  if (!entry.live_tools_fingerprint) {
    // First time we see live tools for this already-static-approved
    // lens. Record as baseline.
    let stored = false;
    if (persistOnTofu) {
      entry.live_tools_fingerprint = fingerprint;
      entry.live_tools_approved_at = now().toISOString();
      saveApprovals(path, approvals);
      stored = true;
    }
    return { kind: "tofu", fingerprint, stored };
  }

  if (entry.live_tools_fingerprint === fingerprint) {
    return { kind: "approved", fingerprint };
  }

  return {
    kind: "drift",
    currentFingerprint: fingerprint,
    approvedFingerprint: entry.live_tools_fingerprint,
    approvedAt: entry.live_tools_approved_at ?? entry.approved_at,
  };
}

/**
 * Force-record a live-tools fingerprint for an identity. Used when
 * the operator re-runs `januscope approve` after deliberate upstream
 * changes — the CLI captures a fresh `tools/list` and writes it
 * here.
 */
export function recordLiveToolsApproval(
  config: OverlayConfig,
  tools: ReadonlyArray<LiveTool>,
  options: QuarantineOptions = {},
): { identity: string; fingerprint: string; path: string } {
  const path = options.approvalsPath ?? APPROVALS_PATH_DEFAULT;
  const now = options.now ?? (() => new Date());
  const identity = computeIdentity(config);
  const fingerprint = computeLiveToolsFingerprint(tools);

  const approvals = loadApprovals(path);
  const entry = approvals.approvals[identity];
  if (!entry) {
    // No static approval: refuse to auto-create one. Force the caller
    // to do `recordApproval(config)` first so the static and live
    // layers share an audit trail.
    throw new Error(
      `recordLiveToolsApproval: no static approval for identity ${identity.slice(0, 16)}…; ` +
        `call recordApproval(config) first.`,
    );
  }
  entry.live_tools_fingerprint = fingerprint;
  entry.live_tools_approved_at = now().toISOString();
  saveApprovals(path, approvals);
  return { identity, fingerprint, path };
}
