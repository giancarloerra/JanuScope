// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * Regression tests for the lens transparency rule:
 *   1. The user's MCP-client env passes through JanuScope to the
 *      spawned target without modification.
 *   2. No bundled lens declares `target.env` substitutions that would
 *      OVERRIDE inherited env vars (the postgres `DATABASE_URI:
 *      "${DATABASE_URL}"` rename, or any same-name pass-through).
 *   3. `target.env` is reserved for LENS POLICY VALUES — hardcoded
 *      constants the lens decides for the user (e.g. ALLOW_*=false on
 *      the MySQL lens, CLICKHOUSE_SECURE=true on the ClickHouse lens).
 *
 * The test parses every bundled lens's config.yaml and asserts the rule.
 * If a future PR re-introduces a rename or same-name pass-through, this
 * test fails and points the contributor at lenses/CONTRIBUTING.md.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { load as loadYaml } from "js-yaml";

const LENSES_ROOT = resolve(__dirname, "..", "lenses");

/**
 * Discover lens categories dynamically by reading subdirectories of
 * `lenses/`. The registry's `LENS_CATEGORIES` constant in `src/lenses.ts`
 * is the engine's allowlist; this test just walks every shipped category
 * directory regardless of registry membership. If a future PR adds a
 * category (e.g. `observability`), the transparency rule covers it
 * automatically with no test edit. Filenames starting with `_` (such as
 * `_template`) are skipped.
 *
 * We deliberately do NOT import from `src/lenses.js` here: the import
 * graph is heavy (zod schemas, the full overlay config) and pulling it
 * into the test loader noticeably slows the unrelated subprocess-based
 * CLI tests in this repo (each tsx subprocess inherits the slower
 * import chain). Reading the filesystem is one syscall and covers the
 * "automatic coverage on new categories" goal just as well.
 */
