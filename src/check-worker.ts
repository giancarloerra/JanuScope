// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { load as loadYaml } from "js-yaml";
import { resolveConfigArg } from "./cli.js";
import {
  detectSecretRefs,
  loadConfigAsync,
  OverlayConfigSchema,
  substituteEnv,
  type OverlayConfig,
} from "./config.js";
import { buildOverlays } from "./index.js";
import { Pipeline } from "./pipeline.js";
import { compileToolMatcher } from "./overlays/_shared.js";
import { DiagnosticPageLimitError, probeTarget } from "./probe.js";
import { isSuccess, type JsonRpcMessage } from "./rpc.js";
import type { CheckReport } from "./check.js";
import { startSupervisorWatchdog, stopDiagnosticProcessTree } from "./check-watchdog.js";

process.once("disconnect", stopDiagnosticProcessTree);
// The channel may have closed while this worker's modules were loading.
if (!process.connected) stopDiagnosticProcessTree();

class CheckFailure extends Error {}

const report: CheckReport = { ok: false, checks: [] };
let phase = "diagnostic startup";

function begin(name: string): void {
  phase = name;
  process.send?.({ phase, checks: report.checks });
}

function pass(name: string, message: string): void {
  report.checks.push({ name, status: "pass", message });
}

/** Error payloads and child stderr may contain credentials. Return only
 * validated system/driver error codes and known configuration locations. */
function describeFailure(error: unknown): string {
  if (error instanceof CheckFailure) return error.message;
  if (error instanceof DiagnosticPageLimitError)
    return `${phase} failed (${error.code}): ${error.message}.`;
  const codes: string[] = [];
  let current = error;
  for (let i = 0; i < 5 && current instanceof Error; i++) {
    if (current instanceof CheckFailure) return current.message;
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code)) codes.push(code);
    if (typeof code === "number" && Number.isFinite(code)) codes.push(String(code));
    if (current.message.includes("optional dependency 'pg'"))
      codes.push("install optional dependency pg");
    if (current.message.includes("optional dependency 'mysql2'"))
      codes.push("install optional dependency mysql2");
    if (current.message.includes("optional dependency 'better-sqlite3'"))
      codes.push("install optional dependency better-sqlite3");
    current = current.cause;
  }
  const detail = [...new Set(codes)].join(", ");
  return `${phase} failed${detail ? ` (${detail})` : ""}. Check this stage's configuration and access; raw error text is withheld because it may contain credentials.`;
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path);
}

function validateRawConfig(path: string): void {
  let parsed: unknown;
  try {
    parsed = loadYaml(readFileSync(path, "utf8"));
  } catch (error) {
    const mark = (error as { mark?: { line?: number; column?: number } }).mark;
    if (mark && typeof mark.line === "number") {
      throw new CheckFailure(
        `Invalid YAML/JSON syntax at line ${mark.line + 1}, column ${(mark.column ?? 0) + 1}.`,
      );
    }
    throw error;
  }
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (env[name] === "") delete env[name];
  const missing = new Set<string>();
  // Reuse the loader's reference parser. Backend placeholders are used only
  // for this required-env check, never for schema validation or execution.
  const references = detectSecretRefs(parsed);
  const substituted = substituteEnv(parsed, env, {
    onMissing: (name) => missing.add(name),
    resolvers: new Map(references.map((ref) => [ref, "check-reference-only"])),
  });
  if (missing.size) {
    throw new CheckFailure(
      `Required environment variables are unset or empty: ${[...missing].sort().join(", ")}.`,
    );
  }
  // Secret-backed values are validated by the real async loader after fetch.
  if (references.length > 0) return;
  const shape = OverlayConfigSchema.safeParse(substituted);
  if (!shape.success) {
    const locations = shape.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"} (${issue.code})`,
    );
    throw new CheckFailure(`Invalid configuration: ${locations.join(", ")}.`);
  }
}

function validateTarget(config: OverlayConfig): void {
  const target = config.target;
  const cwd = target.cwd ? resolve(target.cwd) : process.cwd();
  if (!statSync(cwd).isDirectory()) throw new CheckFailure("target.cwd is not a directory.");
  accessSync(cwd, constants.X_OK);
  const environment = { ...process.env, ...target.env };
  const pathKey =
    process.platform === "win32"
      ? Object.keys(environment)
          .sort()
          .find((key) => key.toUpperCase() === "PATH")
      : "PATH";
  const searchPath = pathKey ? environment[pathKey] : undefined;
  const hasSeparator =
    target.command.includes("/") || (process.platform === "win32" && target.command.includes("\\"));
  const bases =
    hasSeparator || isAbsolute(target.command)
      ? [resolve(cwd, target.command)]
      : (searchPath ?? (process.platform === "win32" ? "" : "/usr/bin:/bin"))
          .split(delimiter)
          .map((part) => resolve(cwd, part || ".", target.command));
  const candidates =
    process.platform === "win32"
      ? bases.flatMap((base) => [
          base,
          ...[".exe", ".com", ".cmd", ".bat"].map((extension) => base + extension),
        ])
      : bases;
  let inaccessible = false;
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES") inaccessible = true;
      else if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
  }
  throw new CheckFailure(
    inaccessible
      ? "Target executable exists but is not executable (EACCES)."
      : "Target executable was not found in the configured working directory or PATH (ENOENT).",
  );
}

