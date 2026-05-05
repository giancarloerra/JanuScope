import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { renderBootSummary, shouldPrintBootSummary } from "../src/boot-summary.js";
import type { OverlayConfig } from "../src/config.js";

const CLI = resolve(__dirname, "..", "src", "cli.ts");
const TSX = resolve(__dirname, "..", "node_modules", ".bin", "tsx");
const FAKE_SERVER = resolve(__dirname, "fixtures", "fake-mcp-server.mjs");

/**
 * Build a minimal but realistic OverlayConfig for the unit tests. The
 * cast through `unknown` lets us hand-craft a config that's already
 * been validated upstream — the renderer is tested with the same
 * shape that runtime hands it, not with an unsafe partial.
 */
function makeConfig(overrides: Partial<OverlayConfig> = {}): OverlayConfig {
  return {
    target: { command: "node", args: [FAKE_SERVER] },
    ...overrides,
  } as OverlayConfig;
}

describe("renderBootSummary", () => {
  it("includes version and target command", () => {
    // Use a short command so truncation doesn't elide the args; the
    // truncation behaviour itself is covered by a separate test below.
    const out = renderBootSummary(
      {
        target: { command: "node", args: ["server.mjs"] },
      } as OverlayConfig,
      "0.4.1",
    );
    expect(out).toContain("[januscope] v0.4.1");
    expect(out).toContain("node server.mjs");
  });

  it("renders one bullet per active overlay", () => {
    const out = renderBootSummary(
      makeConfig({
        block: ["dangerous_delete"],
        sqlGuard: { tools: ["query"], sqlArg: "sql", readOnly: true, mode: "block" },
        redact: {
          rules: [{ regex: "\\d{3}-\\d{2}-\\d{4}" }],
          replacement: "[REDACTED]",
          applyTo: "text",
        },
        audit: { sink: "/tmp/audit.jsonl", logRawArgs: false },
        instructions: "READ-ONLY policy text.",
      } as Partial<OverlayConfig>),
      "0.4.1",
    );

    // Each section appears with its overlay name + key info.
    expect(out).toContain("block:");
    expect(out).toContain("1 rule(s)");
    expect(out).toContain("sqlGuard:");
    expect(out).toContain("query (readOnly)");
    expect(out).toContain("redact:");
    expect(out).toContain("audit:");
    expect(out).toContain("/tmp/audit.jsonl");
    expect(out).toContain("instructions:");
    expect(out).toContain("(append)");
  });

  it("includes the classification banner when set", () => {
    const out = renderBootSummary(makeConfig({ classification: "internal" }), "0.4.1");
    expect(out).toContain("[internal]");
  });

  it("omits the silence hint when no overlay is active", () => {
    const out = renderBootSummary(makeConfig(), "0.4.1");
    expect(out).not.toContain("JANUSCOPE_QUIET");
  });

  it("includes the silence hint when at least one overlay is active", () => {
    const out = renderBootSummary(makeConfig({ block: ["a"] }), "0.4.1");
    expect(out).toContain("JANUSCOPE_QUIET=1");
  });

  it("truncates very long target commands", () => {
    const longArgs = Array.from({ length: 30 }, (_, i) => `arg${i}-with-padding`);
    const out = renderBootSummary(
      makeConfig({ target: { command: "node", args: longArgs } }),
      "0.4.1",
    );
    // The header line should still fit comfortably; truncation marker
    // is the trailing "…".
    const header = out.split("\n", 1)[0]!;
    expect(header.length).toBeLessThanOrEqual(120);
    expect(header).toContain("…");
  });

  it("renders firstRun=approve as a bullet", () => {
    const out = renderBootSummary(makeConfig({ firstRun: "approve" }), "0.4.1");
    expect(out).toContain("firstRun:");
    expect(out).toContain("approve");
  });

  it("never includes a trailing carriage return / unprintable chars", () => {
    const out = renderBootSummary(
      makeConfig({ block: ["foo"], audit: { sink: "/tmp/x.jsonl", logRawArgs: false } }),
      "0.4.1",
    );
    expect(out).not.toContain("\r");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("collapses newlines / tabs in target tokens to single-line header", () => {
    // A YAML scalar with a stray newline could otherwise produce a
    // multi-line header that breaks the rest of the summary's shape.
    const out = renderBootSummary(
      {
        target: { command: "node\nshady", args: ["arg1\twith\ttab", "arg2"] },
      } as OverlayConfig,
      "0.4.1",
    );
    const header = out.split("\n", 1)[0]!;
    expect(header).toContain("node shady");
    expect(header).toContain("arg1 with tab");
    expect(header).not.toContain("\t");
    // The full output's first newline is the terminator after the
    // header, not a newline in the middle of the rendered command.
    expect(header.startsWith("[januscope]")).toBe(true);
  });
});

describe("shouldPrintBootSummary", () => {
  it("returns true with no overrides", () => {
    expect(shouldPrintBootSummary({})).toBe(true);
  });

  it("returns false when JANUSCOPE_QUIET=1", () => {
    expect(shouldPrintBootSummary({ JANUSCOPE_QUIET: "1" })).toBe(false);
  });

  it("returns false when JANUSCOPE_NO_BOOT_SUMMARY=1", () => {
    expect(shouldPrintBootSummary({ JANUSCOPE_NO_BOOT_SUMMARY: "1" })).toBe(false);
  });

  it("treats QUIET=0 as off (truthy-only check)", () => {
    expect(shouldPrintBootSummary({ JANUSCOPE_QUIET: "0" })).toBe(true);
    expect(shouldPrintBootSummary({ JANUSCOPE_QUIET: "false" })).toBe(true);
    expect(shouldPrintBootSummary({ JANUSCOPE_QUIET: "" })).toBe(true);
  });

  it("treats QUIET=true / yes / anything-non-zero as on", () => {
    expect(shouldPrintBootSummary({ JANUSCOPE_QUIET: "true" })).toBe(false);
    expect(shouldPrintBootSummary({ JANUSCOPE_QUIET: "yes" })).toBe(false);
    expect(shouldPrintBootSummary({ JANUSCOPE_QUIET: "anything" })).toBe(false);
  });
});

/**
 * Integration: spawn the CLI for real and assert stderr contains the
 * boot summary. We use the fake-mcp-server fixture so no real MCP
 * package is required, and shut the bridge down by closing stdin
 * immediately (the fixture exits when its readline closes).
 */
describe("CLI boot summary", () => {
  function runCliBriefly(args: string[], extraEnv: Record<string, string> = {}) {
    const r = spawnSync(TSX, [CLI, ...args], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
      // Close stdin so the bridge tears down immediately. The fake
      // server reads stdin via readline; closing stdin propagates a
      // close event and the process exits cleanly.
      input: "",
      timeout: 15_000,
    });
    // A timed-out child still leaves whatever it managed to write on
    // stderr — assertions on partial stderr could pass even if the
    // process hung. Surface timeout/error explicitly so each test can
    // refuse to consider a hung run a clean run.
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      status: typeof r.status === "number" ? r.status : -1,
      timedOut,
      signal: r.signal ?? null,
    };
  }

  it("emits the boot summary on stderr by default", () => {
    const r = runCliBriefly(["--target", `node ${FAKE_SERVER}`, "--block", "dangerous_delete"]);
    expect(r.timedOut).toBe(false);
    // We don't care about exit code (the bridge teardown when stdin
    // closes is still a clean path), only that the summary appeared
    // before the bridge ran.
    expect(r.stderr).toContain("[januscope]");
    expect(r.stderr).toContain("wrapping");
    expect(r.stderr).toContain("block:");
  });

  it("suppresses the boot summary with JANUSCOPE_QUIET=1", () => {
    const r = runCliBriefly(["--target", `node ${FAKE_SERVER}`, "--block", "dangerous_delete"], {
      JANUSCOPE_QUIET: "1",
    });
    expect(r.timedOut).toBe(false);
    expect(r.stderr).not.toContain("[januscope] v");
    expect(r.stderr).not.toContain("wrapping");
  });

  it("suppresses the boot summary with JANUSCOPE_NO_BOOT_SUMMARY=1", () => {
    const r = runCliBriefly(["--target", `node ${FAKE_SERVER}`, "--block", "dangerous_delete"], {
      JANUSCOPE_NO_BOOT_SUMMARY: "1",
    });
    expect(r.timedOut).toBe(false);
    expect(r.stderr).not.toContain("[januscope] v");
    expect(r.stderr).not.toContain("wrapping");
  });
});
