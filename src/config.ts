// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * YAML/JSON config loader and validator.
 *
 * Supports environment variable substitution in string values using
 * ${VAR} or $VAR syntax. Missing variables become empty strings and
 * the first occurrence of each name triggers a one-line warning on
 * stderr — we don't refuse to start, since the user may be
 * intentionally testing with undefined vars, but a silent empty
 * substitution into a connection string is the kind of thing that
 * wastes 30 minutes at 2am.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { load as loadYaml } from "js-yaml";
import { z } from "zod";

/** The audit sink can be a well-known stream or a file path. */
const AuditSinkSchema = z.string().min(1);

const TargetSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
});

const BlockRuleSchema = z.string().min(1);

/**
 * `instructions` accepts either a plain string (legacy / common case)
 * or an object form `{ text, position }`. The string form keeps
 * backwards compatibility with existing lenses; the object form lets
 * a lens lead with the policy via `position: "prepend"`.
 */
const InstructionsObjectSchema = z.object({
  text: z.string(),
  position: z.enum(["prepend", "append"]).optional().default("append"),
});
const InstructionsSchema = z.union([z.string(), InstructionsObjectSchema]);

const AuditOptionsSchema = z.object({
  sink: AuditSinkSchema,
  logRawArgs: z.boolean().optional().default(false),
});

const DbSchemaOptionsSchema = z
  .object({
    driver: z.enum(["postgres", "mysql", "sqlite"]).optional(),
    connectionString: z.string().min(1),
    tables: z.array(z.string()).optional(),
    excludeTables: z.array(z.string()).optional(),
    /**
     * Postgres only: which schemas (namespaces) to introspect. Defaults
     * to `["public"]` when omitted. Multi-schema deployments (e.g.
     * `analytics`, `core`, `app`) can list any combination. Ignored by
     * the mysql and sqlite drivers — they have a single implicit
     * schema per connection.
     */
    schemas: z.array(z.string().min(1)).min(1).optional(),
    injectInto: z.array(z.string()).optional(),
    format: z.enum(["markdown", "ddl", "compact"]).optional().default("markdown"),
    includeComments: z.boolean().optional().default(true),
    refresh: z.enum(["startup", "never"]).optional().default("startup"),
  })
  .refine((v) => !(v.tables && v.excludeTables), {
    message: "dbSchema.tables and dbSchema.excludeTables are mutually exclusive",
  });

/**
 * A redact rule is either `{ regex: "..." }` or `{ field: "..." }` but
 * never both, never neither. Instead of `z.union` (which collapses bad
 * input into "Invalid input"), we preprocess the raw object to tag it
 * with a `kind` discriminator, run it through `z.discriminatedUnion`
 * for a targeted per-branch error, then strip the tag so downstream
 * consumers still see the original `{ regex }` / `{ field }` shape.
 */
const RedactRuleSchema = z.preprocess(
  (raw) => {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      const hasRegex = Object.prototype.hasOwnProperty.call(obj, "regex");
      const hasField = Object.prototype.hasOwnProperty.call(obj, "field");
      if (hasRegex && !hasField) return { kind: "regex", regex: obj.regex };
      if (hasField && !hasRegex) return { kind: "field", field: obj.field };
    }
    // Fallthrough: surface a discriminator-missing error from zod.
    return raw;
  },
  z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("regex"), regex: z.string().min(1) }),
      z.object({ kind: z.literal("field"), field: z.string().min(1) }),
    ])
    .transform((v) =>
      v.kind === "regex" ? ({ regex: v.regex } as const) : ({ field: v.field } as const),
    ),
);

const RedactOptionsSchema = z.object({
  rules: z.array(RedactRuleSchema).min(1),
  replacement: z.string().optional().default("[REDACTED]"),
  applyTo: z.enum(["text", "all", "fields"]).optional().default("text"),
});

const SqlGuardOptionsSchema = z.object({
  tools: z.array(z.string().min(1)).min(1),
  sqlArg: z.string().optional().default("sql"),
  readOnly: z.boolean().optional().default(true),
  mode: z.enum(["allowlist", "denylist"]).optional().default("allowlist"),
  extraWriteKeywords: z.array(z.string().min(1)).optional(),
  extraReadVerbs: z.array(z.string().min(1)).optional(),
});

const RateLimitRuleSchema = z.object({
  tool: z.string().min(1),
  /**
   * Accepts either `perMinute` (camelCase, canonical) or `per_minute`
   * (snake_case, familiar from the README and the rate-limit vocabulary).
   * YAML tends to look more natural with snake_case; internally we
   * normalise to `perMinute`.
   */
  perMinute: z.number().positive().finite().optional(),
  per_minute: z.number().positive().finite().optional(),
});

