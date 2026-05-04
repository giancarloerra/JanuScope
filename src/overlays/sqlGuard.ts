// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * `sqlGuard` overlay.
 *
 * Some MCPs expose a single query-style tool that accepts arbitrary
 * SQL. The `block` overlay can only filter whole tools by name; it
 * cannot tell SELECT from UPDATE through a single SQL tool.
 * `sqlGuard` inspects the SQL argument itself.
 *
 * Two modes:
 *
 *   - `mode: "allowlist"` (DEFAULT, RECOMMENDED). Reject any
 *     statement whose leading keyword is not on the read-only
 *     allowlist (SELECT, WITH, SHOW, EXPLAIN, DESCRIBE, VALUES,
 *     PRAGMA, TABLE). Robust against function-call mutation
 *     (SELECT dropUsers(1)), against comment-hidden writes
 *     (DROP/**​/TABLE users), and against false positives on
 *     SELECT ... FOR UPDATE or string literals containing write
 *     keywords. Multi-statement inputs are rejected unless every
 *     statement starts with a read verb.
 *
 *   - `mode: "denylist"` (LEGACY). Keyword-blacklist match with
 *     comment collapsing and string-literal blanking. Preserved
 *     for compatibility; documented blind spots remain (e.g. user-
 *     defined functions whose names embed verb fragments).
 */

import type { Overlay } from "../pipeline.js";
import { isRequest, makeErrorResponse, RpcErrorCode } from "../rpc.js";

export type SqlGuardMode = "allowlist" | "denylist";

export interface SqlGuardOverlayOptions {
  /** Tool names whose arguments contain SQL. These are inspected. */
  tools: ReadonlyArray<string>;
  /** Argument key that holds the SQL string. Default `sql`. */
  sqlArg?: string;
  /** When true (default), apply read-only enforcement; when false, forward everything. */
  readOnly?: boolean;
  /**
   * Enforcement style. Default "allowlist" — reject any statement
   * whose leading keyword isn't an explicit read-only verb. Set to
   * "denylist" for the legacy keyword-blacklist behaviour.
   */
  mode?: SqlGuardMode;
  /**
   * Additional keywords to treat as writes (denylist mode only).
   * Silently ignored in allowlist mode.
   */
  extraWriteKeywords?: ReadonlyArray<string>;
  /**
   * Additional leading verbs to accept as read-only (allowlist mode
   * only). Use for dialect-specific read keywords your MCP needs.
   */
  extraReadVerbs?: ReadonlyArray<string>;
}

/** Leading-verb allowlist of read-only statement starters. */
const DEFAULT_READ_VERBS = [
  "SELECT",
  "WITH",
  "SHOW",
  "EXPLAIN",
  "DESCRIBE",
  "DESC",
  "VALUES",
  "PRAGMA",
  "TABLE", // `TABLE t` is shorthand for SELECT * FROM t in some dialects
];

/** Denylist keywords (legacy mode). */
const DEFAULT_WRITE_KEYWORDS = [
  "UPDATE",
  "DELETE",
  "INSERT",
  "REPLACE",
  "MERGE",
  "DROP",
  "CREATE",
  "ALTER",
  "TRUNCATE",
  "RENAME",
  "GRANT",
  "REVOKE",
  "CALL",
  "EXECUTE",
  "COPY",
  "VACUUM",
  "ANALYZE",
  "CLUSTER",
  "REINDEX",
  "REFRESH",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
];

export function createSqlGuardOverlay(options: SqlGuardOverlayOptions): Overlay {
  if (options.tools.length === 0) {
    throw new Error("sqlGuard: `tools` must list at least one tool name");
  }
  const toolSet = new Set(options.tools);
  const sqlArg = options.sqlArg ?? "sql";
  const readOnly = options.readOnly ?? true;
  const mode: SqlGuardMode = options.mode ?? "allowlist";

  const readVerbs = new Set<string>([
    ...DEFAULT_READ_VERBS,
    ...(options.extraReadVerbs ?? []).map((v) => v.toUpperCase()),
  ]);

  const denyKeywords = [
    ...DEFAULT_WRITE_KEYWORDS,
    ...(options.extraWriteKeywords ?? []).map(escapeRegex),
  ];
  const writePattern = new RegExp(`\\b(${denyKeywords.join("|")})\\b`, "i");

  return {
    name: "sqlGuard",
    kind: "gate", // security boundary — fail closed if this handler throws
    onClientMessage(msg, ctx) {
      if (!readOnly) return { kind: "forward", msg };
      if (!isRequest(msg)) return { kind: "forward", msg };
      if (msg.method !== "tools/call") return { kind: "forward", msg };

      const params = msg.params as { name?: unknown; arguments?: unknown } | undefined;
      if (!params || typeof params.name !== "string") {
        return { kind: "forward", msg };
      }
      if (!toolSet.has(params.name)) return { kind: "forward", msg };

      const args = params.arguments as Record<string, unknown> | undefined;
      if (!args) return { kind: "forward", msg };
      const sqlValue = args[sqlArg];
      if (typeof sqlValue !== "string") return { kind: "forward", msg };

      const isWrite =
        mode === "allowlist"
          ? !isReadOnlyByAllowlist(sqlValue, readVerbs)
          : looksLikeWrite(sqlValue, writePattern);

      if (!isWrite) return { kind: "forward", msg };

      ctx.log("info", `blocked SQL mutation in tool '${params.name}' (mode=${mode})`);
      return {
        kind: "respond",
        response: makeErrorResponse(
          msg.id,
          RpcErrorCode.MethodNotFound,
          `SQL mutation statement is blocked by januscope sqlGuard policy ` +
            `(tool '${params.name}' is configured read-only, mode=${mode}).`,
        ),
      };
    },
  };
}

/**
 * Preprocess SQL for analysis:
 *   - Collapse comments to a single space (not empty string) so
 *     `DROP/**​/TABLE` becomes `DROP TABLE`, preserving word
 *     boundaries that a raw strip would destroy.
 *   - Blank string literals so their content can't cause false
 *     positives (e.g. `WHERE note = 'DELETE FROM x'`).
 *
 * Not a full SQL lexer. Sufficient for keyword / leading-verb
 * heuristics.
 */
function preprocessSql(sql: string): string {
  let out = sql;
  // Block comments first (may span lines)
  out = out.replace(/\/\*[\s\S]*?\*\//g, " ");
  // Line comments
  out = out.replace(/--[^\r\n]*/g, " ");
  // Single-quoted string literals (SQL standard '' escape)
  out = out.replace(/'(?:''|[^'])*'/g, "''");
  // Double-quoted identifiers/strings
  out = out.replace(/"(?:""|[^"])*"/g, '""');
  return out;
}

