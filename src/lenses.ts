// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * Lens discovery and validation.
 *
 * A "lens" is a folder under `lenses/<category>/<name>/` containing a
 * `config.yaml` (valid JanuScope config) and a `README.md` with YAML
 * frontmatter metadata. This module:
 *
 *   - Walks the lenses directory
 *   - Parses and validates config.yaml against the OverlayConfigSchema
 *   - Parses and validates README.md frontmatter against LensMetadataSchema
 *   - Computes derived status (stale if testedAt is older than the threshold)
 *
 * Both the CLI `lenses` subcommand and the `validate:lenses` script
 * consume this module.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import { z } from "zod";
import { substituteEnv, validateConfig, type OverlayConfig } from "./config.js";

/** Known top-level categories. Add here when extending. */
export const LENS_CATEGORIES = ["databases", "dev-tools", "saas", "infra", "other"] as const;
export type LensCategory = (typeof LENS_CATEGORIES)[number];

/**
 * Known status values in the metadata frontmatter.
 *
 *   - `probed`:     live-probed against the target MCP's tools/list on
 *                   the date in `testedAt`. Strongest signal.
 *   - `active`:     maintained and documented against a recent version
 *                   but not live-probed in this release cycle.
 *   - `unverified`: config parses and tool names match published docs
 *                   but the maintainer lacked credentials to spawn the
 *                   target MCP for a live tools/list diff. PRs with a
 *                   live-probe transcript flip this to `probed`.
 *   - `stale`:      not re-tested in the last 6 months.
 *   - `archived`:   target MCP retired or superseded; kept for reference.
 */
export const LENS_STATUSES = ["probed", "active", "unverified", "stale", "archived"] as const;
export type LensStatus = (typeof LENS_STATUSES)[number];

/** Threshold after which an `active` lens is considered stale. */
export const STALE_THRESHOLD_MONTHS = 6;

export const LensMetadataSchema = z.object({
  mcp: z.string().min(1),
  mcpUrl: z.string().url(),
  testedVersion: z.string().min(1),
  testedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date (YYYY-MM-DD)"),
  maintainer: z
    .string()
    .regex(/^@[A-Za-z0-9][A-Za-z0-9_-]*$/, "must be a GitHub handle starting with @"),
  category: z.enum(LENS_CATEGORIES),
  status: z.enum(LENS_STATUSES),
  tags: z.array(z.string().min(1)).optional(),
});

export type LensMetadata = z.infer<typeof LensMetadataSchema>;

export interface Lens {
  /** Stable ID = folder name (e.g. "postgres-mcp-official"). */
  readonly name: string;
  /** Relative path from the lenses root (e.g. "databases/postgres-mcp-official"). */
  readonly relativePath: string;
  /** Absolute path to the lens folder. */
  readonly absolutePath: string;
  /** Parsed and validated config.yaml. */
  readonly config: OverlayConfig;
  /** Parsed and validated README frontmatter. */
  readonly metadata: LensMetadata;
  /** Full README body with frontmatter stripped. */
  readonly readme: string;
  /** True when the declared status is `active` but testedAt is older than the threshold. */
  readonly isStale: boolean;
}

export interface LensLoadError {
  readonly name: string;
  readonly relativePath: string;
  readonly errors: string[];
}

export interface LensLoadResult {
  readonly lenses: Lens[];
  readonly errors: LensLoadError[];
}

export interface LoadOptions {
  /** Absolute path to the lenses directory. Defaults to repo-relative resolution. */
  rootDir?: string;
  /** Override "now" for deterministic testing. */
  now?: () => Date;
  /** Environment used for VAR expansion inside config.yaml. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * When true (default), missing env vars expand to a placeholder string
   * (`"<UNSET:VAR>"`) instead of an empty string. This lets validation
   * and `lenses list`/`lenses show` succeed on lenses whose credentials
   * are configured per-user at runtime.
   */
  placeholderForMissingEnv?: boolean;
  /** Include archived lenses (under _archive) in the result. Defaults to false. */
  includeArchived?: boolean;
}

/** Find the bundled lenses directory shipped with the package. */
export function findBundledLensesDir(): string {
  // When compiled: dist/lenses.js -> ../lenses (repo root)
  // When run via tsx in repo:   src/lenses.ts -> ../lenses
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, "..", "lenses"), resolve(here, "..", "..", "lenses")];
  for (const c of candidates) {
    try {
      if (statSync(c).isDirectory()) return c;
    } catch {
      /* next */
    }
  }
  throw new Error(`could not locate bundled lenses directory (searched: ${candidates.join(", ")})`);
}

/**
 * Walk a lenses directory and return every successfully-parsed lens plus
 * a list of load errors for anything that failed.
 */