const RateLimitSchema = z
  .array(RateLimitRuleSchema)
  .min(1)
  .transform((rules, ctx) =>
    rules.map((r) => {
      // Reject rules that set BOTH keys. Silently picking one would mask
      // an almost-certain copy-paste mistake during a snake_case ↔
      // camelCase migration. One must be specified, not both.
      if (r.perMinute !== undefined && r.per_minute !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `rateLimit rule for '${r.tool}' sets both perMinute and per_minute — pick exactly one`,
        });
        return z.NEVER;
      }
      const limit = r.perMinute ?? r.per_minute;
      if (limit === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `rateLimit rule for '${r.tool}' must set perMinute (or per_minute)`,
        });
        return z.NEVER;
      }
      return { tool: r.tool, perMinute: limit };
    }),
  );

/**
 * Data-sensitivity label for the lens. Open-Edison-inspired. When
 * set, the `instructions` overlay prepends a classification banner
 * to the policy text it injects, and the `audit` overlay tags every
 * record with the value. Purely informational at the proxy layer —
 * the enforcement is still `block` / `sqlGuard` / `redact`.
 */
const ClassificationSchema = z.enum(["public", "internal", "sensitive"]);

/**
 * Optional telemetry configuration. When `telemetry.otel` is set, the
 * pipeline emits OpenTelemetry spans via the OTLP-HTTP exporter. Peer
 * deps (`@opentelemetry/api`, `@opentelemetry/sdk-trace-base`,
 * `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/resources`)
 * are loaded lazily — the default install doesn't pull them in.
 */
const OtelSchema = z.object({
  endpoint: z.string().url(),
  serviceName: z.string().min(1).optional(),
  headers: z.record(z.string()).optional(),
});

const TelemetrySchema = z.object({
  otel: OtelSchema.optional(),
});

/**
 * First-use quarantine mode. When set to `"approve"`, the runtime
 * computes a fingerprint of the static lens surface and refuses to
 * start if the current surface doesn't match the previously-approved
 * one in `~/.januscope/approved.json`. Defends against tool-poisoning
 * where a malicious upstream adds a tool between runs.
 */
const FirstRunSchema = z.enum(["approve"]);

/**
 * Static "context injection": glue arbitrary text into the description
 * of named tools at startup. Same end goal as `dbSchema` (give the
 * LLM stable context up-front so it doesn't burn round-trips on
 * discovery), but the text comes from the operator instead of from
 * a live DB introspection.
 *
 * Two ways to supply the text, mutually exclusive:
 *   - `text`: inline string in the YAML. Best for short / readable
 *     contexts (a list of project names, a glossary, a short policy
 *     reminder).
 *   - `textFile`: path to a file. Best for long / templated contexts
 *     or text that an external job (cron, CI, a homegrown script)
 *     keeps fresh. Relative paths resolve against the lens config
 *     file's directory; `~/...` expands to the home directory;
 *     absolute paths are used as-is.
 */
const ContextInjectionSchema = z
  .object({
    /** Tool names whose description receives the text. At least one. */
    injectInto: z.array(z.string().min(1)).min(1),
    /** Inline text. Mutually exclusive with `textFile`. */
    text: z.string().min(1).optional(),
    /** Path to a file. Mutually exclusive with `text`. */
    textFile: z.string().min(1).optional(),
    /**
     * Whether the text appends after the upstream description (default)
     * or prepends before it. Append usually reads better for the LLM
     * because the upstream's tool semantics come first.
     */
    position: z.enum(["prepend", "append"]).optional().default("append"),
  })
  .refine((v) => (v.text == null) !== (v.textFile == null), {
    message:
      "contextInjection: exactly one of `text` (inline) or `textFile` (file path) must be set",
  });

export const OverlayConfigSchema = z.object({
  target: TargetSchema,
  classification: ClassificationSchema.optional(),
  firstRun: FirstRunSchema.optional(),
  block: z.array(BlockRuleSchema).optional(),
  instructions: InstructionsSchema.optional(),
  audit: AuditOptionsSchema.optional(),
  dbSchema: DbSchemaOptionsSchema.optional(),
  contextInjection: ContextInjectionSchema.optional(),
  redact: RedactOptionsSchema.optional(),
  rateLimit: RateLimitSchema.optional(),
  sqlGuard: SqlGuardOptionsSchema.optional(),
  telemetry: TelemetrySchema.optional(),
});

