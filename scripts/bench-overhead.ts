#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * bench:overhead — measure the in-process overlay latency JanuScope adds per
 * `tools/call` cycle.
 *
 * This is a pure-CPU microbenchmark: it drives the {@link Pipeline} directly,
 * no child processes, no network, no LLM. The point is to answer a question
 * we have been repeating without a number: **"how much wall-clock overhead
 * does the JanuScope pipeline add to a round-trip?"**
 *
 * We measure four configurations, each over N iterations, and report
 * median / p95 / max per-cycle latency plus the arithmetic mean.
 * A "cycle" is `handleClientMessage(request)` followed by
 * `handleServerMessage(response)` — what the stdio bridge does on every
 * tools/call.
 *
 * Run:
 *   npm run bench:overhead             # default N = 10,000 iterations
 *   npm run bench:overhead -- --n 5000 # override iteration count
 *   npm run bench:overhead -- --json   # machine-readable output
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { buildOverlays } from "../src/index.js";
import { Pipeline, type Overlay } from "../src/pipeline.js";
import type { OverlayConfig } from "../src/config.js";
import type { JsonRpcMessage } from "../src/rpc.js";

interface CliArgs {
  n: number;
  json: boolean;
}

interface RunResult {
  scenario: string;
  overlays: string[];
  iterations: number;
  totalMs: number;
  meanUs: number;
  medianUs: number;
  p95Us: number;
  maxUs: number;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { n: 10_000, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--n") {
      const next = argv[++i];
      if (!next) throw new Error("--n requires a number");
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--n must be a positive integer, got ${next}`);
      }
      out.n = parsed;
    } else if (arg === "--json") {
      out.json = true;
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write("Usage: npm run bench:overhead [-- --n <iterations>] [--json]\n");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

/**
 * Representative multi-overlay config covering the full pipeline.
 * `auditSink` is per-run so audit-overlay traffic doesn't spam the terminal.
 */
function allOverlaysConfig(auditSink: string): OverlayConfig {
  // Cap the benchmark's rate limit high enough that the token-bucket
  // refill loop is the only thing measured — not the reject path.
  // (Benchmarks that measure error paths are a separate scenario we
  // haven't asked for.)
  return {
    target: { command: "does-not-matter" },
    block: ["dangerous_delete", "admin_*"],
    instructions: "READ-ONLY. Do not enumerate users.",
    audit: { sink: auditSink, logRawArgs: false },
    rateLimit: [{ tool: "*", perMinute: 1_000_000 }],
    redact: {
      rules: [{ regex: "\\b\\d{3}-\\d{2}-\\d{4}\\b" }, { field: "**.email" }],
      replacement: "[REDACTED]",
      applyTo: "text",
    },
    sqlGuard: {
      tools: ["query"],
      sqlArg: "sql",
      readOnly: true,
      mode: "allowlist",
    },
  };
}

/** A plausible response body — a row of JSON-in-text that exercises redact. */
const SAMPLE_RESPONSE: JsonRpcMessage = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          rows: [
            { id: 1, name: "Alice", email: "alice@example.com", ssn: "111-22-3333" },
            { id: 2, name: "Bob", email: "bob@example.com" },
            { id: 3, name: "Carol", email: "carol@example.com" },
          ],
        }),
      },
    ],
  },
};

const SAMPLE_REQUEST: JsonRpcMessage = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "query", arguments: { sql: "SELECT id, name FROM users LIMIT 10" } },
};

async function runScenario(
  label: string,
  overlayNames: string[],
  overlays: Overlay[],
  iterations: number,
): Promise<RunResult> {
  const samples: number[] = new Array(iterations);
  const pipeline = new Pipeline(overlays, {
    onForwardToTarget: () => {},
    onForwardToClient: () => {},
    // Silence: we measure cost, not noise.
    log: () => {},
  });
  await pipeline.start();

  // Warm-up — let v8 optimise, ignore the first few thousand iterations of
  // jitter. 500 is enough on Node 20; scales with the scenario complexity.
  for (let i = 0; i < 500; i++) {
    await pipeline.handleClientMessage(SAMPLE_REQUEST);
    await pipeline.handleServerMessage(SAMPLE_RESPONSE);
  }

  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await pipeline.handleClientMessage(SAMPLE_REQUEST);
    await pipeline.handleServerMessage(SAMPLE_RESPONSE);
    samples[i] = performance.now() - start;
  }
  const totalMs = performance.now() - t0;

  await pipeline.stop();

  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)] ?? 0;
  const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
  const max = samples[samples.length - 1] ?? 0;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;

  return {
    scenario: label,
    overlays: overlayNames,
    iterations,
    totalMs: round(totalMs, 2),
    meanUs: round(mean * 1000, 2),
    medianUs: round(median * 1000, 2),
    p95Us: round(p95 * 1000, 2),
    maxUs: round(max * 1000, 2),
  };
}

function round(n: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "januscope-bench-"));
  const auditSink = join(tmpDir, "audit.jsonl");
  const full = allOverlaysConfig(auditSink);
  const scenarios: Array<{ label: string; overlays: Overlay[] }> = [
    { label: "no overlays (baseline)", overlays: [] },
    {
      label: "block only",
      overlays: buildOverlays({ target: full.target, block: full.block }),
    },
    {
      label: "redact only",
      overlays: buildOverlays({ target: full.target, redact: full.redact }),
    },
    {
      label: "audit only",
      overlays: buildOverlays({ target: full.target, audit: full.audit }),
    },
    {
      label: "sqlGuard only",
      overlays: buildOverlays({ target: full.target, sqlGuard: full.sqlGuard }),
    },
    {
      label: "rateLimit only",
      overlays: buildOverlays({ target: full.target, rateLimit: full.rateLimit }),
    },
    // dbSchema is excluded deliberately — its per-request work is only
    // the tools/list rewrite, but the startup path requires a live DB
    // connection to introspect. Setup cost is documented separately
    // (~50–300 ms one-time at startup); steady-state per-call is just
    // the tools/list map which runs once per session.
    { label: "all overlays (no dbSchema)", overlays: buildOverlays(full) },
  ];

  const results: RunResult[] = [];
  for (const s of scenarios) {
    const overlayNames = s.overlays.map((o) => o.name);
    const r = await runScenario(s.label, overlayNames, s.overlays, args.n);
    results.push(r);
  }

  if (args.json) {
    process.stdout.write(
      JSON.stringify({ iterations: args.n, scenarios: results }, null, 2) + "\n",
    );
    // Clean up before the early return; otherwise --json mode leaks
    // an audit-sink temp dir on every run.
    rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  process.stdout.write(`JanuScope overlay overhead — ${args.n.toLocaleString()} iterations\n`);
  process.stdout.write(`Node ${process.version} · ${process.platform}/${process.arch}\n`);
  process.stdout.write(
    "Measures a full tools/call cycle (client→target + server→client) through Pipeline.\n\n",
  );
  const cols = [
    ["scenario", 28],
    ["median µs", 10],
    ["p95 µs", 10],
    ["mean µs", 10],
    ["max µs", 10],
  ] as const;
  process.stdout.write(
    cols.map(([c, w]) => c.padEnd(w)).join("  ") +
      "\n" +
      cols.map(([, w]) => "-".repeat(w)).join("  ") +
      "\n",
  );
  for (const r of results) {
    const row = [
      r.scenario,
      r.medianUs.toFixed(2),
      r.p95Us.toFixed(2),
      r.meanUs.toFixed(2),
      r.maxUs.toFixed(2),
    ];
    process.stdout.write(row.map((v, i) => v.padEnd(cols[i]![1])).join("  ") + "\n");
  }
  process.stdout.write(
    "\nNote: numbers exclude MCP child-process IO (which dominates real requests).\n" +
      "They represent the CPU cost the pipeline itself adds on top of that IO.\n",
  );

  // Clean up the ephemeral audit sink.
  rmSync(tmpDir, { recursive: true, force: true });
}

void main().catch((err) => {
  process.stderr.write(
    `bench:overhead failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
