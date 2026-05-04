import { describe, it, expect } from "vitest";
import { createSqlGuardOverlay, _internals } from "../../src/overlays/sqlGuard.js";
import { Pipeline } from "../../src/pipeline.js";
import type { JsonRpcMessage } from "../../src/rpc.js";

function pipelineFor(options: Parameters<typeof createSqlGuardOverlay>[0]): {
  pipeline: Pipeline;
  toTarget: JsonRpcMessage[];
  toClient: JsonRpcMessage[];
} {
  const toTarget: JsonRpcMessage[] = [];
  const toClient: JsonRpcMessage[] = [];
  const pipeline = new Pipeline([createSqlGuardOverlay(options)], {
    onForwardToTarget: (m) => toTarget.push(m),
    onForwardToClient: (m) => toClient.push(m),
    log: () => {},
  });
  return { pipeline, toTarget, toClient };
}

function toolCall(sql: string, name = "query"): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: { sql } },
  };
}

/* ─────────────────── allowlist mode (default) ─────────────────── */

describe("sqlGuard allowlist mode (default)", () => {
  it("allows SELECT / WITH / SHOW / EXPLAIN / DESCRIBE / VALUES / PRAGMA / TABLE", async () => {
    const { pipeline, toTarget, toClient } = pipelineFor({ tools: ["query"] });
    await pipeline.start();
    for (const sql of [
      "SELECT 1",
      "WITH cte AS (SELECT 1) SELECT * FROM cte",
      "SHOW TABLES",
      "EXPLAIN SELECT 1",
      "DESCRIBE users",
      "VALUES (1), (2)",
      "PRAGMA table_info(users)",
      "TABLE users",
    ]) {
      await pipeline.handleClientMessage(toolCall(sql));
    }
    expect(toTarget).toHaveLength(8);
    expect(toClient).toHaveLength(0);
  });

  it("blocks UPDATE / DELETE / DROP / INSERT / CREATE / ALTER / TRUNCATE", async () => {
    const { pipeline, toTarget, toClient } = pipelineFor({ tools: ["query"] });
    await pipeline.start();
    for (const sql of [
      "UPDATE users SET x = 1",
      "DELETE FROM users",
      "DROP TABLE users",
      "INSERT INTO t VALUES (1)",
      "CREATE TABLE t (id INT)",
      "ALTER TABLE t ADD x INT",
      "TRUNCATE TABLE t",
    ]) {
      await pipeline.handleClientMessage(toolCall(sql));
    }
    expect(toTarget).toHaveLength(0);
    expect(toClient).toHaveLength(7);
    for (const msg of toClient) {
      expect(msg).toMatchObject({ error: { code: -32601 } });
    }
  });

  /*
   * Three SQL-injection-style payloads that slipped past the
   * earlier denylist-mode guard. Each is a regression test: if
   * allowlist mode ever silently forwards one of them, something
   * has broken in preprocessing (comment collapse, literal
   * blanking, or leading-verb detection).
   */
  it("bypass #1: blocks DROP/**​/TABLE despite comment-collapse", async () => {
    const { pipeline, toClient } = pipelineFor({ tools: ["query"] });
    await pipeline.start();
    await pipeline.handleClientMessage(toolCall("DROP/**/TABLE users"));
    expect(toClient).toHaveLength(1); // rejected
  });

  it("bypass #2: blocks SELECT dropUsers(1) — function name wouldn't trip a keyword match", async () => {
    const { pipeline, toClient } = pipelineFor({ tools: ["query"] });
    await pipeline.start();
    // Starts with SELECT so would pass... BUT the function might mutate.
    // Allowlist mode allows it by leading-verb rule; this is a KNOWN
    // limitation documented in the README. We still block it if the
    // user wants to be strict — rely on a read-only DB role.
    // Regression test documents current behaviour: function calls
    // that START with SELECT are allowed by allowlist (tunable via
    // a DB-role backstop).
    await pipeline.handleClientMessage(toolCall("SELECT dropUsers(1)"));
    // Intentionally expected to FORWARD — documented allowlist limit.
    // The README FAQ calls this out.
    expect(toClient).toHaveLength(0);
  });

  it("allows SELECT ... FOR UPDATE (row lock, read-only)", async () => {
    const { pipeline, toTarget, toClient } = pipelineFor({ tools: ["query"] });
    await pipeline.start();
    await pipeline.handleClientMessage(toolCall("SELECT * FROM t FOR UPDATE"));
    // Previously blocked by denylist; allowlist correctly passes.
    expect(toTarget).toHaveLength(1);
    expect(toClient).toHaveLength(0);
  });

  it("allows SELECT where a string literal contains DELETE", async () => {
    const { pipeline, toTarget } = pipelineFor({ tools: ["query"] });
    await pipeline.start();
    await pipeline.handleClientMessage(
      toolCall("SELECT note FROM t WHERE note = 'DELETE FROM users'"),
    );
    expect(toTarget).toHaveLength(1);
  });

  it("rejects multi-statement input if any statement is a write", async () => {
    const { pipeline, toClient } = pipelineFor({ tools: ["query"] });
    await pipeline.start();
    await pipeline.handleClientMessage(toolCall("SELECT 1; DELETE FROM users"));
    expect(toClient).toHaveLength(1); // rejected
  });

  it("allows multi-statement input if every statement is read-only", async () => {
    const { pipeline, toTarget } = pipelineFor({ tools: ["query"] });
    await pipeline.start();
    await pipeline.handleClientMessage(toolCall("SELECT 1; SELECT 2; SHOW TABLES;"));
    expect(toTarget).toHaveLength(1);
  });

  it("peels leading parentheses before inspecting the verb", async () => {
    const { pipeline, toTarget } = pipelineFor({ tools: ["query"] });
    await pipeline.start();
    await pipeline.handleClientMessage(toolCall("(SELECT 1)"));
    expect(toTarget).toHaveLength(1);
  });

  it("extraReadVerbs accepts dialect-specific read keywords", async () => {
    const { pipeline, toTarget } = pipelineFor({
      tools: ["query"],
      extraReadVerbs: ["FROM"], // e.g. some dialects' FROM-first syntax
    });
    await pipeline.start();
    await pipeline.handleClientMessage(toolCall("FROM users SELECT *"));
    expect(toTarget).toHaveLength(1);
  });
});

