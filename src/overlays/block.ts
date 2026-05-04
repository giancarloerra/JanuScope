// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * `block` overlay.
 *
 * - Filters blocked tools out of `tools/list` responses.
 * - Short-circuits `tools/call` for blocked tool names with a JSON-RPC
 *   -32601 error, never forwarding the call to the target.
 *
 * Matching supports exact names and `*` glob. `*` matches any run of
 * characters except `:`, so "admin_*" matches "admin_delete" but not
 * "something:admin_delete".
 */

import type { Overlay } from "../pipeline.js";
import {
  isRequest,
  isSuccess,
  makeErrorResponse,
  RpcErrorCode,
  type JsonRpcMessage,
  type JsonRpcSuccess,
} from "../rpc.js";
import { compileToolMatcher, extractToolName } from "./_shared.js";

export interface BlockOverlayOptions {
  rules: ReadonlyArray<string>;
}

interface ToolLike {
  name: string;
  [key: string]: unknown;
}

export function createBlockOverlay(options: BlockOverlayOptions): Overlay {
  const matchers = options.rules.map(compileToolMatcher);
  const isBlocked = (name: string): boolean => matchers.some((m) => m(name));

  return {
    name: "block",
    kind: "gate", // security boundary — fail closed if this handler throws
    onClientMessage(msg, ctx) {
      if (!isRequest(msg)) {
        return { kind: "forward", msg };
      }
      if (msg.method !== "tools/call") {
        return { kind: "forward", msg };
      }
      const toolName = extractToolName(msg.params);
      if (toolName === null || !isBlocked(toolName)) {
        return { kind: "forward", msg };
      }
      ctx.log("info", `blocked tools/call for '${toolName}'`);
      return {
        kind: "respond",
        response: makeErrorResponse(
          msg.id,
          RpcErrorCode.MethodNotFound,
          `Tool '${toolName}' is blocked by januscope policy`,
        ),
      };
    },
    onServerMessage(msg) {
      if (!isSuccess(msg) || !isToolsListResult(msg)) {
        return { kind: "forward", msg };
      }
      const filteredTools = filterTools(msg.result.tools, isBlocked);
      const newResult: Record<string, unknown> = { ...msg.result, tools: filteredTools };
      const filtered: JsonRpcSuccess = { ...msg, result: newResult };
      return { kind: "forward", msg: filtered };
    },
  };
}

function filterTools(tools: ToolLike[], isBlocked: (name: string) => boolean): ToolLike[] {
  return tools.filter((t) => !isBlocked(t.name));
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
