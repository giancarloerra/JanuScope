// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * Public library entry point for JanuScope.
 *
 * Most users invoke januscope as a CLI from their MCP client config.
 * The programmatic API here is for embedding the overlay inside another
 * Node process (e.g., a test harness or a custom MCP gateway).
 */

import type { Readable, Writable } from "node:stream";
import { createAuditOverlay } from "./overlays/audit.js";
import { createBlockOverlay } from "./overlays/block.js";
import { createInstructionsOverlay } from "./overlays/instructions.js";
import { createDbSchemaOverlay } from "./overlays/db-schema/index.js";
import { createContextInjectionOverlay } from "./overlays/contextInjection.js";
import { createRateLimitOverlay } from "./overlays/rateLimit.js";
import { createRedactOverlay } from "./overlays/redact.js";
import { createSqlGuardOverlay } from "./overlays/sqlGuard.js";
import { createToolSurfaceOverlay } from "./overlays/toolSurface.js";
import { Pipeline, type Overlay } from "./pipeline.js";
import { startStdioBridge, type LogFn, type TargetSpec } from "./transport/stdio.js";
import { createOtelTracer, NOOP_TRACER, type JanuScopeTracer } from "./telemetry.js";
import { checkQuarantine } from "./quarantine.js";
import type { OverlayConfig } from "./config.js";
import type { JsonRpcMessage } from "./rpc.js";

export {
  loadConfig,
  loadConfigAsync,
  validateConfig,
  detectSecretRefs,
  OverlayConfigSchema,
} from "./config.js";
export {
  parseSecretRef,
  resolveAllSecretRefs,
  type SecretRef,
  type SecretScheme,
} from "./secrets.js";
export type {
  OverlayConfig,
  TargetConfig,
  AuditOptions,
  DbSchemaOptions,
  ContextInjectionOptions,
  RedactOptions,
  SqlGuardOptions,
  RateLimitRules,
  Classification,
  TelemetryOptions,
} from "./config.js";
export { createContextInjectionOverlay } from "./overlays/contextInjection.js";
export type { RateLimitRule, RateLimitOverlayOptions } from "./overlays/rateLimit.js";
export type {
  JanuScopeTracer,
  JanuScopeSpan,
  OtelConfig,
  TelemetryConfig,
  SpanStatus,
} from "./telemetry.js";
export { NOOP_TRACER, createOtelTracer } from "./telemetry.js";
export {
  checkQuarantine,
  recordApproval,
  computeFingerprint,
  computeFingerprintHash,
  computeIdentity,
  computeLiveToolsFingerprint,
  checkLiveTools,
  recordLiveToolsApproval,
} from "./quarantine.js";
export type {
  Fingerprint,
  FingerprintComponentName,
  QuarantineCheckResult,
  QuarantineOptions,
  LiveTool,
  LiveToolsCheckResult,
} from "./quarantine.js";
export { createToolSurfaceOverlay } from "./overlays/toolSurface.js";
export type { ToolSurfaceOverlayOptions } from "./overlays/toolSurface.js";
export { probeTarget } from "./probe.js";
export type { ProbeOptions, ProbeResult } from "./probe.js";
export type {
  AuditEvent,
  AuditStartupEvent,
  AuditShutdownEvent,
  AuditToolsCallOkEvent,
  AuditToolsCallErrorEvent,
  AuditToolsCallTimeoutEvent,
  AuditToolsCallOrphanedEvent,
  AuditTimestamp,
  AuditArgsHash,
  AuditIdentity,
  AuditOverlayOptions,
} from "./overlays/audit.js";
export { captureIdentityFromEnv } from "./overlays/audit.js";
export type {
  Overlay,
  OverlayContext,
  ClientMessageResult,
  ServerMessageResult,
} from "./pipeline.js";
export type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcSuccess,
  JsonRpcError,
} from "./rpc.js";
export {
  loadLenses,
  splitFrontmatter,
  findBundledLensesDir,
  LensMetadataSchema,
  LENS_CATEGORIES,
  LENS_STATUSES,
  STALE_THRESHOLD_MONTHS,
} from "./lenses.js";
export type {
  Lens,
  LensLoadError,
  LensLoadResult,
  LensMetadata,
  LensCategory,
  LensStatus,
  LoadOptions,
} from "./lenses.js";

