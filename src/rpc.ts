// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * JSON-RPC 2.0 types and line-delimited framing helpers.
 *
 * MCP stdio transport uses newline-delimited JSON. We read bytes from a
 * stream, accumulate them in a buffer, and emit one parsed message per
 * complete line.
 */

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorBody;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcError;

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "method" in msg && "id" in msg;
}

export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return "method" in msg && !("id" in msg);
}

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcSuccess | JsonRpcError {
  return "id" in msg && !("method" in msg);
}

export function isSuccess(msg: JsonRpcMessage): msg is JsonRpcSuccess {
  return isResponse(msg) && "result" in msg;
}

export function isErrorResponse(msg: JsonRpcMessage): msg is JsonRpcError {
  return isResponse(msg) && "error" in msg;
}

/** Standard JSON-RPC error codes. */
export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export function makeErrorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  const error: JsonRpcErrorBody = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

/**
 * Streaming NDJSON frame decoder.
 *
 * Feed raw chunks (Buffer or string) via `push`; complete messages are
 * emitted to the callback provided at construction. Malformed lines are
 * passed to `onParseError` rather than crashing the stream.
 */
export class FrameDecoder {
  private buffer = "";

  constructor(
    private readonly onMessage: (msg: JsonRpcMessage, raw: string) => void,
    private readonly onParseError: (err: Error, raw: string) => void,
  ) {}

  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.drain();
  }

  /** Call on stream end to flush any final partial line if it happens to be a complete JSON. */
  flush(): void {
    if (this.buffer.trim().length === 0) {
      this.buffer = "";
      return;
    }
    this.tryParseAndEmit(this.buffer);
    this.buffer = "";
  }

  private drain(): void {
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.trim().length === 0) continue;
      this.tryParseAndEmit(line);
    }
  }

  private tryParseAndEmit(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      this.onParseError(err instanceof Error ? err : new Error(String(err)), line);
      return;
    }
    if (!isJsonRpcShape(parsed)) {
      this.onParseError(new Error("message is not a valid JSON-RPC 2.0 envelope"), line);
      return;
    }
    this.onMessage(parsed, line);
  }
}

function isJsonRpcShape(value: unknown): value is JsonRpcMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { jsonrpc?: unknown };
  return v.jsonrpc === "2.0";
}

/** Serialise a message to a frame (JSON + trailing newline). */
export function encodeFrame(msg: JsonRpcMessage): string {
  return JSON.stringify(msg) + "\n";
}
