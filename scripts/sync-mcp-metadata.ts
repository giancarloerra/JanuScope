// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/** Keep the MCP Registry manifest aligned with the npm release version. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function readObject(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

try {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check") || args.length > 1) {
    throw new Error("Usage: tsx scripts/sync-mcp-metadata.ts [--check] (from the project root)");
  }
  const check = args.includes("--check");
  const pkg = readObject(resolve("package.json"));
  const manifestPath = resolve("server.json");
  const manifest = readObject(manifestPath);
  if (typeof pkg.name !== "string" || typeof pkg.version !== "string" || !pkg.version) {
    throw new Error("package.json must declare a package name and version");
  }
  if (typeof pkg.mcpName !== "string" || manifest.name !== pkg.mcpName) {
    throw new Error("server.json name must match package.json mcpName");
  }
  if (!Array.isArray(manifest.packages)) {
    throw new Error("server.json must declare its npm package");
  }
  const packages = manifest.packages.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" &&
      entry !== null &&
      entry.registryType === "npm" &&
      entry.identifier === pkg.name,
  );
  if (!packages.length) throw new Error("server.json has no matching npm package");
  const aligned =
    manifest.version === pkg.version && packages.every((entry) => entry.version === pkg.version);
  if (!aligned && check) {
    throw new Error(
      "MCP metadata version differs from package.json; run tsx scripts/sync-mcp-metadata.ts",
    );
  }
  if (!aligned) {
    manifest.version = pkg.version;
    for (const entry of packages) entry.version = pkg.version;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  process.stdout.write(`MCP metadata matches ${pkg.name}@${pkg.version}\n`);
} catch (error) {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
