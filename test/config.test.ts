import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, substituteEnv, validateConfig } from "../src/config.js";

describe("config: validateConfig", () => {
  it("accepts a minimal valid config", () => {
    const config = validateConfig({
      target: { command: "node", args: ["server.js"] },
    });
    expect(config.target.command).toBe("node");
  });

  it("rejects missing target", () => {
    expect(() => validateConfig({})).toThrow(/target/);
  });

  it("rejects empty target command", () => {
    expect(() => validateConfig({ target: { command: "" } })).toThrow(/target\.command/);
  });

  it("accepts all optional overlays", () => {
    const config = validateConfig({
      target: { command: "node" },
      block: ["execute", "admin_*"],
      instructions: "READ-ONLY",
      audit: { sink: "stderr" },
      dbSchema: {
        connectionString: "postgresql://x",
        tables: ["orders"],
      },
      redact: {
        rules: [{ regex: "\\d+" }, { field: "customers.email" }],
      },
    });
    expect(config.block).toEqual(["execute", "admin_*"]);
    expect(config.audit?.logRawArgs).toBe(false);
    expect(config.dbSchema?.format).toBe("markdown");
    expect(config.redact?.replacement).toBe("[REDACTED]");
  });

  it("rejects dbSchema with both tables and excludeTables", () => {
    expect(() =>
      validateConfig({
        target: { command: "node" },
        dbSchema: {
          connectionString: "sqlite:/tmp/x.db",
          tables: ["a"],
          excludeTables: ["b"],
        },
      }),
    ).toThrow(/mutually exclusive/);
  });

  it("rejects empty redact rules", () => {
    expect(() =>
      validateConfig({
        target: { command: "node" },
        redact: { rules: [] },
      }),
    ).toThrow();
  });

  it("rejects a redact rule with both regex and field", () => {
    expect(() =>
      validateConfig({
        target: { command: "node" },
        redact: { rules: [{ regex: "\\d+", field: "email" }] },
      }),
    ).toThrow();
  });

  it("rejects a redact rule with neither regex nor field", () => {
    expect(() =>
      validateConfig({
        target: { command: "node" },
        redact: { rules: [{}] },
      }),
    ).toThrow();
  });

  it("accepts well-formed redact rules", () => {
    const cfg = validateConfig({
      target: { command: "node" },
      redact: { rules: [{ regex: "\\d+" }, { field: "**.email" }] },
    });
    expect(cfg.redact?.rules).toEqual([{ regex: "\\d+" }, { field: "**.email" }]);
  });

  it("accepts rateLimit rules with either perMinute or per_minute", () => {
    const cfg = validateConfig({
      target: { command: "node" },
      rateLimit: [
        { tool: "query", perMinute: 60 },
        { tool: "heavy_*", per_minute: 5 },
      ],
    });
    expect(cfg.rateLimit).toEqual([
      { tool: "query", perMinute: 60 },
      { tool: "heavy_*", perMinute: 5 },
    ]);
  });

  it("rejects a rateLimit rule missing both perMinute and per_minute", () => {
    expect(() =>
      validateConfig({
        target: { command: "node" },
        rateLimit: [{ tool: "query" }],
      }),
    ).toThrow(/perMinute/);
  });

  it("rejects a rateLimit rule with non-positive perMinute", () => {
    expect(() =>
      validateConfig({
        target: { command: "node" },
        rateLimit: [{ tool: "query", perMinute: 0 }],
      }),
    ).toThrow();
  });

  it("rejects a rateLimit rule that sets BOTH perMinute and per_minute", () => {
    // An almost-certain copy-paste mistake during snake_case migration;
    // silently picking one would mask the typo.
    expect(() =>
      validateConfig({
        target: { command: "node" },
        rateLimit: [{ tool: "query", perMinute: 60, per_minute: 5 }],
      }),
    ).toThrow(/pick exactly one/);
  });

  it("accepts the three classification values", () => {
    for (const value of ["public", "internal", "sensitive"] as const) {
      const cfg = validateConfig({ target: { command: "node" }, classification: value });
      expect(cfg.classification).toBe(value);
    }
  });

  it("defaults classification to undefined when omitted", () => {
    const cfg = validateConfig({ target: { command: "node" } });
    expect(cfg.classification).toBeUndefined();
  });

  it("rejects an unknown classification value", () => {
    expect(() =>
      validateConfig({ target: { command: "node" }, classification: "top-secret" }),
    ).toThrow();
  });

  it("accepts a well-formed telemetry.otel block", () => {
    const cfg = validateConfig({
      target: { command: "node" },
      telemetry: {
        otel: {
          endpoint: "http://otel-collector:4318/v1/traces",
          serviceName: "my-janu",
          headers: { Authorization: "Bearer x" },
        },
      },
    });
    expect(cfg.telemetry?.otel?.endpoint).toBe("http://otel-collector:4318/v1/traces");
    expect(cfg.telemetry?.otel?.serviceName).toBe("my-janu");
  });

  it("rejects a telemetry.otel block without an endpoint", () => {
    expect(() => validateConfig({ target: { command: "node" }, telemetry: { otel: {} } })).toThrow(
      /endpoint/,
    );
  });

  it("rejects a telemetry.otel block with a non-URL endpoint", () => {
    expect(() =>
      validateConfig({
        target: { command: "node" },
        telemetry: { otel: { endpoint: "not a url" } },
      }),
    ).toThrow();
  });

  it("accepts firstRun: approve", () => {
    const cfg = validateConfig({ target: { command: "node" }, firstRun: "approve" });
    expect(cfg.firstRun).toBe("approve");
  });

  it("rejects an unknown firstRun mode", () => {
    expect(() => validateConfig({ target: { command: "node" }, firstRun: "skip" })).toThrow();
  });

  it("rejects unresolved secret refs — caller must use loadConfigAsync", () => {
    // Direct validateConfig() callers who skip the async loader would
    // otherwise start the pipeline with literal ${vault://...} values.
    expect(() =>
      validateConfig({
        target: {
          command: "npx",
          args: ["-y", "some-mcp"],
          env: { DB_URL: "${vault://kv/prod/db#url}" },
        },
      }),
    ).toThrow(/unresolved secret reference/);
  });
});

