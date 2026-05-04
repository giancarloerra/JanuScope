// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * `toolSurface` overlay — live `tools/list` fingerprinting.
 *
 * Companion to the static lens-config fingerprinting in
 * `src/quarantine.ts`. Where the static layer asks "did the operator
 * (or an attacker) edit the lens YAML?", this overlay asks "did the
 * upstream MCP's actual tool surface change since we last approved
 * it?" — the threat that the prior wording of "tool poisoning
 * defence" implied but did not deliver.
 *
 * Activates only when the lens sets `firstRun: approve`. Watches the
 * server response stream for the FIRST `tools/list` payload, hashes
 * the tool surface (names, descriptions, inputSchemas, annotations,
 * plus any other fields the upstream returns), and consults the
 * persisted approvals file:
 *
 *   - **TOFU** (no live fingerprint stored yet): records the current
 *     fingerprint as the baseline and forwards the response
 *     unchanged. Logs an info line so the operator sees what was
 *     captured.
 *   - **Match**: silent pass-through.
 *   - **Drift**: rewrites the response into a JSON-RPC error to the
 *     client, with a clear remediation path (`januscope approve
 *     --config <path>`). Subsequent tools/list responses in the
 *     same session are also gated until the operator re-approves
 *     out of band.
 *
 * Ordered BEFORE block in `buildOverlays` so the fingerprint is
 * computed against the FULL upstream surface, not the post-block
 * filtered version. Otherwise an attacker who silently added a tool
 * AND added that tool to the lens block list could evade the live
 * check (the static layer would catch the block-list edit, but
 * defence in depth means we want both layers to fire independently).
 */

import { checkLiveTools, type LiveTool } from "../quarantine.js";
import {
  isSuccess,
  makeErrorResponse,
  RpcErrorCode,
  type JsonRpcMessage,
  type JsonRpcSuccess,
} from "../rpc.js";
import type { OverlayConfig } from "../config.js";
import type { Overlay, OverlayContext } from "../pipeline.js";

export interface ToolSurfaceOverlayOptions {
  /** Full lens config — needed for identity computation. */
  config: OverlayConfig;
  /**
   * Override storage path for the approvals file. Mostly used by
   * tests; production resolves to `~/.januscope/approved.json` via
   * the quarantine module's default.
   */
  approvalsPath?: string;
  /**
   * When false, drift is logged but not enforced (the response is
   * forwarded unchanged). Defaults to true. Library embedders can
   * disable enforcement to instrument-only.
   */
  enforce?: boolean;
}

// Once an upstream's tool surface has drifted in a session, every
// subsequent `tools/list` response from that upstream is also rewritten
// into the drift error. The flag is session-sticky so a malicious
// upstream cannot flip back to a good list (after the client re-issues
// `tools/list` in response to `notifications/tools/list_changed`) and
// quietly carry on.
const STATE_DRIFTED = "drifted";

/**
 * Type-guard for a `tools/list` success response. Mirrors the shape
 * the block overlay accepts so the two stay in lockstep.
 */
function isToolsListResult(msg: JsonRpcMessage): msg is JsonRpcSuccess & {
  result: { tools: LiveTool[] };
} {
  if (!isSuccess(msg)) return false;
  const result = msg.result;
  if (!result || typeof result !== "object") return false;
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return false;
  return tools.every((t) => t && typeof t === "object" && typeof (t as LiveTool).name === "string");
}

