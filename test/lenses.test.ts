import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadLenses,
  splitFrontmatter,
  LensMetadataSchema,
  STALE_THRESHOLD_MONTHS,
} from "../src/lenses.js";

/* ─────────────────── fixtures ─────────────────── */

function validConfigYaml(): string {
  return `target:
  command: node
  args: ["server.js"]
`;
}

function validReadmeMd(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    mcp: "@example/mcp",
    mcpUrl: "https://example.com/mcp",
    testedVersion: "1.0",
    testedAt: "2026-04-01",
    maintainer: "@alice",
    category: "databases",
    status: "active",
    ...overrides,
  };
  const fm = Object.entries(fields)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  return `---\n${fm}\n---\n\n# Example lens\n\nBody prose.\n`;
}

function makeLensTree(
  lenses: Array<{ category: string; name: string; config?: string; readme?: string }>,
): string {
  const root = mkdtempSync(join(tmpdir(), "januscope-lenses-test-"));
  for (const lens of lenses) {
    const dir = join(root, lens.category, lens.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), lens.config ?? validConfigYaml());
    writeFileSync(join(dir, "README.md"), lens.readme ?? validReadmeMd());
  }
  return root;
}

/* ─────────────────── splitFrontmatter ─────────────────── */

describe("splitFrontmatter", () => {
  it("extracts the frontmatter block", () => {
    const { frontmatter, body } = splitFrontmatter("---\nkey: value\n---\n\nHello.\n");
    expect(frontmatter).toBe("key: value");
    expect(body.trim()).toBe("Hello.");
  });

  it("handles CRLF line endings", () => {
    const text = "---\r\nkey: value\r\n---\r\nHello.\r\n";
    const { frontmatter, body } = splitFrontmatter(text);
    expect(frontmatter).toBe("key: value");
    expect(body.trim()).toBe("Hello.");
  });

  it("returns null when no frontmatter present", () => {
    const { frontmatter, body } = splitFrontmatter("# No frontmatter here\n");
    expect(frontmatter).toBeNull();
    expect(body).toBe("# No frontmatter here\n");
  });

  it("handles an empty frontmatter block", () => {
    const { frontmatter, body } = splitFrontmatter("---\n\n---\n\nBody.\n");
    expect(frontmatter).toBe("");
    expect(body.trim()).toBe("Body.");
  });
});

/* ─────────────────── LensMetadataSchema ─────────────────── */