export interface RunOverlayOptions {
  /** Parsed + validated config (see loadConfig / validateConfig). */
  config: OverlayConfig;
  /** Stdin to read client messages from. Defaults to process.stdin. */
  clientIn?: Readable;
  /** Stdout to write client messages to. Defaults to process.stdout. */
  clientOut?: Writable;
  /** Logger. Defaults to stderr with [januscope] prefix. */
  log?: LogFn;
}

/**
 * Run the overlay session to completion.
 *
 * Spawns the configured target MCP server, wires the pipeline, and resolves
 * once both the client and the target streams have closed.
 */
export async function runOverlay(options: RunOverlayOptions): Promise<void> {
  const log = options.log ?? defaultLogger();
  const clientIn = options.clientIn ?? process.stdin;
  const clientOut = options.clientOut ?? process.stdout;

  // First-use quarantine check (if configured). Runs BEFORE we spawn
  // the target MCP and BEFORE we touch stdin — if the fingerprint
  // drifted we refuse to start and let the MCP client surface the
  // broken-pipe. Silent first-run TOFU writes the baseline file.
  if (options.config.firstRun === "approve") {
    const result = checkQuarantine(options.config);
    switch (result.kind) {
      case "tofu":
        log(
          "info",
          "quarantine",
          `first launch approved by trust-on-first-use (fingerprint ${result.fingerprint.slice(0, 16)}…). ` +
            `Subsequent launches with a different tool surface will refuse to start until you re-approve.`,
        );
        break;
      case "approved":
        // silent — the common case
        break;
      case "drift": {
        const changed =
          result.changedComponents.length > 0
            ? result.changedComponents.join(", ")
            : "unknown (legacy approval has no per-component hashes)";
        const msg =
          `januscope: refusing to start — lens tool surface has drifted since the last approval.\n` +
          `  changed:             ${changed}\n` +
          `  previously approved: ${result.approvedFingerprint.slice(0, 16)}… at ${result.approvedAt}\n` +
          `  current:             ${result.currentFingerprint.slice(0, 16)}…\n` +
          `Re-approve with: januscope approve --config <path-to-lens.yaml>\n` +
          `Or delete the stale entry in ~/.januscope/approved.json to re-TOFU.`;
        log("error", "quarantine", "fingerprint drift — refusing to start", {
          approved: result.approvedFingerprint,
          current: result.currentFingerprint,
          approvedAt: result.approvedAt,
          changedComponents: result.changedComponents,
        });
        throw new Error(msg);
      }
    }
  }

  const overlays = buildOverlays(options.config);
  const target: TargetSpec = {
    command: options.config.target.command,
    ...(options.config.target.args ? { args: options.config.target.args } : {}),
    ...(options.config.target.env ? { env: options.config.target.env } : {}),
    ...(options.config.target.cwd ? { cwd: options.config.target.cwd } : {}),
  };

  // Tracer — no-op unless telemetry.otel is set. Loaded before the
  // pipeline constructs because the pipeline captures the tracer
  // reference at construction time.
  let tracer: JanuScopeTracer = NOOP_TRACER;
  if (options.config.telemetry?.otel) {
    const otelCfg = options.config.telemetry.otel;
    try {
      tracer = await createOtelTracer({
        endpoint: otelCfg.endpoint,
        ...(otelCfg.serviceName ? { serviceName: otelCfg.serviceName } : {}),
        ...(otelCfg.headers ? { headers: otelCfg.headers } : {}),
      });
      log("info", "telemetry", `OTel tracing enabled → ${otelCfg.endpoint}`);
    } catch (err) {
      // Fail loudly — a misconfigured telemetry block is something the
      // operator needs to know about. Use stderr via the logger and
      // rethrow so runOverlay exits non-zero.
      log(
        "error",
        "telemetry",
        "failed to initialise OTel tracer",
        err instanceof Error ? { message: err.message } : { message: String(err) },
      );
      throw err;
    }
  }

  // Placeholder forwarders — reassigned once the bridge is up.
  // If an overlay's setup() synchronously calls ctx.sendToClient /
  // ctx.sendToTarget (rare but possible for an overlay that injects a
  // startup notification), the call lands here. Emit a structured warn
  // rather than silently dropping — that silence is the kind of bug
  // that library users can't reproduce without reading this file.
  let forwardToTarget = (_msg: JsonRpcMessage): void => {
    log(
      "warn",
      "runtime",
      "sendToTarget called before bridge is wired — message dropped. " +
        "Move the send into onClientMessage/onServerMessage or delay until after setup() returns.",
    );
  };
  let forwardToClient = (_msg: JsonRpcMessage): void => {
    log(
      "warn",
      "runtime",
      "sendToClient called before bridge is wired — message dropped. " +
        "Move the send into onClientMessage/onServerMessage or delay until after setup() returns.",
    );
  };

  const pipeline = new Pipeline(overlays, {
    onForwardToTarget: (m) => forwardToTarget(m),
    onForwardToClient: (m) => forwardToClient(m),
    log,
    tracer,
    ...(options.config.classification ? { classification: options.config.classification } : {}),
  });

  await pipeline.start();

  const bridge = startStdioBridge({
    target,
    pipeline,
    clientIn,
    clientOut,
    log,
  });

  forwardToTarget = bridge.forwardToTarget;
  forwardToClient = bridge.forwardToClient;

  // Graceful shutdown on signals.
  const onSignal = (sig: NodeJS.Signals): void => {
    log("info", "runtime", `received ${sig}, shutting down`);
    void bridge.stop(`signal:${sig}`);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  // Last-chance diagnostics. A silent crash (no structured log line) is
  // the worst failure mode for a sidecar proxy between an LLM and a
  // live database — the user sees a broken pipe and has no idea whether
  // JanuScope or the target MCP died. Emit a structured error first,
  // then let Node's default handler take over (Node 20+ exits on
  // unhandled rejection by default; we do not suppress that).
  const onUnhandledRejection = (reason: unknown): void => {
    log("error", "runtime", "unhandledRejection", errorInfo(reason));
  };
  const onUncaughtException = (err: Error): void => {
    log("error", "runtime", "uncaughtException", errorInfo(err));
  };
  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);

  try {
    await bridge.done;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("unhandledRejection", onUnhandledRejection);
    process.off("uncaughtException", onUncaughtException);
    // Flush any buffered OTel spans before Node exits. The no-op
    // tracer's shutdown resolves immediately; the real tracer drains
    // its BatchSpanProcessor — skipping this drops the last batch.
    try {
      await tracer.shutdown();
    } catch (err) {
      log(
        "warn",
        "telemetry",
        "tracer shutdown threw",
        err instanceof Error ? { message: err.message } : { message: String(err) },
      );
    }
  }
}