describe("config: substituteEnv", () => {
  const env = { FOO: "bar", EMPTY: "", DATABASE_URL: "postgres://x" };

  it("replaces ${VAR}", () => {
    expect(substituteEnv("${FOO}", env)).toBe("bar");
  });

  it("replaces $VAR", () => {
    expect(substituteEnv("$FOO", env)).toBe("bar");
  });

  it("returns empty for missing vars", () => {
    expect(substituteEnv("${MISSING}", env)).toBe("");
  });

  it("supports multiple substitutions in one string", () => {
    expect(substituteEnv("pre-${FOO}-mid-$FOO-end", env)).toBe("pre-bar-mid-bar-end");
  });

  it("recurses into arrays and objects", () => {
    const result = substituteEnv(
      {
        a: "${FOO}",
        b: [1, "$FOO", { c: "${DATABASE_URL}" }],
      },
      env,
    );
    expect(result).toEqual({
      a: "bar",
      b: [1, "bar", { c: "postgres://x" }],
    });
  });

  it("leaves non-strings untouched", () => {
    expect(substituteEnv(42, env)).toBe(42);
    expect(substituteEnv(true, env)).toBe(true);
    expect(substituteEnv(null, env)).toBe(null);
  });

  it("calls onMissing for every occurrence of an unset var (dedup is the warner's job)", () => {
    const seen: string[] = [];
    const result = substituteEnv(
      {
        a: "${MISSING_1}",
        b: "${MISSING_1}/$MISSING_2",
        c: "${FOO}",
      },
      env,
      { onMissing: (name) => seen.push(name) },
    );
    // MISSING_1 appears twice in the payload and the seen list reflects
    // every occurrence — substituteEnv intentionally fires the callback
    // per-reference; the caller dedups (loadConfig's stderr warner does).
    expect(seen).toEqual(["MISSING_1", "MISSING_1", "MISSING_2"]);
    expect(result).toEqual({ a: "", b: "/", c: "bar" });
  });
});

describe("config: loadConfig", () => {
  it("parses YAML and substitutes env vars", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpo-config-"));
    const path = join(dir, "cfg.yaml");
    writeFileSync(
      path,
      `target:\n  command: node\n  args:\n    - $SCRIPT_PATH\naudit:\n  sink: $AUDIT_SINK\n`,
    );
    const cfg = loadConfig(path, {
      SCRIPT_PATH: "/tmp/server.js",
      AUDIT_SINK: "/tmp/audit.jsonl",
    });
    expect(cfg.target.args).toEqual(["/tmp/server.js"]);
    expect(cfg.audit?.sink).toBe("/tmp/audit.jsonl");
  });

  it("parses JSON transparently (YAML is a superset)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpo-config-"));
    const path = join(dir, "cfg.json");
    writeFileSync(path, JSON.stringify({ target: { command: "node" }, block: ["execute"] }));
    const cfg = loadConfig(path, {});
    expect(cfg.block).toEqual(["execute"]);
  });

  it("reports a readable error for invalid config", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpo-config-"));
    const path = join(dir, "bad.yaml");
    writeFileSync(path, `target:\n  command:\n`);
    expect(() => loadConfig(path, {})).toThrow(/invalid januscope config/);
  });

  // contextInjection.textFile: relative path resolves against the
  // lens config file's directory, not process.cwd(). This lets a
  // lens ship `context.md` next to its `config.yaml` and work no
  // matter where the operator launches JanuScope from.
  it("resolves contextInjection.textFile relative to the lens config directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpo-ctx-"));
    const cfgPath = join(dir, "lens.yaml");
    writeFileSync(join(dir, "context.md"), "Active projects: PROJ-A, PROJ-B.\n");
    writeFileSync(
      cfgPath,
      [
        "target:",
        "  command: node",
        "contextInjection:",
        "  injectInto: [list_issues]",
        "  textFile: ./context.md",
      ].join("\n"),
    );
    const cfg = loadConfig(cfgPath, {});
    expect(cfg.contextInjection?.textFile).toBe(join(dir, "context.md"));
  });

  it("leaves absolute contextInjection.textFile paths untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpo-ctx-"));
    const cfgPath = join(dir, "lens.yaml");
    const absoluteTarget = "/etc/januscope/shared-context.md";
    writeFileSync(
      cfgPath,
      [
        "target:",
        "  command: node",
        "contextInjection:",
        "  injectInto: [list_issues]",
        `  textFile: ${absoluteTarget}`,
      ].join("\n"),
    );
    const cfg = loadConfig(cfgPath, {});
    expect(cfg.contextInjection?.textFile).toBe(absoluteTarget);
  });

  it("rejects contextInjection with both text and textFile (mutually exclusive)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpo-ctx-"));
    const cfgPath = join(dir, "lens.yaml");
    writeFileSync(
      cfgPath,
      [
        "target:",
        "  command: node",
        "contextInjection:",
        "  injectInto: [x]",
        "  text: inline",
        "  textFile: /tmp/somewhere.md",
      ].join("\n"),
    );
    expect(() => loadConfig(cfgPath, {})).toThrow(/exactly one of/);
  });
});
