// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * Overlay pipeline: an ordered list of overlays that can inspect, modify,
 * or short-circuit JSON-RPC messages flowing in either direction.
 *
 * ## Concurrency
 *
 * Each call to {@link Pipeline.handleClientMessage} /
 * {@link Pipeline.handleServerMessage} walks the overlay list
 * sequentially, awaiting each overlay before invoking the next.
 *
 * The *transport* invokes these handlers as fire-and-forget (`void
 * pipeline.handleClientMessage(...)`). If two frames arrive in the
 * same `data` chunk, both handlers are started back-to-back; if any
 * bundled overlay were to `await` between two hot-path operations,
 * their two passes could theoretically interleave. In practice every
 * bundled overlay's `onClientMessage` / `onServerMessage` is
 * synchronous (or awaits only trivially at the boundary), so this is
 * a theoretical concern today but a real one for library users who
 * write asynchronous overlays — consider serialising with a
 * promise-chained queue in that case.
 *
 * `setup()` is always awaited before any messages flow;
 * `teardown()` runs once on pipeline stop.
 */

import {
  isRequest as isRequestMessage,
  makeErrorResponse,
  RpcErrorCode,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from "./rpc.js";
import { NOOP_TRACER, messageAttributes, type JanuScopeTracer } from "./telemetry.js";
import { extractToolNameFromMessage } from "./overlays/_shared.js";
import type { Classification } from "./config.js";

/**
 * Build the canonical fail-closed response used when a gate overlay
 * throws. Factored here so the ID-typing matches the rest of the
 * call-site.
 */
function makeInternalErrorResponse(id: number | string, message: string): JsonRpcMessage {
  return makeErrorResponse(id, RpcErrorCode.InternalError, message);
}

export interface OverlayContext {
  /** Write a diagnostic message to stderr, prefixed with overlay name. */
  log: (level: "info" | "warn" | "error", message: string, extra?: unknown) => void;
  /**
   * Send a message directly to the client, bypassing the rest of the
   * pipeline. Used by overlays that inject messages (rare).
   */
  sendToClient: (msg: JsonRpcMessage) => void;
  /** Similarly, inject a message directly to the target (rare). */
  sendToTarget: (msg: JsonRpcMessage) => void;
  /** Overlay-scoped ephemeral state. Each overlay has its own bucket. */
  state: Map<string, unknown>;
}

export type ClientMessageResult =
  | { kind: "forward"; msg: JsonRpcMessage }
  | { kind: "respond"; response: JsonRpcMessage }
  | { kind: "drop" };

export type ServerMessageResult = { kind: "forward"; msg: JsonRpcMessage } | { kind: "drop" };

export interface Overlay {
  /** Human-readable name, used in log prefixes. */
  readonly name: string;

  /**
   * Fail-open vs fail-closed policy when this overlay throws. A "gate"
   * overlay (block, sqlGuard) enforces a security boundary; if its
   * handler crashes on a malformed payload, forwarding the original
   * message would defeat the whole point of the proxy. "Observer"
   * overlays (audit, redact, dbSchema, instructions) enhance the
   * request/response but are not the last line of defence — an
   * exception there should not break the pipeline. Defaults to
   * `"observer"` so overlays that never set it preserve the v0.3
   * availability-over-completeness behaviour.
   */
  readonly kind?: "gate" | "observer";

  /** Called once before any messages flow. */
  setup?(ctx: OverlayContext): Promise<void> | void;

  /** Called when the pipeline shuts down. */
  teardown?(ctx: OverlayContext): Promise<void> | void;

  /** Invoked on each incoming message from the client. */
  onClientMessage?(
    msg: JsonRpcMessage,
    ctx: OverlayContext,
  ): ClientMessageResult | Promise<ClientMessageResult>;

  /** Invoked on each outgoing message from the target. */
  onServerMessage?(
    msg: JsonRpcMessage,
    ctx: OverlayContext,
  ): ServerMessageResult | Promise<ServerMessageResult>;
}

export interface PipelineHooks {
  /** Receives messages intended for the target (after client-side overlays). */
  onForwardToTarget: (msg: JsonRpcMessage) => void;
  /** Receives messages intended for the client (after server-side overlays). */
  onForwardToClient: (msg: JsonRpcMessage) => void;
  /** Diagnostic logging sink. */
  log: (level: "info" | "warn" | "error", scope: string, message: string, extra?: unknown) => void;
  /**
   * Optional OpenTelemetry tracer. Defaults to the shared no-op (zero
   * network, constant branches). When supplied, each message handler
   * emits a root span, and each overlay invocation emits a child span.
   */
  tracer?: JanuScopeTracer;
  /**
   * Optional data-sensitivity label from the lens config. When set,
   * the tracer attaches it to every span so downstream OTel pipelines
   * can route sensitive-lens traffic to a tighter retention path
   * without re-deriving the label from the tool name.
   */
  classification?: Classification;
}

export class Pipeline {
  private readonly overlays: Overlay[];
  private readonly hooks: PipelineHooks;
  private readonly tracer: JanuScopeTracer;
  // Keyed by overlay identity, not by `overlay.name`, so two overlays
  // sharing a name (easy to hit when a library user composes multiple
  // instances of the same overlay) keep separate state buckets.
  private readonly stateByOverlay = new WeakMap<Overlay, Map<string, unknown>>();
  private started = false;

  constructor(overlays: Overlay[], hooks: PipelineHooks) {
    this.overlays = overlays;
    this.hooks = hooks;
    this.tracer = hooks.tracer ?? NOOP_TRACER;
    for (const overlay of overlays) {
      this.stateByOverlay.set(overlay, new Map<string, unknown>());
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const overlay of this.overlays) {
      if (overlay.setup) {
        await overlay.setup(this.contextFor(overlay));
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    // Teardown in reverse order so dependencies wind down cleanly.
    for (let i = this.overlays.length - 1; i >= 0; i--) {
      const overlay = this.overlays[i];
      if (overlay && overlay.teardown) {
        try {
          await overlay.teardown(this.contextFor(overlay));
        } catch (err) {
          this.hooks.log("error", overlay.name, "teardown error", errorInfo(err));
        }
      }
    }
  }

  /** Process a message from the client. Side-effects via hooks. */
  async handleClientMessage(msg: JsonRpcMessage): Promise<void> {
    // Skip the attributes object entirely when the tracer is the
    // shared no-op. Building it on every client message costs ~1 us
    // on M2 / Node 22 — the bench:overhead delta the review flagged.
    const rootSpan = this.tracer.enabled
      ? this.tracer.startSpan(
          "januscope.client_message",
          messageAttributes(
            "client",
            extractMethod(msg),
            extractToolNameForTelemetry(msg),
            this.hooks.classification,
          ),
        )
      : this.tracer.startSpan("januscope.client_message");
    let current: JsonRpcMessage = msg;
    try {
      for (const overlay of this.overlays) {
        if (!overlay.onClientMessage) continue;
        const span = this.tracer.enabled
          ? this.tracer.startChildSpan(rootSpan, `januscope.overlay.${overlay.name}`, {
              "januscope.overlay.name": overlay.name,
              "januscope.overlay.kind": overlay.kind ?? "observer",
            })
          : this.tracer.startChildSpan(rootSpan, `januscope.overlay.${overlay.name}`);
        let result: ClientMessageResult;
        try {
          result = await overlay.onClientMessage(current, this.contextFor(overlay));
        } catch (err) {
          span.recordError(err);
          span.end();
          this.hooks.log("error", overlay.name, "client overlay threw", errorInfo(err));
          // Fail policy depends on overlay kind. "gate" overlays enforce
          // a security boundary (block, sqlGuard); if they crash on a
          // malformed payload, continuing would forward the unchecked
          // request to the target — defeating the whole point. Respond
          // with an internal-error JSON-RPC and stop processing.
          // "observer" overlays enhance but do not gate; a crash there
          // should not break the caller.
          if (overlay.kind === "gate" && isRequestMessage(current)) {
            rootSpan.setAttribute("januscope.outcome", "gate_failure");
            rootSpan.setStatus("error", `gate overlay '${overlay.name}' failed`);
            this.hooks.onForwardToClient(
              makeInternalErrorResponse(
                (current as { id: number | string }).id,
                `januscope: gate overlay '${overlay.name}' failed; message refused for safety.`,
              ),
            );
            return;
          }
          // observer overlay: fail open, continue.
          continue;
        }
        span.setAttribute("januscope.overlay.result", result.kind);
        span.end();
        if (result.kind === "drop") {
          rootSpan.setAttribute("januscope.outcome", "dropped");
          return;
        }
        if (result.kind === "respond") {
          rootSpan.setAttribute("januscope.outcome", "short_circuited");
          rootSpan.setAttribute("januscope.short_circuit_by", overlay.name);
          this.hooks.onForwardToClient(result.response);
          return;
        }
        current = result.msg;
      }
      rootSpan.setAttribute("januscope.outcome", "forwarded");
      this.hooks.onForwardToTarget(current);
    } finally {
      rootSpan.end();
    }
  }

  /**
   * Process a message from the target. Side-effects via hooks.
   *
   * Server messages iterate overlays in list order (not reversed). This
   * gives a single predictable rule: "list order = processing order in
   * both directions." It also means an overlay registered early (like
   * `audit`) observes the target response BEFORE overlays registered
   * later (like `redact`) modify it — which is what compliance audits
   * require.
   */
  async handleServerMessage(msg: JsonRpcMessage): Promise<void> {
    const rootSpan = this.tracer.enabled
      ? this.tracer.startSpan(
          "januscope.server_message",
          messageAttributes(
            "server",
            extractMethod(msg),
            extractToolNameForTelemetry(msg),
            this.hooks.classification,
          ),
        )
      : this.tracer.startSpan("januscope.server_message");
    let current: JsonRpcMessage = msg;
    try {
      for (const overlay of this.overlays) {
        if (!overlay.onServerMessage) continue;
        const span = this.tracer.enabled
          ? this.tracer.startChildSpan(rootSpan, `januscope.overlay.${overlay.name}`, {
              "januscope.overlay.name": overlay.name,
              "januscope.overlay.kind": overlay.kind ?? "observer",
            })
          : this.tracer.startChildSpan(rootSpan, `januscope.overlay.${overlay.name}`);
        let result: ServerMessageResult;
        try {
          result = await overlay.onServerMessage(current, this.contextFor(overlay));
        } catch (err) {
          span.recordError(err);
          span.end();
          this.hooks.log("error", overlay.name, "server overlay threw", errorInfo(err));
          continue;
        }
        span.setAttribute("januscope.overlay.result", result.kind);
        span.end();
        if (result.kind === "drop") {
          rootSpan.setAttribute("januscope.outcome", "dropped");
          return;
        }
        current = result.msg;
      }
      rootSpan.setAttribute("januscope.outcome", "forwarded");
      this.hooks.onForwardToClient(current);
    } finally {
      rootSpan.end();
    }
  }

  private contextFor(overlay: Overlay): OverlayContext {
    const state = this.stateByOverlay.get(overlay);
    if (!state) {
      throw new Error(`internal: missing state bucket for overlay '${overlay.name}'`);
    }
    return {
      state,
      log: (level, message, extra) => this.hooks.log(level, overlay.name, message, extra),
      sendToClient: (m) => this.hooks.onForwardToClient(m),
      sendToTarget: (m) => this.hooks.onForwardToTarget(m),
    };
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

function extractMethod(msg: JsonRpcMessage): string | undefined {
  // Requests and notifications carry a method; responses don't.
  return (msg as Partial<JsonRpcRequest>).method;
}

/**
 * Wrap the shared {@link extractToolNameFromMessage} helper so the
 * telemetry layer gets `undefined` (omits the span attribute)
 * instead of `null` (which would land as the literal string "null"
 * in most OTel backends).
 */
function extractToolNameForTelemetry(msg: JsonRpcMessage): string | undefined {
  return extractToolNameFromMessage(msg) ?? undefined;
}
