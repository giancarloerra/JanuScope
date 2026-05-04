// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * `audit` overlay.
 *
 * Emits one NDJSON record per `tools/call` request/response pair to a
 * configurable sink (file, "stderr", or "stdout"). Also emits startup and
 * shutdown records.
 *
 * Writes are fire-and-forget; errors are logged to stderr via the overlay
 * context and do not block message forwarding.
 */

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { Overlay, OverlayContext } from "../pipeline.js";
import type { Classification } from "../config.js";
import { isErrorResponse, isRequest, isResponse, isSuccess, type JsonRpcMessage } from "../rpc.js";

export interface AuditOverlayOptions {
  sink: string;
  logRawArgs?: boolean;
  /**
   * Lens data-sensitivity label. When set, every emitted record carries
   * `classification: "<value>"` — downstream SIEM pipelines can route
   * sensitive-lens events to a tighter retention / ACL path without
   * re-deriving the label from the tool name.
   */
  classification?: Classification;
  /**
   * Identity attribution stamped onto every audit record. Captured at
   * overlay setup from environment variables (`JANUSCOPE_USER`,
   * `JANUSCOPE_TEAM`, `JANUSCOPE_SESSION`) so the host process / CI
   * job / orchestrator supplies them out-of-band rather than every
   * lens config carrying them. Each field is omitted when its env var
   * is unset or empty, so existing audit consumers see the same shape
   * they always did.
   *
   * Library users embedding the overlay programmatically can supply
   * this directly instead of relying on env (e.g. a multi-tenant
   * embedding host that runs under a single OS user but services
   * many request principals).
   */
  identity?: AuditIdentity;
  /** Wall-clock source, injectable for deterministic tests. */
  now?: () => Date;
}

/**
 * Identity tag stamped onto every audit record. Each field is
 * optional and omitted from the record when unset, so the JSONL
 * line stays minimal for single-operator workstation use.
 *
 * - `user`: human operator. Free-form string; SIEM ingesters typically
 *   join this against an HRIS / IDP table.
 * - `team`: org / team / cost-centre attribution.
 * - `session`: client-side correlation id (e.g. an MCP-client session
 *   uuid). Enables cross-process / cross-tool tracing without
 *   requiring distributed tracing.
 */
export interface AuditIdentity {
  user?: string;
  team?: string;
  session?: string;
}

/**
 * Capture identity from `JANUSCOPE_USER` / `JANUSCOPE_TEAM` /
 * `JANUSCOPE_SESSION` env vars. Empty / whitespace-only values are
 * treated as unset so a host that exports `JANUSCOPE_USER=""` doesn't
 * stamp empty-string identifiers onto every record.
 *
 * Returns `undefined` when no env var is set, so the caller can short-
 * circuit the spread in the common case.
 */
export function captureIdentityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AuditIdentity | undefined {
  const user = env.JANUSCOPE_USER?.trim();
  const team = env.JANUSCOPE_TEAM?.trim();
  const session = env.JANUSCOPE_SESSION?.trim();
  const out: AuditIdentity = {};
  if (user) out.user = user;
  if (team) out.team = team;
  if (session) out.session = session;
  return Object.keys(out).length > 0 ? out : undefined;
}

/* -------------------------------------------------------------------------
 * Audit event schema (stable wire format)
 *
 * Every record the audit overlay writes to the JSONL sink is one of the
 * types below. Consumers building SIEM ingesters / Splunk HEC pipelines /
 * Datadog log pipelines should prefer importing these types from
 * `januscope` to re-transcribing the shape from the README.
 *
 * A JSON Schema mirror of the union lives at `schemas/audit-event.json`
 * in the published package.
 * ----------------------------------------------------------------------- */

/** ISO-8601 UTC timestamp, e.g. "2026-04-20T14:30:00.000Z". */
export type AuditTimestamp = string;

/** `"sha256:" + first-16-hex` of canonical-JSON of tool arguments. */
export type AuditArgsHash = `sha256:${string}`;

