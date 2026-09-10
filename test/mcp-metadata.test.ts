import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts/sync-mcp-metadata.ts");
const tsx = join(root, "node_modules/tsx/dist/cli.mjs");
const temporaryRoots: string[] = [];

function run(cwd: string, args: string[] = []) {
  const result = spawnSync(process.execPath, [tsx, script, ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return result;
}

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "januscope-metadata-"));
  temporaryRoots.push(cwd);
  const pkg = { name: "example-mcp", mcpName: "io.example/mcp", version: "1.2.3-beta.1" };
  const manifest = {
    name: pkg.mcpName,
    description: "Example MCP",
    version: "1.0.0",
    packages: [
      { registryType: "npm", identifier: pkg.name, version: "1.0.0", transport: { type: "stdio" } },
      { registryType: "oci", identifier: "example/other", version: "7.0.0" },
    ],
  };
  writeFileSync(join(cwd, "package.json"), JSON.stringify(pkg));
  writeFileSync(join(cwd, "server.json"), JSON.stringify(manifest));
  return { cwd, pkg, manifest };
}

afterEach(() => {
  for (const cwd of temporaryRoots.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe("MCP release metadata", () => {
  it("keeps the checked-in version aligned with npm and uses package arguments", () => {
    expect(run(root, ["--check"]).status).toBe(0);
    const manifest = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
    expect(manifest.description.length).toBeLessThanOrEqual(100);
    expect(manifest.packages[0].runtimeArguments).toBeUndefined();
    expect(manifest.packages[0].packageArguments).toEqual([
      expect.objectContaining({ type: "named", name: "--config", isRequired: true }),
    ]);
  });

  it("reports drift without changing any file in check mode", () => {
    const { cwd } = fixture();
    const before = readFileSync(join(cwd, "server.json"), "utf8");
    const result = run(cwd, ["--check"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("version differs");
    expect(readFileSync(join(cwd, "server.json"), "utf8")).toBe(before);
  });

  it("synchronizes both release versions and preserves other package metadata", () => {
    const { cwd, pkg, manifest } = fixture();
    const beforePackage = readFileSync(join(cwd, "package.json"), "utf8");
    expect(run(cwd).status).toBe(0);
    expect(JSON.parse(readFileSync(join(cwd, "server.json"), "utf8"))).toEqual({
      ...manifest,
      version: pkg.version,
      packages: [{ ...manifest.packages[0], version: pkg.version }, manifest.packages[1]],
    });
    expect(readFileSync(join(cwd, "package.json"), "utf8")).toBe(beforePackage);
    const after = readFileSync(join(cwd, "server.json"), "utf8");
    expect(run(cwd).status).toBe(0);
    expect(run(cwd, ["--check"]).status).toBe(0);
    expect(readFileSync(join(cwd, "server.json"), "utf8")).toBe(after);
  });

  it.each(["mismatched name", "missing npm package"])("refuses %s without writing", (kind) => {
    const { cwd, manifest } = fixture();
    if (kind === "mismatched name") manifest.name = "io.other/mcp";
    else manifest.packages = [];
    const before = JSON.stringify(manifest);
    writeFileSync(join(cwd, "server.json"), before);
    expect(run(cwd).status).toBe(1);
    expect(readFileSync(join(cwd, "server.json"), "utf8")).toBe(before);
  });

  it("rejects unknown arguments without writing", () => {
    const { cwd } = fixture();
    const before = readFileSync(join(cwd, "server.json"), "utf8");
    expect(run(cwd, ["--publish"]).status).toBe(1);
    expect(readFileSync(join(cwd, "server.json"), "utf8")).toBe(before);
  });
});