export function createToolSurfaceOverlay(options: ToolSurfaceOverlayOptions): Overlay {
  const enforce = options.enforce ?? true;

  return {
    name: "toolSurface",
    // Gate-flavoured: a drift detection that fails open would defeat
    // the whole point. If the overlay throws, the pipeline returns an
    // internal error rather than forwarding the unchecked response.
    kind: "gate",

    onServerMessage(msg, ctx) {
      if (!isToolsListResult(msg)) {
        return { kind: "forward", msg };
      }

      // If we already entered the drifted state in this session,
      // refuse subsequent tools/list responses too. Stops a target
      // from racing past the first-check by re-emitting a "good"
      // list after an earlier drift.
      if (ctx.state.get(STATE_DRIFTED) === true) {
        return {
          kind: "forward",
          msg: rewriteAsDriftError(
            msg,
            "januscope: live tools/list drifted; subsequent responses gated until operator re-approves.",
          ),
        };
      }

      // Fingerprint EVERY `tools/list` response, not just the first
      // in the session. MCP defines `notifications/tools/list_changed`
      // and well-behaved clients re-issue `tools/list` after
      // receiving it. If we cached the result of the first check,
      // a compromised upstream could serve the approved list once
      // and then mutate the surface mid-session — exactly the
      // tool-poisoning vector this overlay is supposed to defend
      // against.
      //
      // Re-hashing on every refresh costs microseconds for any
      // realistic tool count (the canonical-JSON serialiser is the
      // heavy bit, and it scales linearly with description size).
      // Worth it.
      const result = checkLiveTools(
        options.config,
        msg.result.tools,
        options.approvalsPath ? { approvalsPath: options.approvalsPath } : {},
      );

      switch (result.kind) {
        case "approved":
          ctx.log("info", `live tools/list matches approval (${result.fingerprint.slice(0, 16)}…)`);
          return { kind: "forward", msg };

        case "tofu":
          ctx.log(
            "info",
            `live tools/list approved by trust-on-first-use ` +
              `(${result.fingerprint.slice(0, 16)}…, ${msg.result.tools.length} tools, persisted=${result.stored}). ` +
              `Subsequent runs with a different upstream tool surface will refuse to forward tools/list until you re-approve.`,
          );
          return { kind: "forward", msg };

        case "no-static-approval":
          // The static check normally runs before we get here; this
          // branch fires if the lens had `firstRun: approve` set but
          // the static check was bypassed for some reason (test
          // harness, library embedding, race during file delete).
          // Log it visibly but don't enforce — the static layer is
          // the right place to refuse startup.
          ctx.log(
            "warn",
            "no static approval for this identity yet — live-tools fingerprint cannot be checked. " +
              "Run `januscope approve --config <path>` to record both fingerprints.",
            { liveFingerprint: result.fingerprint },
          );
          return { kind: "forward", msg };

        case "drift": {
          ctx.state.set(STATE_DRIFTED, true);
          const remediation =
            `januscope: refusing tools/list — upstream tool surface has drifted ` +
            `since the last approval.\n` +
            `  approved at:         ${result.approvedAt}\n` +
            `  approved fingerprint: ${result.approvedFingerprint.slice(0, 16)}…\n` +
            `  current fingerprint:  ${result.currentFingerprint.slice(0, 16)}…\n` +
            `Re-approve with: januscope approve --config <path-to-lens.yaml>`;
          ctx.log("error", "live tools/list drift — refusing", {
            approved: result.approvedFingerprint,
            current: result.currentFingerprint,
            approvedAt: result.approvedAt,
          });
          if (!enforce) {
            return { kind: "forward", msg };
          }
          return { kind: "forward", msg: rewriteAsDriftError(msg, remediation) };
        }
      }
    },
  };
}

/**
 * Replace a `tools/list` success response with a JSON-RPC error
 * keyed off the same id. Preserves the id so the MCP client knows
 * which request the error answers.
 */
function rewriteAsDriftError(msg: JsonRpcSuccess, message: string): JsonRpcMessage {
  // Use InvalidRequest (-32600) rather than InternalError so the
  // client doesn't retry assuming a transient proxy fault.
  return makeErrorResponse(msg.id, RpcErrorCode.InvalidRequest, message);
}

/**
 * Re-export the OverlayContext type so library users implementing
 * their own variants of this overlay can reach into ctx.state.
 */
export type { OverlayContext };
