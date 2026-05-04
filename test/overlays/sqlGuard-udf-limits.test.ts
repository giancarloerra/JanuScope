/**
 * Pinning tests for sqlGuard's **documented limits around user-defined
 * functions with mutation-verb name fragments**.
 *
 * JavaScript's `\b` word boundary treats `_` as a word character, so
 * `\bDELETE\b` does not match inside identifiers like `delete_all` or
 * `dropUsers`. A leading-SELECT statement that calls such a UDF is
 * unambiguously a mutation, but the proxy-layer keyword scanner
 * cannot distinguish it from a legitimate read — doing so would need
 * a real SQL parser plus a function-catalogue lookup against the
 * target DB, which is out of scope for middleware. The recommended
 * backstop for these cases is a read-only DB role.
 *
 *   - `DROP/**​/TABLE users`          → blocked (leading verb DROP)
 *   - `SELECT dropUsers()`             → forwarded (documented limit)
 *   - `SELECT purge_audits(...)`       → forwarded (documented limit)
 *
 * Expectations for #2 and #3 are deliberate `toClient.length === 0`
 * assertions — they pin the current behaviour. If a future release
 * adds SQL-parser-backed function-call analysis, the expectations
 * should flip.
 */

import { describe, it, expect } from "vitest";
import { createSqlGuardOverlay } from "../../src/overlays/sqlGuard.js";
import { Pipeline } from "../../src/pipeline.js";
import type { JsonRpcMessage } from "../../src/rpc.js";

function pipelineFor(): {
  pipeline: Pipeline;
  toTarget: JsonRpcMessage[];
  toClient: JsonRpcMessage[];
} {
  const toTarget: JsonRpcMessage[] = [];
  const toClient: JsonRpcMessage[] = [];
  const pipeline = new Pipeline(
    [createSqlGuardOverlay({ tools: ["query"] })], // default: allowlist mode
    {
      onForwardToTarget: (m) => toTarget.push(m),
      onForwardToClient: (m) => toClient.push(m),
      log: () => {},
    },
  );
  return { pipeline, toTarget, toClient };
}

function call(sql: string): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "query", arguments: { sql } },
  };
}

describe("sqlGuard: UDF word-boundary limits (pinning tests)", () => {
  it("covered: `DROP/**​/TABLE users` is rejected (leading verb = DROP)", async () => {
    const { pipeline, toTarget, toClient } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(call("DROP/**/TABLE users"));
    expect(toTarget).toHaveLength(0);
    expect(toClient).toHaveLength(1); // rejected
  });

  it("KNOWN LIMITATION: `SELECT dropUsers()` is forwarded (mitigate with a read-only DB role)", async () => {
    const { pipeline, toTarget, toClient } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(call("SELECT dropUsers()"));
    // Intentionally forwarded: allowlist mode only inspects the leading
    // verb. A mutating UDF invoked from SELECT is undetectable at the
    // proxy layer. Recommended mitigation: a read-only DB role.
    expect(toTarget).toHaveLength(1);
    expect(toClient).toHaveLength(0);
  });

  it("KNOWN LIMITATION: `SELECT purge_audits(...)` is forwarded (same class as dropUsers)", async () => {
    const { pipeline, toTarget, toClient } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(call("SELECT purge_audits(now() - interval '30 days')"));
    expect(toTarget).toHaveLength(1);
    expect(toClient).toHaveLength(0);
  });
});
