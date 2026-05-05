// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * Tests for the `--config` argument's path-vs-name auto-detection.
 *
 * The CLI accepts `--config <value>` where <value> is either:
 *   - the bare name of a bundled lens (e.g. "postgres-crystaldba"), OR
 *   - a path to a YAML/JSON file (any other shape).
 *
 * Detection is shape-based, not "try one then the other" — a typo'd
 * lens name should fail with a clear "no bundled lens named X" error,
 * not fall through to "ENOENT relative path X".
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(__dirname, "..", "src", "cli.ts");
const TSX = resolve(__dirname, "..", "node_modules", ".bin", "tsx");

function runCli(
  args: string[],
  extraEnv: Record<string, string> = {},
): {
  stdout: string;
  stderr: string;
  status: number;
} {
  // We don't actually want JanuScope to spawn a real target during these
  // resolver tests; we only care about config loading. So we use the
  // approve subcommand with --no-probe — it loads the config but doesn't
  // spawn the target.
  const r = spawnSync(TSX, [CLI, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
    timeout: 30_000,
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: typeof r.status === "number" ? r.status : 1,
  };
}

describe("cli: --config argument resolution", () => {
  it("treats a bare bundled-lens name as a name, not a path", () => {
    // We use approve --no-probe so the loader runs but the target
    // isn't spawned. Approve without env vars set will surface the
    // missing-env-vars notice or succeed depending on the lens; either
    // way, "lens loaded" is what we're asserting (no path-resolution
    // error in stderr).
    const r = runCli(["approve", "--config", "sqlite-panasenco", "--no-probe"], {
      SQLITE_DB_PATH: "/tmp/doesnt-have-to-exist.db",
    });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/ENOENT/);
    expect(r.stderr).not.toMatch(/no bundled lens/);
    expect(r.stdout).toMatch(/januscope approve/);
  });

  it("rejects an unknown bare name with a clear message (does NOT try as relative path)", () => {
    const r = runCli(["approve", "--config", "definitely-not-a-real-lens", "--no-probe"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no bundled lens named "definitely-not-a-real-lens"/);
    expect(r.stderr).toMatch(/Available bundled lenses/);
    // Critical: should NOT have fallen through to a generic ENOENT — we
    // detected the shape was a name and failed early with the right message.
    expect(r.stderr).not.toMatch(/ENOENT/);
  });

  it("accepts a path with a YAML extension", () => {
    const dir = mkdtempSync(join(tmpdir(), "januscope-cfg-resolver-"));
    const path = join(dir, "lens.yaml");
    writeFileSync(
      path,
      ["target:", "  command: /usr/bin/env", "  args: [echo, hello]", ""].join("\n"),
    );
    const r = runCli(["approve", "--config", path, "--no-probe"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/januscope approve/);
  });

  it("accepts a relative path (./...)", () => {
    const dir = mkdtempSync(join(tmpdir(), "januscope-cfg-resolver-"));
    const filename = "lens.yaml";
    writeFileSync(
      join(dir, filename),
      ["target:", "  command: /usr/bin/env", "  args: [echo, hello]", ""].join("\n"),
    );
    // Run from the temp dir so the relative path resolves there.
    const r = spawnSync(TSX, [CLI, "approve", "--config", `./${filename}`, "--no-probe"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: dir,
      env: process.env,
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
    expect((r.stdout ?? "").length).toBeGreaterThan(0);
  });

  it("treats an unknown path-shaped value as a path (and reports a path error, not a lens error)", () => {
    const r = runCli(["approve", "--config", "/absolutely/no/such/file.yaml", "--no-probe"]);
    expect(r.status).not.toBe(0);
    // Should be a path-loader error, not "no bundled lens" — the value
    // contained `/` and `.yaml` so it's a path.
    expect(r.stderr).not.toMatch(/no bundled lens/);
  });

  it("accepts a path-shaped value with a leading dot", () => {
    // `.foo` is a relative path (current dir, hidden file). Even though
    // it's not a real file here, the detector should send it down the
    // path branch, not the name-lookup branch.
    const r = runCli(["approve", "--config", ".no-such-file.yaml", "--no-probe"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toMatch(/no bundled lens/);
  });
});
