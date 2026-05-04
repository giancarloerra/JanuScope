/**
 * sqlGuard allowlist-mode coverage for Postgres admin, filesystem,
 * session and cross-database functions. These look like SELECT
 * reads but actually touch the server environment:
 *
 *   pg_sleep(30)            wall-clock DoS
 *   lo_export(...)          writes to server filesystem
 *   lo_import(...)          reads from server filesystem
 *   pg_read_file(...)       reads from server filesystem
 *   dblink(...)             cross-database query + write surface
 *   pg_terminate_backend(p) session termination
 *
 * All caught by the dangerous-function denylist in
 * `hasEmbeddedWrite`. The denylist is a deliberate enumeration
 * rather than a pattern — new dangerous functions in future
 * Postgres releases are undetected until added.
 *
 * The UDF-name case (e.g. `SELECT schema.delete_all()`) is a
 * separate documented limit — see `sqlGuard-udf-limits.test.ts`.
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
  const pipeline = new Pipeline([createSqlGuardOverlay({ tools: ["query"] })], {
    onForwardToTarget: (m) => toTarget.push(m),
    onForwardToClient: (m) => toClient.push(m),
    log: () => {},
  });
  return { pipeline, toTarget, toClient };
}

function callQuery(sql: string): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "query", arguments: { sql } },
  };
}

describe("sqlGuard: Postgres admin / filesystem / session functions", () => {
  it("BYPASS #B1: SELECT pg_sleep(30) is BLOCKED (DoS vector)", async () => {
    const { pipeline, toTarget, toClient } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(callQuery("SELECT pg_sleep(30)"));
    expect(toTarget).toHaveLength(0);
    expect(toClient).toHaveLength(1);
  });

  it("BYPASS #B2: SELECT lo_export writes server filesystem — BLOCKED", async () => {
    const { pipeline, toTarget, toClient } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(callQuery("SELECT lo_export(2, '/tmp/pwned')"));
    expect(toTarget).toHaveLength(0);
    expect(toClient).toHaveLength(1);
  });

  it("BYPASS #B2b: SELECT lo_import reads server filesystem — BLOCKED", async () => {
    const { pipeline, toTarget, toClient } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(callQuery("SELECT lo_import('/etc/passwd')"));
    expect(toTarget).toHaveLength(0);
    expect(toClient).toHaveLength(1);
  });

  it("BYPASS #B2c: SELECT pg_read_file — BLOCKED", async () => {
    const { pipeline, toTarget } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(callQuery("SELECT pg_read_file('/etc/hostname')"));
    expect(toTarget).toHaveLength(0);
  });

  it("BYPASS #B2d: dblink cross-database write — BLOCKED", async () => {
    const { pipeline, toTarget } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(
      callQuery("SELECT dblink('host=other', 'DROP TABLE audits')"),
    );
    expect(toTarget).toHaveLength(0);
  });

  it("BYPASS #B2e: pg_terminate_backend (kick user) — BLOCKED", async () => {
    const { pipeline, toTarget } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(callQuery("SELECT pg_terminate_backend(12345)"));
    expect(toTarget).toHaveLength(0);
  });

  it("BYPASS #C1: VALUES wrapping data-modifying CTE — BLOCKED", async () => {
    const { pipeline, toTarget, toClient } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(
      callQuery("VALUES ((WITH d AS (DELETE FROM audits RETURNING 1) SELECT 1))"),
    );
    expect(toTarget).toHaveLength(0);
    expect(toClient).toHaveLength(1);
  });

  it("BYPASS #D1: SELECT schema.delete_all() — documented limit, NOT blocked", async () => {
    // `\b` word boundary does not fire between `_` and `d`, so
    // `\bDELETE\b` misses `delete_all`. Closing this would require a
    // real SQL parser + function-catalogue lookup against the target
    // DB. FAQ in README documents the limit; recommended mitigation
    // is a read-only DB-level role as a last line of defence.
    const { pipeline, toTarget } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(callQuery("SELECT schema.delete_all()"));
    // Intentionally forwarded; this test pins behaviour so a future
    // parser-based fix can flip the expectation.
    expect(toTarget).toHaveLength(1);
  });

  it("BYPASS #D2: SELECT DELETE() literal keyword UDF — BLOCKED", async () => {
    const { pipeline, toTarget } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(callQuery("SELECT DELETE()"));
    expect(toTarget).toHaveLength(0);
  });

  it("BYPASS #E1: COPY t TO '/tmp/exfil' — BLOCKED (leading verb)", async () => {
    const { pipeline, toTarget } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(callQuery("COPY audits TO '/tmp/exfil.csv'"));
    expect(toTarget).toHaveLength(0);
  });

  it("Over-block check: column name containing pg_sleep passes", async () => {
    const { pipeline, toTarget } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(callQuery("SELECT pg_sleep_label FROM metrics"));
    expect(toTarget).toHaveLength(1);
  });

  it("Over-block check: pg_sleep inside a string literal passes", async () => {
    const { pipeline, toTarget } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(
      callQuery("SELECT * FROM users WHERE note = 'pg_sleep(30) was attempted'"),
    );
    expect(toTarget).toHaveLength(1);
  });
});