export type OverlayConfig = z.infer<typeof OverlayConfigSchema>;
export type TargetConfig = z.infer<typeof TargetSchema>;
export type AuditOptions = z.infer<typeof AuditOptionsSchema>;
export type DbSchemaOptions = z.infer<typeof DbSchemaOptionsSchema>;
export type ContextInjectionOptions = z.infer<typeof ContextInjectionSchema>;
export type RedactOptions = z.infer<typeof RedactOptionsSchema>;
export type RedactRule = z.infer<typeof RedactRuleSchema>;
export type SqlGuardOptions = z.infer<typeof SqlGuardOptionsSchema>;
export type RateLimitRules = z.infer<typeof RateLimitSchema>;
export type Classification = z.infer<typeof ClassificationSchema>;
export type TelemetryOptions = z.infer<typeof TelemetrySchema>;

/**
 * Load, parse, substitute env vars, and validate a config file.
 *
 * **Sync-only path.** If the config contains `${vault://â¦}`,
 * `${aws-sm://â¦}`, or `${1pw://â¦}` references, the sync loader
 * refuses to proceed â use {@link loadConfigAsync} for those.
 * Callers that only care about `${VAR}` keep the sync API.
 */
export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): OverlayConfig {
  const resolved = expandHome(path);
  const raw = readFileSync(resolved, "utf8");
  const parsed = parseYamlOrJson(raw, resolved);
  if (detectSecretRefs(parsed).length > 0) {
    throw new Error(
      "januscope: config references a secret backend (vault://, aws-sm://, or 1pw://). " +
        "Use loadConfigAsync (async) instead of loadConfig (sync) to resolve those " +
        "references at load time.",
    );
  }
  const substituted = substituteEnv(parsed, env, { onMissing: createStderrWarnOnMissing() });
  resolveLensRelativePaths(substituted, resolved);
  return validateConfig(substituted);
}

/**
 * Async version of {@link loadConfig}. Resolves any
 * `${vault://â¦}` / `${aws-sm://â¦}` / `${1pw://â¦}` references via
 * the backend SDKs (see `./secrets.ts`) before validating. Falls
 * back to the sync path when no secret refs are present.
 */
export async function loadConfigAsync(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OverlayConfig> {
  const resolved = expandHome(path);
  const raw = readFileSync(resolved, "utf8");
  const parsed = parseYamlOrJson(raw, resolved);
  const refs = detectSecretRefs(parsed);
  let resolvers: Map<string, string> | undefined;
  if (refs.length > 0) {
    // Import lazily so plain-env configs don't pay the import cost
    // of the secrets module.
    const { resolveAllSecretRefs } = await import("./secrets.js");
    resolvers = await resolveAllSecretRefs(parsed);
  }
  const substituted = substituteEnv(parsed, env, {
    onMissing: createStderrWarnOnMissing(),
    ...(resolvers ? { resolvers } : {}),
  });
  resolveLensRelativePaths(substituted, resolved);
  return validateConfig(substituted);
}

/**
 * Rewrite path-like fields in the parsed config so a lens that ships
 * with `textFile: ./context.md` next to its `config.yaml` works
 * regardless of the operator's `cwd`. Relative paths resolve against
 * the lens config file's directory; `~/...` and absolute paths pass
 * through to the loader's own expansion at read time.
 *
 * Mutates in place to avoid re-cloning the parsed object. Called
 * after env substitution and before schema validation so the field
 * is already its final string by the time we touch it.
 */
function resolveLensRelativePaths(parsed: unknown, configFile: string): void {
  if (!parsed || typeof parsed !== "object") return;
  const obj = parsed as { contextInjection?: { textFile?: unknown } };
  const ci = obj.contextInjection;
  if (!ci || typeof ci !== "object") return;
  const tf = ci.textFile;
  if (typeof tf !== "string" || tf.length === 0) return;
  if (tf.startsWith("~")) return; // expandHome handles this at read time
  if (isAbsolute(tf)) return;
  ci.textFile = resolve(dirname(configFile), tf);
}

export interface SubstituteEnvOptions {
  /**
   * Called once per missing env-var name. The default implementation
   * (used by {@link loadConfig}) writes a single stderr line per name.
   * Pass a no-op callback to silence, or a custom sink to forward
   * into a structured logger.
   */
  onMissing?: (name: string) => void;
  /**
   * Pre-resolved map from secret-ref (`<scheme>://â¦`) to its value.
   * When a `${<scheme>://â¦}` reference appears in a string and is
   * present here, the reference is replaced with the mapped value.
   */
  resolvers?: Map<string, string>;
}

/** Validate an already-parsed object against the schema. */
export function validateConfig(input: unknown): OverlayConfig {
  const result = OverlayConfigSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`invalid januscope config:\n${issues}`);
  }
  // Catch the library-caller footgun where someone passes a parsed
  // YAML object straight to validateConfig and skips the async
  // loader. The secret refs would silently pass through as literal
  // strings and the pipeline would then try to connect to
  // "${vault://kv/prod/db#url}" — confusing error far from the
  // cause. Surface it here instead.
  const refs = detectSecretRefs(result.data);
  if (refs.length > 0) {
    const first = refs[0]!;
    const scheme = first.slice(0, first.indexOf("://"));
    throw new Error(
      `januscope: validateConfig received ${refs.length} unresolved secret ` +
        `reference(s) (scheme: ${scheme}://, …). Use loadConfigAsync to ` +
        `resolve them before validating, or pre-fill substituteEnv's ` +
        `'resolvers' option.`,
    );
  }
  return result.data;
}

