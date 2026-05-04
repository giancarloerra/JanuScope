import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(__dirname, "..", "scripts", "validate-lenses.ts");
const TSX = resolve(__dirname, "..", "node_modules", ".bin", "tsx");

function runValidator(args: string[]): { stdout: string; status: number; stderr: string } {
  try {
    const stdout = execFileSync(TSX, [SCRIPT, ...args], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, status: 0, stderr: "" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      status: typeof e.status === "number" ? e.status : 1,
    };
  }
}

function makeRoot(entries: Array<{ path: string; content: string }>): string {
  const root = mkdtempSync(join(tmpdir(), "januscope-validator-"));
  for (const e of entries) {
    const full = join(root, e.path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, e.content);
  }
  return root;
}

const validReadme = `---
mcp: "@example/mcp"
mcpUrl: https://example.com
testedVersion: "1.0"
testedAt: "2026-04-01"
maintainer: "@alice"
category: databases
status: active
---

# Example
`;

const validConfig = `target:
  command: node
  args: ["server.js"]
`;

describe("scripts/validate-lenses", () => {
  it("exits 0 on the bundled repo lenses", () => {
    const r = runValidator([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("All lenses valid");
  });

  it("exits 0 when a custom --root has only valid lenses", () => {
    const root = makeRoot([
      { path: "databases/good/config.yaml", content: validConfig },
      { path: "databases/good/README.md", content: validReadme },
    ]);
    const r = runValidator(["--root", root]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("databases/good");
  });

  it("exits 1 when a lens has invalid config.yaml", () => {
    const root = makeRoot([
      { path: "databases/broken/config.yaml", content: "target:\n  command:\n" },
      { path: "databases/broken/README.md", content: validReadme },
    ]);
    const r = runValidator(["--root", root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("databases/broken");
  });

  it("exits 1 when frontmatter is missing", () => {
    const root = makeRoot([
      { path: "databases/no-fm/config.yaml", content: validConfig },
      { path: "databases/no-fm/README.md", content: "# No frontmatter\n" },
    ]);
    const r = runValidator(["--root", root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("frontmatter");
  });

  it("warns but passes on stale lenses without --strict", () => {
    const staleReadme = validReadme.replace(`testedAt: "2026-04-01"`, `testedAt: "2020-01-01"`);
    const root = makeRoot([
      { path: "databases/stale-one/config.yaml", content: validConfig },
      { path: "databases/stale-one/README.md", content: staleReadme },
    ]);
    const r = runValidator(["--root", root]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("stale");
  });

  it("fails on stale lenses with --strict", () => {
    const staleReadme = validReadme.replace(`testedAt: "2026-04-01"`, `testedAt: "2020-01-01"`);
    const root = makeRoot([
      { path: "databases/stale-one/config.yaml", content: validConfig },
      { path: "databases/stale-one/README.md", content: staleReadme },
    ]);
    const r = runValidator(["--root", root, "--strict"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("stale");
  });

  it("exits 2 on bad argument", () => {
    const r = runValidator(["--unknown-flag"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown argument");
  });

  it("prints help with --help", () => {
    const r = runValidator(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("validate-lenses");
  });
});