/**
 * Optional data-sensitivity tag inherited from the lens config.
 * Present on every record when the lens sets `classification`; absent
 * otherwise.
 */
type AuditClassification = Classification;

/**
 * Optional identity attribution captured at overlay setup from
 * `JANUSCOPE_USER` / `JANUSCOPE_TEAM` / `JANUSCOPE_SESSION` env vars
 * (or supplied programmatically by a library embedder). Each field
 * is independently optional. Present on every record when the host
 * supplied a value; absent otherwise. Pre-existing JSONL parsers
 * remain backward-compatible.
 */
interface AuditIdentityFields {
  user?: string;
  team?: string;
  session?: string;
}

/** Emitted once when the audit overlay is wired up. */
export interface AuditStartupEvent extends AuditIdentityFields {
  ts: AuditTimestamp;
  event: "startup";
  /** The configured sink string ("stdout" / "stderr" / a file path). */
  sink: string;
  classification?: AuditClassification;
}

/** Emitted once when the audit overlay tears down cleanly. */
export interface AuditShutdownEvent extends AuditIdentityFields {
  ts: AuditTimestamp;
  event: "shutdown";
  classification?: AuditClassification;
}

/** Fields common to every `tools/call` record. */
interface AuditToolsCallBase extends AuditIdentityFields {
  ts: AuditTimestamp;
  event: "tools/call";
  /** Tool name from `params.name` (or `"<unknown>"` if absent). */
  tool: string;
  /** JSON-RPC id for request/response correlation. */
  id: string | number;
  args_hash: AuditArgsHash;
  /**
   * Raw arguments, only present when the overlay was configured with
   * `logRawArgs: true`. Opaque JSON — may contain secrets.
   */
  args?: unknown;
  classification?: AuditClassification;
}

/** Successful `tools/call` (server returned a result). */
export interface AuditToolsCallOkEvent extends AuditToolsCallBase {
  status: "ok" | "tool_error";
  duration_ms: number;
  /** UTF-8 byte count of the serialised result. */
  result_bytes: number;
}

/** Error `tools/call` (server returned a JSON-RPC error). */
export interface AuditToolsCallErrorEvent extends AuditToolsCallBase {
  status: "error";
  duration_ms: number;
  error: { code: number; message: string };
}

/** Request with no correlated response within the pending-timeout window. */
export interface AuditToolsCallTimeoutEvent extends AuditToolsCallBase {
  status: "timeout";
}

/** Request still pending when the overlay tears down. */
export interface AuditToolsCallOrphanedEvent extends AuditToolsCallBase {
  status: "orphaned";
}

/** Union of every shape the audit overlay writes. */
export type AuditEvent =
  | AuditStartupEvent
  | AuditShutdownEvent
  | AuditToolsCallOkEvent
  | AuditToolsCallErrorEvent
  | AuditToolsCallTimeoutEvent
  | AuditToolsCallOrphanedEvent;

interface PendingCall {
  tool: string;
  startedAt: number;
  argsHash: string;
  args?: unknown;
}

const PENDING_KEY = "pending";
const WRITER_KEY = "writer";
const PENDING_TIMEOUT_MS = 60_000;

type WriterKind = { kind: "stream"; stream: NodeJS.WritableStream } | { kind: "fd"; fd: number };