function parseYamlOrJson(text: string, path: string): unknown {
  try {
    return loadYaml(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to parse config at ${path}: ${message}`, { cause: err });
  }
}

/**
 * Recursively substitute `${VAR}` and `$VAR` in string values. Missing
 * vars resolve to `""` and trigger `options.onMissing(name)` once per
 * distinct name. `onMissing` stays opt-in so direct callers (tests,
 * custom harnesses) can leave warnings off — {@link loadConfig} is
 * the path that wires up the default stderr warner.
 */
export function substituteEnv(
  value: unknown,
  env: NodeJS.ProcessEnv,
  options?: SubstituteEnvOptions,
): unknown {
  const onMissing = options?.onMissing;
  const resolvers = options?.resolvers;
  const recurse = (v: unknown): unknown => {
    if (typeof v === "string") return expandEnvString(v, env, onMissing, resolvers);
    if (Array.isArray(v)) return v.map(recurse);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
        out[k] = recurse(vv);
      }
      return out;
    }
    return v;
  };
  return recurse(value);
}

/**
 * Scan a parsed YAML/JSON value for every `<scheme>://â¦` reference
 * inside `${â¦}` wrappers. Returns them in document order with
 * duplicates â the secrets module dedupes before fetching.
 */
export function detectSecretRefs(value: unknown): string[] {
  const out: string[] = [];
  const scan = (s: string): void => {
    const re = /\$\{([^}\n]+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      const ref = m[1]!;
      if (/^[a-z0-9-]+:\/\//.test(ref)) out.push(ref);
    }
  };
  const walk = (v: unknown): void => {
    if (typeof v === "string") scan(v);
    else if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
    }
  };
  walk(value);
  return out;
}

/**
 * Captures either `${...}` (broad â any non-`}` sequence; the
 * replacer classifies it as env-var or secret-ref) or `$VAR`
 * (narrow â must be a plain identifier, so `$PATH/foo` keeps
 * behaving like the shell does).
 */
const REF_PATTERN = /\$\{([^}\n]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

function expandEnvString(
  str: string,
  env: NodeJS.ProcessEnv,
  onMissing?: (name: string) => void,
  resolvers?: Map<string, string>,
): string {
  return str.replace(
    REF_PATTERN,
    (_whole, braced: string | undefined, bare: string | undefined) => {
      if (braced !== undefined) {
        if (/^[a-z0-9-]+:\/\//.test(braced)) {
          // Secret reference. Only resolve when the caller supplied a
          // resolvers map; otherwise leave the literal in place (the
          // sync loadConfig path refuses before we ever get here).
          const val = resolvers?.get(braced);
          if (val !== undefined) return val;
          if (onMissing) onMissing(braced);
          return "";
        }
        // Ordinary env-var, tighter validation so typos don't silently
        // match.
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(braced)) {
          // Not a valid identifier and not a scheme:// reference â
          // leave as-is so the user sees the unchanged text and can
          // debug their config.
          return _whole as string;
        }
        const val = env[braced];
        if (val === undefined && onMissing) onMissing(braced);
        return val ?? "";
      }
      const name = bare ?? "";
      const val = env[name];
      if (val === undefined && onMissing) onMissing(name);
      return val ?? "";
    },
  );
}

function createStderrWarnOnMissing(): (name: string) => void {
  const seen = new Set<string>();
  return (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    process.stderr.write(
      `[januscope] warn: env var '${name}' is unset — substituted empty string\n`,
    );
  };
}

function expandHome(path: string): string {
  if (path === "~" || path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}
