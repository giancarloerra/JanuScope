// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * `instructions` overlay.
 *
 * Splices a configurable instructions string into the `description`
 * field of every tool returned by `tools/list`. The LLM reads tool
 * descriptions, so this is a lightweight way to inject policy
 * ("read-only", "always include LIMIT 100", "do not bypass via the
 * terminal") without modifying the target server.
 *
 * Position. By default the text is APPENDED after the upstream
 * description (backwards-compatible behaviour for lenses that don't
 * set a position). For policy text that the model needs to read
 * BEFORE forming a plan, set `position: "prepend"` on the lens — the
 * banner + instructions then become the first thing the model sees
 * in every tool's description, before the upstream tool semantics.
 * Both bundled lenses and the empirical evidence (live tests vs
 * Copilot, May 2026) suggest prepend is the more useful default for
 * SURFACE BOUNDARY / SCHEMA SHORTCUT style policies.
 *
 * When the lens sets a `classification`, we prepend a short banner to
 * the instructions text so the LLM sees the data-sensitivity label
 * alongside the policy. This is advice, not enforcement — the real
 * guardrails are `block` / `sqlGuard` / `redact`, and the actual
 * barrier for data-mutation is a read-only credential at the data
 * path (which JanuScope cannot provide; see SECURITY.md's
 * three-layer model).
 */

import type { Overlay } from "../pipeline.js";
import type { Classification } from "../config.js";
import { isSuccess, type JsonRpcMessage, type JsonRpcSuccess } from "../rpc.js";

export interface InstructionsOverlayOptions {
  text: string;
  classification?: Classification;
  /**
   * Where the instructions text lands relative to the upstream
   * tool description. Defaults to "append" for backwards compat;
   * "prepend" leads with the policy and is recommended for new
   * lenses (see SECURITY.md and lenses/CONTRIBUTING.md).
   */
  position?: "prepend" | "append";
}

const SEPARATOR = "\n\n---\n";

/**
 * Human-readable banners we prepend when a lens sets `classification`.
 * Phrasing is deliberately short and LLM-directed — the goal is that
 * the model sees the label in every tool description and weights its
 * answer accordingly.
 */
const CLASSIFICATION_BANNERS: Record<Classification, string> = {
  public: "CLASSIFICATION: PUBLIC — non-sensitive data; normal care applies.",
  internal:
    "CLASSIFICATION: INTERNAL — internal data. Do not expose raw values to end users; summarise when possible.",
  sensitive:
    "CLASSIFICATION: SENSITIVE — PII, financial, or regulated data. Default to aggregate or identity-preserving answers; never echo raw values.",
};

interface ToolLike {
  name: string;
  description?: string;
  [key: string]: unknown;
}

export function createInstructionsOverlay(options: InstructionsOverlayOptions): Overlay {
  const trimmed = options.text.trim();
  const classificationBanner = options.classification
    ? CLASSIFICATION_BANNERS[options.classification]
    : "";
  // Build the final injected text once at construction: banner first
  // (if any), then user policy. If there is neither, the overlay is
  // a no-op for tools/list.
  const injected = [classificationBanner, trimmed].filter((s) => s.length > 0).join("\n\n");
  const position = options.position ?? "append";

  return {
    name: "instructions",
    onServerMessage(msg) {
      if (injected.length === 0 || !isToolsListResult(msg)) {
        return { kind: "forward", msg };
      }
      const rewritten = msg.result.tools.map((t) => spliceInstructions(t, injected, position));
      const newResult: Record<string, unknown> = { ...msg.result, tools: rewritten };
      const out: JsonRpcSuccess = { ...msg, result: newResult };
      return { kind: "forward", msg: out };
    },
  };
}

function spliceInstructions(
  tool: ToolLike,
  instructions: string,
  position: "prepend" | "append",
): ToolLike {
  const existing = typeof tool.description === "string" ? tool.description.trim() : "";
  if (existing.length === 0) {
    return { ...tool, description: instructions };
  }
  const description =
    position === "append"
      ? `${existing}${SEPARATOR}${instructions}`
      : `${instructions}${SEPARATOR}${existing}`;
  return { ...tool, description };
}

function isToolsListResult(msg: JsonRpcMessage): msg is JsonRpcSuccess & {
  result: { tools: ToolLike[] };
} {
  if (!isSuccess(msg)) return false;
  const result = msg.result;
  if (!result || typeof result !== "object") return false;
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return false;
  return tools.every((t) => t && typeof t === "object" && typeof (t as ToolLike).name === "string");
}