function errorInfo(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    const info: { message: string; stack?: string } = { message: err.message };
    if (err.stack) info.stack = err.stack;
    return info;
  }
  return { message: String(err) };
}

/** Build the ordered overlay list from config. Order matters for audit semantics. */
export function buildOverlays(config: OverlayConfig): Overlay[] {
  const overlays: Overlay[] = [];
  if (config.audit) {
    overlays.push(
      createAuditOverlay({
        ...config.audit,
        ...(config.classification ? { classification: config.classification } : {}),
      }),
    );
  }
  // Live tools/list fingerprinting runs BEFORE block so it sees the
  // unfiltered upstream surface. Otherwise an attacker who silently
  // added a tool AND added it to the lens block list could evade the
  // live check (defence in depth — both layers fire independently).
  // Activates only when `firstRun: approve`, mirroring the static
  // quarantine layer.
  if (config.firstRun === "approve") {
    overlays.push(createToolSurfaceOverlay({ config }));
  }
  if (config.block && config.block.length > 0) {
    overlays.push(createBlockOverlay({ rules: config.block }));
  }
  // rateLimit runs after block (a blocked tool should not consume a
  // token; the call never should have been sent) but before sqlGuard
  // (rate limits apply regardless of SQL shape). All three are gates.
  if (config.rateLimit && config.rateLimit.length > 0) {
    overlays.push(createRateLimitOverlay({ rules: config.rateLimit }));
  }
  // sqlGuard runs after block + rateLimit: block filters whole tool
  // names, rateLimit throttles by count, sqlGuard inspects SQL
  // arguments of the tools that remain. All three short-circuit
  // before the target sees the call.
  if (config.sqlGuard) {
    overlays.push(
      createSqlGuardOverlay({
        tools: config.sqlGuard.tools,
        sqlArg: config.sqlGuard.sqlArg,
        readOnly: config.sqlGuard.readOnly,
        mode: config.sqlGuard.mode,
        ...(config.sqlGuard.extraWriteKeywords
          ? { extraWriteKeywords: config.sqlGuard.extraWriteKeywords }
          : {}),
        ...(config.sqlGuard.extraReadVerbs
          ? { extraReadVerbs: config.sqlGuard.extraReadVerbs }
          : {}),
      }),
    );
  }
  // instructions runs whenever the lens wants to push text into tool
  // descriptions — either user-supplied policy or (when nothing was
  // written) just the classification banner. Skip only when neither
  // is set.
  //
  // `instructions` accepts either a plain string (legacy) or an
  // object `{ text, position }`. Normalise here so the overlay only
  // sees the object shape.
  const instructionsText =
    typeof config.instructions === "string"
      ? config.instructions
      : (config.instructions?.text ?? "");
  const instructionsPosition: "prepend" | "append" =
    typeof config.instructions === "object" && config.instructions?.position
      ? config.instructions.position
      : "append";
  const hasInstructionsText = instructionsText.trim().length > 0;
  if (hasInstructionsText || config.classification) {
    overlays.push(
      createInstructionsOverlay({
        text: instructionsText,
        position: instructionsPosition,
        ...(config.classification ? { classification: config.classification } : {}),
      }),
    );
  }
  if (config.dbSchema) {
    overlays.push(
      createDbSchemaOverlay({
        connectionString: config.dbSchema.connectionString,
        ...(config.dbSchema.driver ? { driver: config.dbSchema.driver } : {}),
        ...(config.dbSchema.tables ? { tables: config.dbSchema.tables } : {}),
        ...(config.dbSchema.excludeTables ? { excludeTables: config.dbSchema.excludeTables } : {}),
        ...(config.dbSchema.injectInto ? { injectInto: config.dbSchema.injectInto } : {}),
        format: config.dbSchema.format,
        includeComments: config.dbSchema.includeComments,
      }),
    );
  }
  // contextInjection runs after dbSchema. The two are siblings: one
  // is a SQL-shaped automated path, the other is a generic operator-
  // supplied path. Ordering them next to each other keeps the
  // tool-description rewrite phase contiguous and predictable.
  if (config.contextInjection) {
    overlays.push(
      createContextInjectionOverlay({
        injectInto: config.contextInjection.injectInto,
        ...(config.contextInjection.text != null ? { text: config.contextInjection.text } : {}),
        ...(config.contextInjection.textFile != null
          ? { textFile: config.contextInjection.textFile }
          : {}),
        position: config.contextInjection.position,
      }),
    );
  }
  // redact is registered last so it runs last in both directions. On
  // server→client responses that means audit (registered first) sees the
  // un-redacted payload and the client sees the scrubbed one. On
  // client→server requests redact is a no-op (no onClientMessage hook).
  if (config.redact) {
    overlays.push(
      createRedactOverlay({
        rules: config.redact.rules,
        replacement: config.redact.replacement,
        applyTo: config.redact.applyTo,
      }),
    );
  }
  return overlays;
}

function defaultLogger(): LogFn {
  return (level, scope, message, extra) => {
    const timestamp = new Date().toISOString();
    const prefix = `[januscope:${scope}] ${timestamp} ${level}:`;
    if (extra !== undefined) {
      process.stderr.write(`${prefix} ${message} ${JSON.stringify(extra)}\n`);
    } else {
      process.stderr.write(`${prefix} ${message}\n`);
    }
  };
}