describe("LensMetadataSchema", () => {
  it("accepts a valid record", () => {
    const r = LensMetadataSchema.safeParse({
      mcp: "@foo/bar",
      mcpUrl: "https://github.com/foo/bar",
      testedVersion: "2.x",
      testedAt: "2026-04-17",
      maintainer: "@bob",
      category: "dev-tools",
      status: "active",
      tags: ["a", "b"],
    });
    expect(r.success).toBe(true);
  });

  it("rejects a bad date", () => {
    const r = LensMetadataSchema.safeParse({
      mcp: "@x/y",
      mcpUrl: "https://example.com",
      testedVersion: "1",
      testedAt: "17-04-2026",
      maintainer: "@a",
      category: "databases",
      status: "active",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a maintainer without @", () => {
    const r = LensMetadataSchema.safeParse({
      mcp: "@x/y",
      mcpUrl: "https://example.com",
      testedVersion: "1",
      testedAt: "2026-04-17",
      maintainer: "alice",
      category: "databases",
      status: "active",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown category", () => {
    const r = LensMetadataSchema.safeParse({
      mcp: "@x/y",
      mcpUrl: "https://example.com",
      testedVersion: "1",
      testedAt: "2026-04-17",
      maintainer: "@alice",
      category: "unknown-category",
      status: "active",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown status", () => {
    const r = LensMetadataSchema.safeParse({
      mcp: "@x/y",
      mcpUrl: "https://example.com",
      testedVersion: "1",
      testedAt: "2026-04-17",
      maintainer: "@alice",
      category: "databases",
      status: "deprecated",
    });
    expect(r.success).toBe(false);
  });
});

/* ─────────────────── loadLenses ─────────────────── */

describe("loadLenses", () => {
  it("discovers valid lenses in subdirectories", () => {
    const root = makeLensTree([
      { category: "databases", name: "foo" },
      { category: "dev-tools", name: "bar" },
    ]);
    const { lenses, errors } = loadLenses({ rootDir: root });
    expect(errors).toEqual([]);
    expect(lenses.map((l) => l.name).sort()).toEqual(["bar", "foo"]);
  });

  it("skips _template and _archive by default", () => {
    const root = makeLensTree([
      { category: "databases", name: "active-one" },
      { category: "_template", name: "inside" },
      { category: "_archive", name: "retired" },
    ]);
    const { lenses } = loadLenses({ rootDir: root });
    expect(lenses.map((l) => l.name)).toEqual(["active-one"]);
  });

  it("includes _archive when includeArchived is true", () => {
    const root = makeLensTree([
      { category: "databases", name: "active-one" },
      { category: "_archive", name: "retired" },
    ]);
    const { lenses } = loadLenses({ rootDir: root, includeArchived: true });
    expect(lenses.map((l) => l.name).sort()).toEqual(["active-one", "retired"]);
  });

  it("skips lens folders whose names start with _", () => {
    const root = makeLensTree([
      { category: "databases", name: "keep" },
      { category: "databases", name: "_skip" },
    ]);
    const { lenses } = loadLenses({ rootDir: root });
    expect(lenses.map((l) => l.name)).toEqual(["keep"]);
  });

  it("reports missing README.md as a load error", () => {
    const root = mkdtempSync(join(tmpdir(), "januscope-lenses-test-"));
    const dir = join(root, "databases", "no-readme");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), validConfigYaml());
    // No README.md written.
    const { lenses, errors } = loadLenses({ rootDir: root });
    expect(lenses).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.errors.join(" ")).toMatch(/README/);
  });

  it("reports invalid config.yaml as a load error", () => {
    const root = makeLensTree([{ category: "databases", name: "bad", config: "target: []\n" }]);
    const { lenses, errors } = loadLenses({ rootDir: root });
    expect(lenses).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.errors.join(" ")).toMatch(/januscope/);
  });

  it("reports missing frontmatter as a load error", () => {
    const root = makeLensTree([
      {
        category: "databases",
        name: "no-fm",
        readme: "# Just a plain README without frontmatter\n",
      },
    ]);
    const { lenses, errors } = loadLenses({ rootDir: root });
    expect(lenses).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.errors.join(" ")).toMatch(/frontmatter/);
  });

  it("flags stale lenses with isStale=true", () => {
    const root = makeLensTree([
      {
        category: "databases",
        name: "old-one",
        readme: validReadmeMd({ testedAt: "2024-01-01" }),
      },
      {
        category: "databases",
        name: "fresh-one",
        readme: validReadmeMd({ testedAt: "2026-04-01" }),
      },
    ]);
    const now = new Date("2026-04-17T00:00:00Z");
    const { lenses } = loadLenses({ rootDir: root, now: () => now });
    const old = lenses.find((l) => l.name === "old-one");
    const fresh = lenses.find((l) => l.name === "fresh-one");
    expect(old?.isStale).toBe(true);
    expect(fresh?.isStale).toBe(false);
  });

  it("archived lenses are never flagged as stale (even if old)", () => {
    const root = makeLensTree([
      {
        category: "databases",
        name: "archived-old",
        readme: validReadmeMd({ testedAt: "2020-01-01", status: "archived" }),
      },
    ]);
    const now = new Date("2026-04-17T00:00:00Z");
    const { lenses, errors } = loadLenses({
      rootDir: root,
      now: () => now,
      includeArchived: false,
    });
    // Archived lenses are only included when includeArchived=true AND they
    // live under _archive/. Being under `databases/` with status=archived
    // just means it's still listed; stale check skips archived regardless.
    expect(errors).toEqual([]);
    expect(lenses.find((l) => l.name === "archived-old")?.isStale).toBe(false);
  });

  it("placeholder env lets lenses with ${VAR} validate without real values", () => {
    const configWithEnv = `target:
  command: node
  args: ["server.js"]
dbSchema:
  driver: postgres
  connectionString: "\${DATABASE_URL}"
`;
    const root = makeLensTree([
      { category: "databases", name: "needs-env", config: configWithEnv },
    ]);
    // No DATABASE_URL set in env — default placeholderForMissingEnv=true
    // should synthesise a placeholder value.
    const { lenses, errors } = loadLenses({ rootDir: root, env: {} });
    expect(errors).toEqual([]);
    expect(lenses).toHaveLength(1);
    expect(lenses[0]!.config.dbSchema?.connectionString).toBe("<UNSET:DATABASE_URL>");
  });

  it("placeholderForMissingEnv=false reverts to empty-string substitution", () => {
    const configWithEnv = `target:
  command: node
  args: ["server.js"]
dbSchema:
  driver: postgres
  connectionString: "\${DATABASE_URL}"
`;
    const root = makeLensTree([
      { category: "databases", name: "needs-env", config: configWithEnv },
    ]);
    const { lenses, errors } = loadLenses({
      rootDir: root,
      env: {},
      placeholderForMissingEnv: false,
    });
    // Empty string fails zod's min(1) check.
    expect(lenses).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("returns lenses in deterministic (alphabetical) order", () => {
    const root = makeLensTree([
      { category: "databases", name: "zeta" },
      { category: "databases", name: "alpha" },
      { category: "dev-tools", name: "mu" },
    ]);
    const { lenses } = loadLenses({ rootDir: root });
    const paths = lenses.map((l) => l.relativePath.replace(/\\/g, "/"));
    expect(paths).toEqual(["databases/alpha", "databases/zeta", "dev-tools/mu"]);
  });
});

describe("STALE_THRESHOLD_MONTHS", () => {
  it("is six months", () => {
    expect(STALE_THRESHOLD_MONTHS).toBe(6);
  });
});