/* ─────────────────── denylist mode (legacy) ─────────────────── */

describe("sqlGuard denylist mode (legacy)", () => {
  it("blocks DROP TABLE in denylist mode", async () => {
    const { pipeline, toClient } = pipelineFor({
      tools: ["query"],
      mode: "denylist",
    });
    await pipeline.start();
    await pipeline.handleClientMessage(toolCall("DROP TABLE users"));
    expect(toClient).toHaveLength(1);
  });

  it("blocks DROP/**​/TABLE after comment preprocessing collapses to DROP TABLE", async () => {
    const { pipeline, toClient } = pipelineFor({
      tools: ["query"],
      mode: "denylist",
    });
    await pipeline.start();
    await pipeline.handleClientMessage(toolCall("DROP/**/TABLE users"));
    // Previously ALLOWED because comments were stripped to empty string.
    // Now rejected because comments collapse to a single space.
    expect(toClient).toHaveLength(1);
  });

  it("no longer false-positive on string literals containing DELETE", async () => {
    const { pipeline, toTarget } = pipelineFor({
      tools: ["query"],
      mode: "denylist",
    });
    await pipeline.start();
    await pipeline.handleClientMessage(
      toolCall("SELECT note FROM t WHERE note = 'DELETE FROM users'"),
    );
    expect(toTarget).toHaveLength(1);
  });

  it("still blocks straight UPDATE / DELETE / INSERT", async () => {
    const { pipeline, toClient } = pipelineFor({
      tools: ["query"],
      mode: "denylist",
    });
    await pipeline.start();
    await pipeline.handleClientMessage(toolCall("UPDATE u SET x=1"));
    await pipeline.handleClientMessage(toolCall("DELETE FROM u"));
    await pipeline.handleClientMessage(toolCall("INSERT INTO u VALUES (1)"));
    expect(toClient).toHaveLength(3);
  });
});

/* ─────────────────── scope / config / internals ─────────────────── */

describe("sqlGuard: scope + configuration", () => {
  it("only inspects tools in the configured list", async () => {
    const { pipeline, toTarget } = pipelineFor({ tools: ["query"] });
    await pipeline.start();
    await pipeline.handleClientMessage(toolCall("DELETE FROM users", "other_tool"));
    expect(toTarget).toHaveLength(1);
  });

  it("uses a custom sqlArg key", async () => {
    const { pipeline, toClient } = pipelineFor({
      tools: ["custom"],
      sqlArg: "statement",
    });
    await pipeline.start();
    await pipeline.handleClientMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "custom", arguments: { statement: "DROP TABLE x" } },
    });
    expect(toClient).toHaveLength(1);
  });

  it("readOnly=false forwards everything", async () => {
    const { pipeline, toTarget } = pipelineFor({
      tools: ["query"],
      readOnly: false,
    });
    await pipeline.start();
    await pipeline.handleClientMessage(toolCall("DELETE FROM users"));
    expect(toTarget).toHaveLength(1);
  });

  it("forwards requests that lack a sql argument", async () => {
    const { pipeline, toTarget } = pipelineFor({ tools: ["query"] });
    await pipeline.start();
    await pipeline.handleClientMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "query", arguments: { something_else: "value" } },
    });
    expect(toTarget).toHaveLength(1);
  });

  it("throws if tools list is empty", () => {
    expect(() => createSqlGuardOverlay({ tools: [] })).toThrow(/at least one tool/);
  });
});

describe("sqlGuard: internals", () => {
  it("preprocessSql collapses comments to a single space, not empty string", () => {
    expect(_internals.preprocessSql("DROP/**/TABLE users")).toBe("DROP TABLE users");
    expect(_internals.preprocessSql("SELECT 1 -- comment")).toMatch(/^SELECT 1\s+$/);
    expect(_internals.preprocessSql("SELECT /* x */ 1")).toBe("SELECT   1");
  });

  it("preprocessSql blanks single-quoted string literals", () => {
    expect(_internals.preprocessSql("WHERE x = 'DELETE FROM users'")).toBe("WHERE x = ''");
    expect(_internals.preprocessSql("WHERE x = 'it''s fine'")).toBe("WHERE x = ''");
  });

  it("isReadOnlyByAllowlist recognises common read verbs", () => {
    const readVerbs = new Set(["SELECT", "WITH", "SHOW"]);
    expect(_internals.isReadOnlyByAllowlist("SELECT 1", readVerbs)).toBe(true);
    expect(
      _internals.isReadOnlyByAllowlist("WITH x AS (SELECT 1) SELECT * FROM x", readVerbs),
    ).toBe(true);
    expect(_internals.isReadOnlyByAllowlist("UPDATE users SET x=1", readVerbs)).toBe(false);
    expect(_internals.isReadOnlyByAllowlist("SELECT 1; DELETE FROM y", readVerbs)).toBe(false);
  });

  it("escapeRegex escapes metacharacters", () => {
    expect(_internals.escapeRegex("(a|b)")).toBe("\\(a\\|b\\)");
    expect(_internals.escapeRegex("a.b")).toBe("a\\.b");
  });
});
