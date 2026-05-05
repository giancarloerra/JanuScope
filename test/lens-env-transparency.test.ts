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
const CATEGORIES = ["databases", "dev-tools", "saas", "infra", "other"];

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
  for (const cat of CATEGORIES) {
    const catDir = join(LENSES_ROOT, cat);
    let entries: string[];
    try {
      entries = readdirSync(catDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const lensDir = join(catDir, entry);
      if (entry === "_template") continue;
      try {
        if (!statSync(lensDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const cfgPath = join(lensDir, "config.yaml");
      let raw: string;
      try {
        raw = readFileSync(cfgPath, "utf8");
      } catch {
        continue;
      }
      const parsed = loadYaml(raw) as LensConfig;
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
 */
function findOperatorEnvEntries(env: LensTargetEnv): Array<{
  key: string;
  value: string;
  kind: "rename" | "same-name";
}> {
  const flagged: Array<{ key: string; value: string; kind: "rename" | "same-name" }> = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    const match = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
    if (!match) continue; // not a substitution → it's a hardcode constant
    const sourceName = match[1]!;
    flagged.push({
      key,
      value,
      kind: sourceName === key ? "same-name" : "rename",
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