async function run(): Promise<void> {
  const argument = process.argv[2];
  if (!argument) throw new CheckFailure("A config preset or path is required.");
  begin("configuration");
  let path: string;
  try {
    path = expandHome(resolveConfigArg(argument));
  } catch {
    throw new CheckFailure(
      "Preset could not be resolved. Run januscope lenses list or supply a YAML/JSON configuration path.",
    );
  }
  validateRawConfig(path);
  const config = await loadConfigAsync(path);
  pass("configuration", "Configuration and required environment references are valid.");
  report.policy = {
    sqlGuard: config.sqlGuard
      ? {
          tools: config.sqlGuard.tools,
          mode: config.sqlGuard.mode,
          readOnly: config.sqlGuard.readOnly,
        }
      : null,
    redact: config.redact
      ? { rules: config.redact.rules.length, applyTo: config.redact.applyTo }
      : null,
    audit: Boolean(config.audit),
    approvalRequired: config.firstRun === "approve",
  };

  begin("target prerequisites");
  validateTarget(config);
  pass(phase, "Target executable and working directory are accessible.");

  begin("overlay construction");
  // Audit and quarantine are intentionally reported, not exercised. Their
  // setup/live paths create records or approval state. Every other overlay is
  // constructed through the same production builder as runOverlay.
  const diagnosticConfig = { ...config };
  delete diagnosticConfig.audit;
  delete diagnosticConfig.firstRun;
  const overlays = buildOverlays(diagnosticConfig).map((overlay) => ({
    ...overlay,
    ...(overlay.setup
      ? {
          setup: async (
            context: Parameters<NonNullable<typeof overlay.setup>>[0],
          ): Promise<void> => {
            begin(`${overlay.name} startup`);
            await overlay.setup!(context);
            pass(
              phase,
              overlay.name === "dbSchema"
                ? "Optional driver loaded; actual database connection and schema introspection completed."
                : "Configured context initialized successfully.",
            );
          },
        }
      : {}),
  }));
  pass(phase, "Configured policy rules and context sources load successfully.");
  let transformed: JsonRpcMessage | undefined;
  const pipeline = new Pipeline(overlays, {
    onForwardToClient: (message) => {
      transformed = message;
    },
    onForwardToTarget: () => {
      throw new CheckFailure("Diagnostic policy validation attempted a target request.");
    },
    log: (level, scope) => {
      if (level === "error" || level === "warn") {
        throw new CheckFailure(
          `${scope} reported ${level}; configuration or source content needs attention.`,
        );
      }
    },
  });
  await pipeline.start();

  begin("MCP handshake");
  const probed = await probeTarget(config, { verifyProtocol: true });
  pass(phase, "initialize, notifications/initialized and every tools/list page completed.");
  const liveNames = probed.tools.map((tool) => tool.name);
  const blockMatchers = (config.block ?? []).map(compileToolMatcher);
  const blocked = liveNames.filter((name) => blockMatchers.some((matches) => matches(name)));
  const allowed = liveNames.filter((name) => !blocked.includes(name));
  report.tools = { allowed, blocked };

  begin("policy coverage");
  const required: Array<[string, string[]]> = [];
  if (config.sqlGuard) required.push(["sqlGuard.tools", config.sqlGuard.tools]);
  if (config.dbSchema)
    required.push([
      "dbSchema.injectInto",
      config.dbSchema.injectInto ?? [
        "query",
        "execute",
        "execute_sql",
        "search",
        "pg_query",
        "mysql_query",
        "sql",
      ],
    ]);
  if (config.contextInjection)
    required.push(["contextInjection.injectInto", config.contextInjection.injectInto]);
  for (const [name, configured] of required) {
    if (!configured.some((tool) => allowed.includes(tool))) {
      report.checks.push({
        name,
        status: "fail",
        message: "No configured tool matches an allowed live tool.",
      });
    }
  }
  const unmatched = (config.block ?? []).filter(
    (rule) => !liveNames.some(compileToolMatcher(rule)),
  );
  if (unmatched.length)
    report.checks.push({
      name: "block rules",
      status: "info",
      message: `${unmatched.length} defensive rule(s) do not match this live tool list.`,
    });

  // Process the observed live list through the production overlays and the
  // same state that was initialized above; no synthetic tool call is made.
  await pipeline.handleServerMessage({ jsonrpc: "2.0", id: 1, result: { tools: probed.tools } });
  await pipeline.stop();
  if (!transformed || !isSuccess(transformed))
    throw new CheckFailure("The configured response policy refused the live tool list.");
  const clientTools = (transformed.result as { tools?: unknown })?.tools;
  if (
    !Array.isArray(clientTools) ||
    clientTools.length !== allowed.length ||
    !clientTools.every(
      (tool: unknown, index: number) =>
        tool && typeof tool === "object" && (tool as { name?: unknown }).name === allowed[index],
    )
  ) {
    throw new CheckFailure(
      "Configured response overlays changed the expected live tool names; tool routing needs attention.",
    );
  }
  if (!report.checks.some((check) => check.status === "fail")) {
    pass(phase, "Configured critical tool targets match the allowed live surface.");
  }
  report.ok = !report.checks.some((check) => check.status === "fail");
}

void startSupervisorWatchdog()
  .then(run)
  .catch((error: unknown) => {
    report.checks.push({ name: phase, status: "fail", message: describeFailure(error) });
  })
  .finally(() => {
    process.send?.({ report });
    // Keep the worker alive while its supervisor owns process-group cleanup,
    // including descendants that ignored the probe's graceful stop. Lost IPC
    // transfers that cleanup to the worker and its independent watchdog.
    setInterval(() => {}, 1000);
  });
