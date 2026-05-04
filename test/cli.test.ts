import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const CLI = resolve(__dirname, "..", "src", "cli.ts");
const TSX = resolve(__dirname, "..", "node_modules", ".bin", "tsx");

function runCli(args: string[], home?: string): { stdout: string; status: number; stderr: string } {
  // spawnSync (vs execFileSync) returns both stdout and stderr
  // regardless of exit code, which we need for tests that assert on
  // stderr warnings emitted on the success path (e.g. soft-fail probe).
  const r = spawnSync(TSX, [CLI, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...(home ? { env: { ...process.env, HOME: home } } : {}),
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: typeof r.status === "number" ? r.status : 1,
  };
}

describe("cli", () => {
  it("prints help with --help", () => {
    const r = runCli(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("JanuScope");
    expect(r.stdout).toContain("--config");
  });

  it("prints version with --version", () => {
    const r = runCli(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("rejects unknown arguments", () => {
    const r = runCli(["--nope"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown argument");
  });

  it("requires --config or --target", () => {
    const r = runCli([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--config or --target");
  });

  it("--config requires a path value", () => {
    const r = runCli(["--config"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--config requires a path");
  });
});

describe("cli: lenses subcommand", () => {
  it("prints usage on bare 'lenses'", () => {
    const r = runCli(["lenses"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("januscope lenses");
    expect(r.stdout).toContain("list");
    expect(r.stdout).toContain("show");
    expect(r.stdout).toContain("search");
  });

  it("lenses list shows every bundled lens grouped by category", () => {
    const r = runCli(["lenses", "list"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("databases");
    expect(r.stdout).toContain("mongodb-official");
    expect(r.stdout).toContain("dev-tools");
    expect(r.stdout).toContain("filesystem-mcp-official");
    expect(r.stdout).toMatch(/\d+ lens\(es\) total\./);
  });

  it("lenses search matches by MCP package and by tag", () => {
    const r1 = runCli(["lenses", "search", "mongodb"]);
    expect(r1.status).toBe(0);
    expect(r1.stdout).toContain("mongodb-official");

    const r2 = runCli(["lenses", "search", "readonly"]);
    expect(r2.status).toBe(0);
    // Most bundled lenses have the "readonly" tag or similar; this
    // just confirms tag matching works.
    expect(r2.stdout).toMatch(/\d+ match\(es\)\./);
  });

  it("lenses show dumps config + README for a known lens", () => {
    // Pick a Lens that is active (sqlite is currently archived upstream
    // and its MCP identifier is intentionally verbose).
    const r = runCli(["lenses", "show", "mysql-benborla29"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Lens: mysql-benborla29");
    expect(r.stdout).toContain("MCP: @benborla29/mcp-server-mysql");
    expect(r.stdout).toContain("--- README.md ---");
    expect(r.stdout).toContain("--- config.yaml ---");
    expect(r.stdout).toContain("block:");
  });

  it("lenses show exits non-zero on unknown lens", () => {
    const r = runCli(["lenses", "show", "nonexistent-lens-name-xyz"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no lens named");
  });

  it("lenses show requires a name", () => {
    const r = runCli(["lenses", "show"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("requires a lens name");
  });

  it("lenses search requires a query", () => {
    const r = runCli(["lenses", "search"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("requires a query");
  });

  it("rejects unknown lenses subcommand", () => {
    const r = runCli(["lenses", "delete"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown lenses subcommand");
  });
});

describe("cli: approve subcommand", () => {
  it("prints help with --help", () => {
    const r = runCli(["approve", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("januscope approve");
    expect(r.stdout).toContain("--config");
  });

  it("errors when --config is missing", () => {
    const r = runCli(["approve"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--config is required");
  });

  it("records a static approval (with --no-probe) for a valid config file", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "januscope-cli-approve-"));
    const cfgPath = join(dir, "lens.yaml");
    writeFileSync(
      cfgPath,
      "target:\n  command: npx\n  args: ['-y', 'some-mcp']\nblock:\n  - write_file\n",
    );
    // Isolate the approvals file via HOME override so the test
    // doesn't poke at the user's real ~/.januscope/.
    // --no-probe avoids actually spawning npx/some-mcp; the
    // probe-on-approve path is exercised by a separate test below
    // using the fake-mcp-server fixture.
    const homeForTest = join(dir, "fake-home");
    const r = runCli(["approve", "--config", cfgPath, "--no-probe"], homeForTest);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("recorded approval");
    expect(r.stdout).toContain("block rules:  1");
    expect(r.stdout).toContain("<skipped, will TOFU on first run>");
  });

  // The full probe-and-record path. Uses the fake-mcp-server fixture
  // (which speaks the standard MCP handshake) as the target. Verifies
  // the static AND live fingerprints are both stored after one
  // `januscope approve` invocation.
  it("probes the target and records BOTH static + live fingerprints when --no-probe is omitted", async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "januscope-cli-approve-probe-"));
    const cfgPath = join(dir, "lens.yaml");
    const fixturePath = join(process.cwd(), "test", "fixtures", "fake-mcp-server.mjs");
    writeFileSync(
      cfgPath,
      `target:\n` +
        `  command: node\n` +
        `  args: ['${fixturePath}']\n` +
        `block:\n` +
        `  - dangerous_delete\n`,
    );
    const homeForTest = join(dir, "fake-home");
    const r = runCli(["approve", "--config", cfgPath, "--probe-timeout", "30000"], homeForTest);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("recorded approval");
    expect(r.stdout).toContain("static fingerprint:");
    expect(r.stdout).toContain("live fingerprint:");
    expect(r.stdout).toContain("3 tools");
    expect(r.stdout).toContain("fake-mcp-server v0.0.1");

    // Verify the on-disk approval has both fingerprints recorded.
    const approvalsPath = join(homeForTest, ".januscope", "approved.json");
    const stored = JSON.parse(readFileSync(approvalsPath, "utf8")) as {
      approvals: Record<
        string,
        { fingerprint: string; live_tools_fingerprint?: string; live_tools_approved_at?: string }
      >;
    };
    const entry = Object.values(stored.approvals)[0]!;
    expect(entry.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.live_tools_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.live_tools_approved_at).toMatch(/^\d{4}-/);
  });

  // When the target is unreachable (here: a binary that doesn't
  // exist), approve must still record the static fingerprint, print
  // a clear warning, and exit 0 — soft failure, the operator can
  // re-run approve once the target is reachable, or rely on the
  // first-run TOFU.
  it("records the static fingerprint and warns when probe fails (soft failure, exit 0)", async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "januscope-cli-approve-failprobe-"));
    const cfgPath = join(dir, "lens.yaml");
    writeFileSync(
      cfgPath,
      "target:\n  command: /definitely/no/such/binary\nblock:\n  - write_file\n",
    );
    const homeForTest = join(dir, "fake-home");
    // 15s is the minimum probe timeout the CLI accepts; the spawn
    // failure path resolves immediately (ENOENT), so the test still
    // takes well under a second.
    const r = runCli(["approve", "--config", cfgPath, "--probe-timeout", "15000"], homeForTest);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("recorded approval");
    expect(r.stdout).toContain("<probe failed>");
    expect(r.stderr).toContain("warning: live probe failed");

    // Static fingerprint IS persisted; live fingerprint is NOT.
    const approvalsPath = join(homeForTest, ".januscope", "approved.json");
    const stored = JSON.parse(readFileSync(approvalsPath, "utf8")) as {
      approvals: Record<string, { fingerprint: string; live_tools_fingerprint?: string }>;
    };
    const entry = Object.values(stored.approvals)[0]!;
    expect(entry.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.live_tools_fingerprint).toBeUndefined();
  });
});