export function createAuditOverlay(options: AuditOverlayOptions): Overlay {
  const now = options.now ?? (() => new Date());
  const logRawArgs = options.logRawArgs ?? false;
  const classification = options.classification;
  // Identity precedence: explicit options.identity wins (library
  // embedders), env vars come second (the common CLI / CI case),
  // nothing third. captureIdentityFromEnv returns undefined when no
  // env var is set, so the spread below is a no-op for the
  // single-operator workstation case.
  const identity = options.identity ?? captureIdentityFromEnv();
  // Spread this into every emitted record when set; a single place so
  // we never forget a path (startup / shutdown / ok / error / timeout /
  // orphaned all use it). Identity fields are inlined alongside
  // classification rather than nested under an `identity` object so
  // SIEM filters like `audit.user="alice" AND audit.tool="execute_sql"`
  // work without a JSON-path step.
  const tag: { classification?: Classification } & AuditIdentityFields = {
    ...(classification ? { classification } : {}),
    ...(identity ?? {}),
  };

  return {
    name: "audit",

    setup(ctx) {
      const writer = resolveWriter(options.sink);
      ctx.state.set(WRITER_KEY, writer);
      ctx.state.set(PENDING_KEY, new Map<string | number, PendingCall>());
      writeRecord(writer, ctx, {
        ts: now().toISOString(),
        event: "startup",
        sink: options.sink,
        ...tag,
      });
    },

    teardown(ctx) {
      const writer = ctx.state.get(WRITER_KEY) as WriterKind | undefined;
      if (!writer) return;
      writeRecord(writer, ctx, {
        ts: now().toISOString(),
        event: "shutdown",
        ...tag,
      });
      // Sweep any pending calls that never got responses.
      const pending = ctx.state.get(PENDING_KEY) as Map<string | number, PendingCall> | undefined;
      if (pending) {
        for (const [id, entry] of pending) {
          writeRecord(writer, ctx, {
            ts: now().toISOString(),
            event: "tools/call",
            tool: entry.tool,
            id,
            status: "orphaned",
            args_hash: entry.argsHash,
            ...(logRawArgs && entry.args !== undefined ? { args: entry.args } : {}),
            ...tag,
          });
        }
        pending.clear();
      }
      // Release the open fd (process stdio streams stay open for the
      // host lifecycle — we never close those). Integration tests that
      // stand up / tear down the overlay in a loop would otherwise
      // accumulate one fd per iteration and hit ulimit.
      if (writer.kind === "fd") {
        try {
          closeSync(writer.fd);
        } catch {
          // Already closed by some other teardown path — nothing to do.
        }
      }
    },

    onClientMessage(msg, ctx) {
      if (isRequest(msg) && msg.method === "tools/call") {
        recordRequest(msg, ctx, now, logRawArgs, tag);
      }
      return { kind: "forward", msg };
    },

    onServerMessage(msg, ctx) {
      if (isResponse(msg)) {
        recordResponse(msg, ctx, now, tag);
      }
      return { kind: "forward", msg };
    },
  };
}

function recordRequest(
  msg: Extract<JsonRpcMessage, { method: string; id: string | number | null }>,
  ctx: OverlayContext,
  now: () => Date,
  logRawArgs: boolean,
  tag: { classification?: Classification } & AuditIdentityFields,
): void {
  const writer = ctx.state.get(WRITER_KEY) as WriterKind | undefined;
  const pending = ctx.state.get(PENDING_KEY) as Map<string | number, PendingCall> | undefined;
  if (!writer || !pending || msg.id === null) return;

  const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
  const tool = typeof params.name === "string" ? params.name : "<unknown>";
  const args = params.arguments ?? {};
  const argsHash = sha256Hex(canonicalJson(args));

  const entry: PendingCall = {
    tool,
    startedAt: now().getTime(),
    argsHash,
    ...(logRawArgs ? { args } : {}),
  };
  pending.set(msg.id, entry);

  // Clean up stale entries so the map doesn't grow unbounded.
  sweepPending(pending, writer, ctx, now, tag);
}