export function loadLenses(options: LoadOptions = {}): LensLoadResult {
  const root = options.rootDir ?? findBundledLensesDir();
  const now = options.now ?? (() => new Date());
  const baseEnv = options.env ?? process.env;
  const placeholder = options.placeholderForMissingEnv ?? true;
  const env: NodeJS.ProcessEnv = placeholder ? wrapWithPlaceholder(baseEnv) : baseEnv;
  const includeArchived = options.includeArchived ?? false;

  const lenses: Lens[] = [];
  const errors: LensLoadError[] = [];

  for (const categoryEntry of readdirSyncSafe(root)) {
    const categoryPath = join(root, categoryEntry);
    if (!isDir(categoryPath)) continue;

    // Skip `_template/`, `_archive/` (unless includeArchived), and any
    // directory starting with `.`.
    if (categoryEntry.startsWith(".")) continue;
    if (categoryEntry === "_template") continue;
    if (categoryEntry === "_archive" && !includeArchived) continue;

    for (const lensEntry of readdirSyncSafe(categoryPath)) {
      const lensPath = join(categoryPath, lensEntry);
      if (!isDir(lensPath)) continue;
      if (lensEntry.startsWith(".") || lensEntry.startsWith("_")) continue;

      const relativePath = relative(root, lensPath);
      try {
        const lens = loadSingleLens({
          name: lensEntry,
          relativePath,
          absolutePath: lensPath,
          now,
          env,
        });
        lenses.push(lens);
      } catch (err) {
        errors.push({
          name: lensEntry,
          relativePath,
          errors: extractErrorLines(err),
        });
      }
    }
  }

  // Deterministic ordering makes CLI output stable and tests simpler.
  lenses.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  errors.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { lenses, errors };
}

interface SingleLensContext {
  name: string;
  relativePath: string;
  absolutePath: string;
  now: () => Date;
  env: NodeJS.ProcessEnv;
}

function loadSingleLens(ctx: SingleLensContext): Lens {
  const configPath = join(ctx.absolutePath, "config.yaml");
  const readmePath = join(ctx.absolutePath, "README.md");

  let configText: string;
  try {
    configText = readFileSync(configPath, "utf8");
  } catch {
    throw new Error(`missing config.yaml at ${configPath}`);
  }
  let readmeText: string;
  try {
    readmeText = readFileSync(readmePath, "utf8");
  } catch {
    throw new Error(`missing README.md at ${readmePath}`);
  }

  // --- config.yaml ---------------------------------------------------
  let rawConfig: unknown;
  try {
    rawConfig = loadYaml(configText);
  } catch (err) {
    throw new Error(`config.yaml failed to parse: ${errorMessage(err)}`, { cause: err });
  }
  const substituted = substituteEnv(rawConfig, ctx.env);
  const config = validateConfig(substituted);

  // --- README.md frontmatter -----------------------------------------
  const { frontmatter, body } = splitFrontmatter(readmeText);
  if (frontmatter === null) {
    throw new Error(`README.md is missing YAML frontmatter`);
  }
  let parsedFm: unknown;
  try {
    parsedFm = loadYaml(frontmatter);
  } catch (err) {
    throw new Error(`README.md frontmatter failed to parse: ${errorMessage(err)}`, {
      cause: err,
    });
  }
  const metadataResult = LensMetadataSchema.safeParse(parsedFm);
  if (!metadataResult.success) {
    const issues = metadataResult.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`README.md frontmatter is invalid:\n${issues}`);
  }
  const metadata = metadataResult.data;

  // --- derived stale flag --------------------------------------------
  const isStale = computeStale(metadata, ctx.now());

  return {
    name: ctx.name,
    relativePath: ctx.relativePath,
    absolutePath: ctx.absolutePath,
    config,
    metadata,
    readme: body,
    isStale,
  };
}

/**
 * Declared status plus derived "is the tested-at date past the
 * threshold." A lens that was `active` but tested too long ago is
 * surfaced as stale; explicitly-archived lenses are never "stale"
 * because they are already past that lifecycle.
 */
function computeStale(metadata: LensMetadata, now: Date): boolean {
  if (metadata.status !== "active") return false;
  const tested = new Date(`${metadata.testedAt}T00:00:00Z`);
  if (Number.isNaN(tested.getTime())) return false;
  const ageMs = now.getTime() - tested.getTime();
  const thresholdMs = STALE_THRESHOLD_MONTHS * 30 * 24 * 60 * 60 * 1000;
  return ageMs > thresholdMs;
}

/**
 * Split a markdown document into (optional) YAML frontmatter plus body.
 * Returns frontmatter as the raw YAML string (without the --- fences).
 */
export function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  // Must start with `---\n` (accept \r\n as well for cross-platform sanity).
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { frontmatter: null, body: text };
  const body = text.slice(match[0].length);
  return { frontmatter: match[1] ?? "", body };
}

/**
 * Wrap an environment so that reading an undefined variable returns a
 * non-empty placeholder string. Used during validation / `lenses list`
 * / `lenses show` so that lenses whose secrets are configured per-user
 * at runtime still validate structurally.
 */
function wrapWithPlaceholder(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return new Proxy({} as NodeJS.ProcessEnv, {
    get(_target, prop: string | symbol): string | undefined {
      if (typeof prop !== "string") return undefined;
      const value = base[prop];
      if (value !== undefined && value !== "") return value;
      return `<UNSET:${prop}>`;
    },
    has(_target, prop) {
      return typeof prop === "string";
    },
    ownKeys() {
      return Reflect.ownKeys(base);
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop !== "string") return undefined;
      const value = base[prop] ?? `<UNSET:${prop}>`;
      return { enumerable: true, configurable: true, value };
    },
  });
}

function readdirSyncSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function extractErrorLines(err: unknown): string[] {
  if (err instanceof Error) {
    return err.message
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
  }
  return [String(err)];
}
