// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * `rateLimit` overlay.
 *
 * Token-bucket rate limiter on `tools/call` requests, keyed by tool
 * name. Each rule names a tool (literal or `*` glob) and a per-minute
 * budget. The first rule whose pattern matches the incoming tool name
 * decides the budget; each tool gets its own bucket so a hot tool
 * does not starve the others even when they share a `"*"` rule.
 *
 * On breach we respond with `-32000` (JSON-RPC server-defined error
 * range, closest semantic match to HTTP 429) rather than forwarding
 * the call to the target. We classify this as a `gate` overlay so a
 * handler crash fails closed alongside `block` and `sqlGuard`.
 */
import type { Overlay, OverlayContext } from "../pipeline.js";
import { isRequest, makeErrorResponse } from "../rpc.js";
import { compileToolMatcher, extractToolName } from "./_shared.js";

export interface RateLimitRule {
  /** Exact tool name or `*`-glob (same shape as `block`). */
  tool: string;
  /** Budget. Bucket refills steadily at `perMinute / 60` tokens/second. */
  perMinute: number;
}

export interface RateLimitOverlayOptions {
  rules: ReadonlyArray<RateLimitRule>;
  /** Clock injection for deterministic tests. Default: `Date.now`. */
  now?: () => number;
}

interface CompiledRule {
  readonly match: (name: string) => boolean;
  readonly perMinute: number;
  /**
   * Bucket cap in tokens. Equals `perMinute` for rates ≥ 1/min (lets
   * traffic burst up to a full minute's budget). Floored at 1 for
   * fractional rates (e.g. `perMinute: 0.5` would otherwise cap the
   * bucket below 1 token and permanently reject every call — see the
   * regression test in `test/overlays/rateLimit.test.ts`).
   */
  readonly capacity: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const BUCKETS_KEY = "buckets";
/** -32000 is the top of the JSON-RPC "server error" band (-32000 → -32099). */
const RATE_LIMIT_ERROR_CODE = -32000;

export function createRateLimitOverlay(options: RateLimitOverlayOptions): Overlay {
  const compiled = options.rules.map(compileRule);
  const now = options.now ?? (() => Date.now());

  return {
    name: "rateLimit",
    kind: "gate",

    setup(ctx) {
      ctx.state.set(BUCKETS_KEY, new Map<string, Bucket>());
    },

    onClientMessage(msg, ctx) {
      if (!isRequest(msg)) return { kind: "forward", msg };
      if (msg.method !== "tools/call") return { kind: "forward", msg };

      const toolName = extractToolName(msg.params);
      if (toolName === null) return { kind: "forward", msg };

      const rule = compiled.find((r) => r.match(toolName));
      if (!rule) return { kind: "forward", msg };

      const bucket = getOrCreateBucket(ctx, toolName, rule.capacity, now());
      refill(bucket, rule, now());

      if (bucket.tokens < 1) {
        const retryAfterSec = Math.ceil((60 * (1 - bucket.tokens)) / rule.perMinute);
        ctx.log("info", `rate limit exceeded for '${toolName}' (${rule.perMinute}/min)`);
        return {
          kind: "respond",
          response: makeErrorResponse(
            msg.id,
            RATE_LIMIT_ERROR_CODE,
            `Tool '${toolName}' rate limit exceeded (${rule.perMinute}/min). Retry after ~${retryAfterSec}s.`,
            { retry_after_seconds: retryAfterSec, limit_per_minute: rule.perMinute },
          ),
        };
      }

      bucket.tokens -= 1;
      return { kind: "forward", msg };
    },
  };
}

function compileRule(rule: RateLimitRule): CompiledRule {
  if (!Number.isFinite(rule.perMinute) || rule.perMinute <= 0) {
    throw new Error(
      `rateLimit: perMinute must be a positive finite number (got ${rule.perMinute} for tool '${rule.tool}')`,
    );
  }
  // Floor capacity at 1 so fractional rates (e.g. 0.5/min = "one call
  // every 2 minutes") can ever reach the `tokens >= 1` threshold. For
  // rates ≥ 1 this is a no-op and we keep the original "burst up to
  // one minute's budget" semantic.
  const capacity = Math.max(1, rule.perMinute);
  return { match: compileToolMatcher(rule.tool), perMinute: rule.perMinute, capacity };
}

function getOrCreateBucket(
  ctx: OverlayContext,
  toolName: string,
  capacity: number,
  nowMs: number,
): Bucket {
  const buckets = ctx.state.get(BUCKETS_KEY) as Map<string, Bucket>;
  let bucket = buckets.get(toolName);
  if (!bucket) {
    // Start full so the first call is never falsely rate-limited.
    bucket = { tokens: capacity, lastRefillMs: nowMs };
    buckets.set(toolName, bucket);
  }
  return bucket;
}

function refill(bucket: Bucket, rule: CompiledRule, nowMs: number): void {
  const elapsedMs = nowMs - bucket.lastRefillMs;
  if (elapsedMs <= 0) return;
  const refillTokens = (elapsedMs / 60_000) * rule.perMinute;
  bucket.tokens = Math.min(rule.capacity, bucket.tokens + refillTokens);
  bucket.lastRefillMs = nowMs;
}
