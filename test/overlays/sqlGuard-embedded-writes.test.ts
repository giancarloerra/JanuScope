/**
 * Writes hiding inside a leading-read statement — all caught by the
 * `hasEmbeddedWrite` second-pass scan in sqlGuard's allowlist mode.
 *
 *   A. Data-modifying CTE: `WITH x AS (DELETE ...) SELECT ...`
 *   B. Postgres `SELECT * INTO new_table FROM ...` (CREATE TABLE AS)
 *   C. CTE with INSERT inside
 *   D. `EXPLAIN ANALYZE DELETE ...` (ANALYZE actually runs the DELETE)
 *
 * Flipping `toTarget.toHaveLength(0)` to 1 on any of these would
 * indicate a regression in the embedded-write detector.
 *
 * Companion tests in sqlGuard.test.ts confirm that the row-locking
 * `SELECT ... FOR UPDATE` / `FOR SHARE` clauses (which mention the
 * UPDATE / SHARE keywords) still pass — those are the legitimate
 * reads the scanner must not over-block.
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

function call(sql: string): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "query", arguments: { sql } },
  };
}

describe("sqlGuard: writes hiding inside a leading-read statement", () => {
  it("BYPASS A: data-modifying CTE (WITH ... AS (DELETE ...))", async () => {
    const { pipeline, toTarget, toClient } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(
      call("WITH deleted AS (DELETE FROM audits RETURNING id) SELECT count(*) FROM deleted"),
    );
    expect(toTarget).toHaveLength(0);
    expect(toClient).toHaveLength(1);
  });

  it("BYPASS B: SELECT INTO creates a new table (leading verb SELECT)", async () => {
    const { pipeline, toTarget, toClient } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(call("SELECT * INTO shadow_users FROM users"));
    expect(toTarget).toHaveLength(0);
    expect(toClient).toHaveLength(1);
  });

  it("BYPASS C: INSERT inside a CTE (leading verb WITH)", async () => {
    const { pipeline, toTarget, toClient } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(
      call(
        "WITH moved AS (INSERT INTO shadow_audits SELECT * FROM audits RETURNING 1) SELECT count(*) FROM moved",
      ),
    );
    expect(toTarget).toHaveLength(0);
    expect(toClient).toHaveLength(1);
  });

  it("BYPASS D: EXPLAIN ANALYZE DELETE actually executes the DELETE", async () => {
    const { pipeline, toTarget, toClient } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(call("EXPLAIN ANALYZE DELETE FROM audits WHERE id < 100"));
    expect(toTarget).toHaveLength(0);
    expect(toClient).toHaveLength(1);
  });

  it("UPDATE inside a CTE (leading verb WITH) is blocked", async () => {
    const { pipeline, toTarget, toClient } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(
      call(
        "WITH bumped AS (UPDATE users SET credits = credits + 1 RETURNING id) SELECT count(*) FROM bumped",
      ),
    );
    expect(toTarget).toHaveLength(0);
    expect(toClient).toHaveLength(1);
  });
});

describe("sqlGuard: legitimate reads that must NOT be over-blocked", () => {
  // The embedded-write scanner looks for DML keywords anywhere in the
  // statement. Row-locking clauses mention UPDATE/SHARE; these are
  // read-only reserved clauses and must still pass.

  it("SELECT ... FOR UPDATE passes", async () => {
    const { pipeline, toTarget, toClient } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(call("SELECT * FROM users WHERE id = 1 FOR UPDATE"));
    expect(toTarget).toHaveLength(1);
    expect(toClient).toHaveLength(0);
  });

  it("SELECT ... FOR NO KEY UPDATE passes", async () => {
    const { pipeline, toTarget, toClient } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(call("SELECT * FROM users WHERE id = 1 FOR NO KEY UPDATE"));
    expect(toTarget).toHaveLength(1);
    expect(toClient).toHaveLength(0);
  });

  it("SELECT ... FOR SHARE passes", async () => {
    const { pipeline, toTarget, toClient } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(call("SELECT * FROM users WHERE id = 1 FOR SHARE"));
    expect(toTarget).toHaveLength(1);
    expect(toClient).toHaveLength(0);
  });

  it("column names containing DML keyword fragments pass", async () => {
    // `col_delete_at` has DELETE embedded between word chars — no
    // word boundary, so no match. Must pass.
    const { pipeline, toTarget, toClient } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(call("SELECT id, col_delete_at, was_updated_at FROM users"));
    expect(toTarget).toHaveLength(1);
    expect(toClient).toHaveLength(0);
  });

  it("DML keywords inside string literals pass (literals are blanked)", async () => {
    const { pipeline, toTarget, toClient } = pipelineFor();
    await pipeline.start();
    await pipeline.handleClientMessage(
      call("SELECT * FROM audits WHERE note = 'DELETE FROM users was attempted'"),
    );
    expect(toTarget).toHaveLength(1);
    expect(toClient).toHaveLength(0);
  });
});