function recordResponse(
  msg: JsonRpcMessage,
  ctx: OverlayContext,
  now: () => Date,
  tag: { classification?: Classification } & AuditIdentityFields,
): void {
  if (!isResponse(msg)) return;
  const writer = ctx.state.get(WRITER_KEY) as WriterKind | undefined;
  const pending = ctx.state.get(PENDING_KEY) as Map<string | number, PendingCall> | undefined;
  if (!writer || !pending || msg.id === null) return;

  const entry = pending.get(msg.id);
  if (!entry) return; // Response for an id we didn't track (not a tools/call).
  pending.delete(msg.id);

  const duration = now().getTime() - entry.startedAt;
  const base = {
    ts: now().toISOString(),
    event: "tools/call",
    tool: entry.tool,
    id: msg.id,
    duration_ms: duration,
    args_hash: entry.argsHash,
    ...(entry.args !== undefined ? { args: entry.args } : {}),
    ...tag,
  };

  if (isSuccess(msg)) {
    const serialized = safeStringify(msg.result);
    const isErrorFlag = (msg.result as { isError?: unknown })?.isError === true;
    writeRecord(writer, ctx, {
      ...base,
      status: isErrorFlag ? "tool_error" : "ok",
      // UTF-8 byte count, not JS string length — the README documents
      // `result_bytes` as "size in bytes, not chars" and any non-ASCII
      // payload (names with diacritics, Chinese columns, emoji) makes
      // the `.length`-based count diverge.
      result_bytes: Buffer.byteLength(serialized, "utf8"),
    });
    return;
  }
  if (isErrorResponse(msg)) {
    writeRecord(writer, ctx, {
      ...base,
      status: "error",
      error: { code: msg.error.code, message: msg.error.message },
    });
  }
}

function sweepPending(
  pending: Map<string | number, PendingCall>,
  writer: WriterKind,
  ctx: OverlayContext,
  now: () => Date,
  tag: { classification?: Classification } & AuditIdentityFields,
): void {
  const cutoff = now().getTime() - PENDING_TIMEOUT_MS;
  for (const [id, entry] of pending) {
    if (entry.startedAt < cutoff) {
      writeRecord(writer, ctx, {
        ts: now().toISOString(),
        event: "tools/call",
        tool: entry.tool,
        id,
        status: "timeout",
        args_hash: entry.argsHash,
        ...tag,
      });
      pending.delete(id);
    }
  }
}

function writeRecord(writer: WriterKind, ctx: OverlayContext, record: object): void {
  const line = safeStringify(record) + "\n";
  try {
    switch (writer.kind) {
      case "stream":
        writer.stream.write(line);
        break;
      case "fd":
        writeSync(writer.fd, line);
        break;
    }
  } catch (err) {
    ctx.log("warn", "audit write failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function resolveWriter(sink: string): WriterKind {
  if (sink === "stdout") {
    return { kind: "stream", stream: process.stdout };
  }
  if (sink === "stderr") {
    return { kind: "stream", stream: process.stderr };
  }
  const path = expandHome(sink);
  // Ensure the parent directory exists. Users commonly point sinks at
  // paths like `./results/audit.jsonl` or `~/logs/audit.jsonl` and
  // expect it to "just work" without a separate mkdir step. We create
  // intermediate directories recursively — failures still surface as
  // the usual ENOENT/EACCES from openSync below.
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // Permission or other error — let openSync report the real cause.
  }
  // Open with 0o600 so the audit log is user-readable only. With
  // logRawArgs: true the file contains raw tool arguments (SQL,
  // request bodies, file contents) and in a shared-user or CI
  // environment the default umask (0o022 → world-readable 0o644)
  // would leak those. Existing files keep their current mode — we
  // don't chmod files we didn't create, in case the operator has
  // deliberately widened perms.
  const fd = openSync(path, "a", 0o600);
  return { kind: "fd", fd };
}

function expandHome(path: string): string {
  if (path === "~" || path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}

/**
 * Canonical JSON: sort object keys recursively so equivalent payloads
 * hash identically regardless of key ordering.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

// Keys that, if assigned via bracket notation, can in some Node
// versions / under some object shapes mutate the prototype chain
// rather than set an own property. We skip them so a malicious tool
// argument shaped like `{ __proto__: {...} }` cannot pollute the
// canonical-JSON output even before it hits sha256.
const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object" && value.constructor === Object) {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([k]) => !POLLUTION_KEYS.has(k),
    );
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    // Object.create(null): no prototype chain to pollute. Audit
    // hashes are derived from this output, so any prototype-walk
    // surprise here would corrupt the args_hash and (worse) could
    // be reflected back into JSON.stringify's output.
    const out = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of entries) {
      out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

function sha256Hex(input: string): string {
  return "sha256:" + createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"<unserializable>"';
  }
}