function discoverCategories(): string[] {
  return readdirSync(LENSES_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

interface LensTargetEnv {
  [key: string]: string;
}

interface LensConfig {
  target?: {
    command?: string;
    args?: string[];
    env?: LensTargetEnv;
  };
}

function loadAllBundledLenses(): Array<{ name: string; config: LensConfig }> {
  const out: Array<{ name: string; config: LensConfig }> = [];
  for (const cat of discoverCategories()) {
    const catDir = join(LENSES_ROOT, cat);
    // After dynamic discovery `readdirSync(catDir)` should always succeed
    // for the categories we found. A subsequent failure (race-deletion of
    // a directory between two reads) is rare and worth surfacing rather
    // than swallowing.
    const entries = readdirSync(catDir);
    for (const entry of entries) {
      const lensDir = join(catDir, entry);
      if (entry === "_template") continue;
      try {
        if (!statSync(lensDir).isDirectory()) continue;
      } catch (err) {
        // stat failure on a discovered entry is unusual and might hide a
        // real filesystem-permissions or symlink issue. Surface it
        // (preserve the original error via `cause` so the chain is intact).
        throw new Error(`Failed to stat ${lensDir} while loading lenses`, { cause: err });
      }
      const cfgPath = join(lensDir, "config.yaml");
      // Fail fast on read failure: a lens directory exists but its
      // config.yaml is unreadable (truncated, permission-denied, missing).
      // Silent skip would produce a false-green on policy validation
      // because the broken lens would simply not be checked.
      let raw: string;
      try {
        raw = readFileSync(cfgPath, "utf8");
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to read lens config at ${cfgPath} (lens ${cat}/${entry}): ${reason}. ` +
            `If this lens directory is intentionally not yet shipped, remove the folder; ` +
            `otherwise restore config.yaml so the transparency rule can validate it.`,
          { cause: err },
        );
      }
      // Wrap YAML parse errors so the failure message names the lens.
      // Without this, a malformed config.yaml would surface as a raw
      // js-yaml parser error with line / column but no lens identity,
      // sending a contributor on a goose chase to find the offender.
      let parsed: LensConfig;
      try {
        parsed = loadYaml(raw) as LensConfig;
      } catch (err) {
        throw new Error(`Failed to parse lens config at ${cfgPath} (lens ${cat}/${entry})`, {
          cause: err,
        });
      }
      out.push({ name: `${cat}/${entry}`, config: parsed });
    }
  }
  return out;
}

/**
 * Identify env-block entries that look like operator-supplied
 * connection details rather than lens-policy hardcodes.
 *
 * The rule: any value containing a `${VAR}` substitution is, by
 * definition, NOT a hardcode — it's pulling from operator-set env.
 * Such entries either:
 *   - rename (`X: "${Y}"` with X != Y) — disallowed
 *   - same-name pass-through (`X: "${X}"`) — disallowed (redundant
 *     and clobbers the inherited value when the source isn't set)
 *
 * Hardcoded constants like `ALLOW_INSERT_OPERATION: "false"` are
 * fine — they're the lens's policy contribution.
 *
 * Detection covers three shapes:
 *   1. Exact `${VAR}` substitution (the simple rename / pass-through case).
 *   2. Composed `prefix-${VAR}-suffix` interpolation (the sneaky rename case
 *      that earlier versions of this test missed; e.g. a regression like
 *      `target.env: { DATABASE_URI: "postgres://${DATABASE_URL}/db" }` would
 *      slip through if we only matched whole-string substitutions).
 *   3. Multiple `${A}` and `${B}` substitutions in the same value.
 *
 * Plain shell-style `$VAR` (no braces) is not actually supported by
 * JanuScope's substitution engine — values without braces pass through as
 * literal strings — but we flag them too so future contributors don't get
 * a false positive from "this looks like substitution but isn't" code.
 */
function findOperatorEnvEntries(env: LensTargetEnv): Array<{
  key: string;
  value: string;
  kind: "rename" | "same-name";
}> {
  const flagged: Array<{ key: string; value: string; kind: "rename" | "same-name" }> = [];
  // Match either ${VAR} (engine-supported) or $VAR (forward-compat).
  const substitutionRe = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    const matches = [...value.matchAll(substitutionRe)];
    if (matches.length === 0) continue; // no substitutions → hardcoded constant
    const sourceNames = matches.map((m) => m[1] ?? m[2]).filter((n): n is string => Boolean(n));
    // "same-name" only if the WHOLE value is a single ${KEY} substitution.
    // Composed strings like `${A}-suffix` or `${A}/${B}` are renames,
    // even if A === key — the literal portion makes it a rewrite.
    const wholeValueIsExactRef =
      matches.length === 1 &&
      matches[0]![0] === value &&
      sourceNames.length === 1 &&
      sourceNames[0] === key;
    flagged.push({
      key,
      value,
      kind: wholeValueIsExactRef ? "same-name" : "rename",
    });
  }
  return flagged;
}

describe("lens transparency: target.env contains only policy hardcodes", () => {
  const lenses = loadAllBundledLenses();

  it("at least one lens loaded (sanity check)", () => {
    expect(lenses.length).toBeGreaterThanOrEqual(6);
  });

  for (const { name, config } of lenses) {
    it(`${name}: target.env has no env-var renames or same-name pass-through`, () => {
      const env = config.target?.env;
      if (!env || Object.keys(env).length === 0) {
        // No env block at all (or empty). Most transparent shape.
        expect(true).toBe(true);
        return;
      }
      const flagged = findOperatorEnvEntries(env);
      if (flagged.length > 0) {
        const lines = flagged.map(
          (f) =>
            `  - ${f.key}: ${JSON.stringify(f.value)}  [${f.kind}]\n` +
            `      Fix: remove this from target.env. The user supplies ${f.kind === "rename" ? "the upstream var" : f.key} directly via their MCP-client config; JanuScope inherits it.`,
        );
        throw new Error(
          `Lens ${name} violates the transparency rule.\n` +
            `target.env entries that reference operator env vars:\n` +
            lines.join("\n") +
            `\nSee lenses/CONTRIBUTING.md → "Lens transparency rule".`,
        );
      }
    });
  }
});

describe("lens transparency: known policy hardcodes ARE preserved", () => {
  const lenses = loadAllBundledLenses();

  function find(name: string): LensConfig {
    const lens = lenses.find((l) => l.name === name);
    if (!lens) throw new Error(`Test fixture missing: ${name}`);
    return lens.config;
  }

  it("mysql-benborla29 keeps ALLOW_*_OPERATION=false hardcodes", () => {
    const env = find("databases/mysql-benborla29").target?.env ?? {};
    expect(env.ALLOW_INSERT_OPERATION).toBe("false");
    expect(env.ALLOW_UPDATE_OPERATION).toBe("false");
    expect(env.ALLOW_DELETE_OPERATION).toBe("false");
    expect(env.ALLOW_DDL_OPERATION).toBe("false");
  });

  it("clickhouse-official keeps CLICKHOUSE_SECURE=true hardcode", () => {
    const env = find("databases/clickhouse-official").target?.env ?? {};
    expect(env.CLICKHOUSE_SECURE).toBe("true");
  });
});

/*
 * Pin the detector itself: the previous version of this test only matched
 * exact `${VAR}` substitutions and missed composed-string renames. These
 * unit tests prove the detector now catches both the obvious and the sneaky
 * shapes; if a future refactor narrows the detection back, the regression
 * lands here, not on a real lens at production time.
 */
describe("findOperatorEnvEntries: detector coverage", () => {
  it("flags exact ${VAR} substitution as same-name when key matches", () => {
    const flagged = findOperatorEnvEntries({ FOO: "${FOO}" });
    expect(flagged).toEqual([{ key: "FOO", value: "${FOO}", kind: "same-name" }]);
  });

  it("flags exact ${VAR} substitution as rename when key differs", () => {
    const flagged = findOperatorEnvEntries({ DATABASE_URI: "${DATABASE_URL}" });
    expect(flagged).toEqual([{ key: "DATABASE_URI", value: "${DATABASE_URL}", kind: "rename" }]);
  });

  it("flags composed strings as rename even when source name matches the key", () => {
    // The literal portions (`postgres://`, `:5432/db`) make this a rewrite,
    // not a transparent pass-through.
    const flagged = findOperatorEnvEntries({
      DATABASE_URI: "postgres://${DATABASE_URI}:5432/db",
    });
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.kind).toBe("rename");
  });

  it("flags composed strings with unrelated source names as rename", () => {
    const flagged = findOperatorEnvEntries({
      MYSQL_URL: "mysql://${MYSQL_USER}:${MYSQL_PASS}@${MYSQL_HOST}/${MYSQL_DB}",
    });
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.kind).toBe("rename");
  });

  it("flags brace-less $VAR substitutions (forward-compat catch)", () => {
    // Bare `$VAR` is not actually supported by JanuScope's substitution
    // engine, but a contributor writing it has the same forbidden intent
    // as `${VAR}` and we want CI to catch it. Classification follows the
    // same logic as braces: source name matches key → "same-name".
    const sameName = findOperatorEnvEntries({ FOO: "$FOO" });
    expect(sameName).toHaveLength(1);
    expect(sameName[0]!.kind).toBe("same-name");
    // And the rename variant.
    const rename = findOperatorEnvEntries({ MY_VAR: "$OTHER_VAR" });
    expect(rename).toHaveLength(1);
    expect(rename[0]!.kind).toBe("rename");
  });

  it("does not flag hardcoded constant values (the policy case)", () => {
    expect(findOperatorEnvEntries({ ALLOW_INSERT_OPERATION: "false" })).toEqual([]);
    expect(findOperatorEnvEntries({ CLICKHOUSE_SECURE: "true" })).toEqual([]);
    expect(findOperatorEnvEntries({ MAX_CONNECTIONS: "10" })).toEqual([]);
  });

  it("does not flag empty env blocks", () => {
    expect(findOperatorEnvEntries({})).toEqual([]);
  });
});