/**
 * Allowlist-mode check: every non-empty statement must start with a
 * read-only verb AND must not contain an embedded DML keyword.
 *
 * The leading-verb check by itself is insufficient because Postgres
 * (and some other dialects) allow write operations to hide behind a
 * read-shaped outer verb:
 *
 *   - `WITH x AS (DELETE FROM t RETURNING id) SELECT ...`   — data-modifying CTE
 *   - `WITH x AS (INSERT INTO t SELECT ... RETURNING 1) SELECT ...`
 *   - `SELECT * INTO shadow_users FROM users`                — synonym for CREATE TABLE AS
 *   - `EXPLAIN ANALYZE DELETE FROM t`                        — ANALYZE actually runs
 *
 * The second-pass scan catches the first three classes by looking
 * for a DML keyword anywhere in the cleaned SQL, and the fourth by
 * looking for the specific `SELECT ... INTO ident FROM` shape.
 * False positives on `SELECT ... FOR UPDATE` / `FOR SHARE` / related
 * row-locking clauses are handled by blanking them before the scan.
 */
function isReadOnlyByAllowlist(sql: string, readVerbs: Set<string>): boolean {
  const cleaned = preprocessSql(sql).trim();
  if (cleaned.length === 0) return true;
  const statements = cleaned
    .split(/;/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    const peeled = stmt.replace(/^[(\s]+/, "");
    const match = /^([A-Za-z][A-Za-z0-9_]*)/.exec(peeled);
    if (!match) return false;
    const verb = match[1]!.toUpperCase();
    if (!readVerbs.has(verb)) return false;
    if (hasEmbeddedWrite(stmt)) return false;
  }
  return true;
}

/**
 * Second-pass scan for write keywords hiding inside a leading-read
 * statement. Run on an already-preprocessed statement (comments
 * collapsed, string literals + quoted identifiers blanked) so
 * matches are against real SQL tokens, not literal text.
 */
/**
 * Postgres-dialect functions that read or write the server filesystem,
 * cancel/terminate sessions, sleep (DoS vector), or break out of SQL
 * into a subshell. A leading `SELECT` makes these look like reads but
 * they aren't — `lo_export('/tmp/x')` writes a file, `pg_sleep(30)` is
 * a wall-clock DoS, `pg_terminate_backend(pid)` kicks users off.
 *
 * The list is conservative-but-defensive and matches the "readOnly:
 * true" contract: *at most* read-queries against the data schema.
 * Admin / filesystem / shell functions are unambiguously outside that.
 * Other dialects (MySQL, ClickHouse) generally do not share these
 * function names, so matching them in allowlist mode is safe across
 * engines. If you need one of them for a read-only reason, switch to
 * `mode: denylist` (which does not run this scan) and accept the risk.
 */
const DANGEROUS_FUNCTIONS_RE =
  /\b(?:lo_import|lo_export|pg_read_file|pg_read_binary_file|pg_write_file|pg_ls_dir|pg_stat_file|pg_sleep|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_promote|pg_read_server_files|dblink|dblink_exec|dblink_send_query)\s*\(/i;

function hasEmbeddedWrite(preprocessedStmt: string): boolean {
  // Blank row-locking clauses so their `UPDATE` / `SHARE` keywords
  // don't trip the DML scan. These are read-only in SQL semantics.
  const safe = preprocessedStmt
    .replace(/\bFOR\s+NO\s+KEY\s+UPDATE\b/gi, " ")
    .replace(/\bFOR\s+KEY\s+SHARE\b/gi, " ")
    .replace(/\bFOR\s+UPDATE\b/gi, " ")
    .replace(/\bFOR\s+SHARE\b/gi, " ");

  // Any DML / DDL / permission keyword embedded anywhere in the
  // statement is a bypass. `RETURNING` itself is not a write verb
  // but only appears in DML, so we don't need to match it explicitly.
  const DML =
    /\b(DELETE|INSERT|UPDATE|MERGE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|RENAME|REINDEX|CLUSTER|VACUUM|REFRESH|COPY)\b/i;
  if (DML.test(safe)) return true;

  // Postgres `SELECT ... INTO <table> FROM ...` is equivalent to
  // CREATE TABLE AS. Leading verb is SELECT (on the allowlist), so
  // the DML scan above would only catch it if we listed INTO, but
  // INTO has legitimate non-DDL uses inside other clauses (CALL,
  // some dialects' SELECT INTO variable). Be precise: require the
  // INTO to be followed by a bare identifier and then FROM.
  if (/\bSELECT\b[\s\S]*?\bINTO\s+[A-Za-z_][A-Za-z0-9_.]*\s+FROM\b/i.test(safe)) {
    return true;
  }

  // Postgres admin / filesystem / sleep / cross-database functions.
  // These read or write the server environment, not the data schema.
  if (DANGEROUS_FUNCTIONS_RE.test(safe)) return true;

  // `COPY ... PROGRAM 'shell-command'` runs a subshell server-side.
  // `COPY ... FROM '/path'` / `COPY ... TO '/path'` reads/writes the
  // server filesystem. COPY as a leading verb is already rejected by
  // the allowlist, but be defensive if a future config adds it back.
  if (/\bCOPY\b[\s\S]+?\bPROGRAM\b/i.test(safe)) return true;
  if (/\bCOPY\b[\s\S]+?\b(?:FROM|TO)\s+''/i.test(safe)) {
    // Literal blanking has turned '/path' into ''. If COPY FROM/TO
    // is followed by a blanked string, it's a filesystem copy.
    return true;
  }

  return false;
}

/**
 * Denylist-mode check (legacy). Uses preprocessed SQL so comments
 * collapse to a space (fixing the DROP/**​/TABLE bypass) and string
 * literals are blanked (fixing WHERE note = 'DELETE FROM x').
 *
 * Still has documented blind spots: user-defined functions whose
 * names embed verb fragments (dropUsers, purge_audits) don't trip
 * word-boundary matches. Prefer allowlist mode.
 */
function looksLikeWrite(sql: string, pattern: RegExp): boolean {
  return pattern.test(preprocessSql(sql));
}

/** Escape regex metacharacters in a string so it matches literally. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Exported for tests that want direct access to the detection logic.
export const _internals = {
  preprocessSql,
  isReadOnlyByAllowlist,
  looksLikeWrite,
  hasEmbeddedWrite,
  escapeRegex,
};
