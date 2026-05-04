// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * Optional OpenTelemetry tracing for the pipeline.
 *
 * When a lens sets `telemetry.otel`, each tools/call cycle emits:
 *   - one root span per `handleClientMessage` / `handleServerMessage`
 *     (named `januscope.client_message` / `januscope.server_message`)
 *   - one child span per overlay handler invocation
 *     (named `januscope.overlay.<overlayName>`)
 * with attributes for the JSON-RPC method, tool name, overlay outcome,
 * and — when set — the lens classification.
 *
 * All OpenTelemetry packages are OPTIONAL peer dependencies. When no
 * tracer is configured we return a shared no-op implementation that
 * compiles away to a few branchless function calls in the hot path
 * (see `bench:overhead` for the measured impact).
 */

import type { Classification } from "./config.js";

export interface OtelConfig {
  endpoint: string;
  serviceName?: string;
  /** Extra headers sent with every OTLP-HTTP request. */
  headers?: Record<string, string>;
}

export interface TelemetryConfig {
  otel?: OtelConfig;
}

export type SpanStatus = "ok" | "error";

/** Minimal interface the pipeline needs; not the full OTel API. */
export interface JanuScopeSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: SpanStatus, description?: string): void;
  recordError(err: unknown): void;
  end(): void;
}

export interface JanuScopeTracer {
  /** `true` when real spans are emitted; `false` for the no-op. */
  readonly enabled: boolean;
  startSpan(name: string, attrs?: Record<string, string | number | boolean>): JanuScopeSpan;
  /**
   * Start a span as a child of `parent`. Providers that don't support
   * parent linkage (the no-op) just return a regular span.
   */
  startChildSpan(
    parent: JanuScopeSpan,
    name: string,
    attrs?: Record<string, string | number | boolean>,
  ): JanuScopeSpan;
  /** Flush any buffered spans; must be awaited before process exit. */
  shutdown(): Promise<void>;
}

/* --------------------------------------------------------------------- */
/*  No-op implementation — zero network, constant branches, always safe. */
/* --------------------------------------------------------------------- */

const NOOP_SPAN: JanuScopeSpan = {
  setAttribute() {
    /* no-op */
  },
  setStatus() {
    /* no-op */
  },
  recordError() {
    /* no-op */
  },
  end() {
    /* no-op */
  },
};

export const NOOP_TRACER: JanuScopeTracer = {
  enabled: false,
  startSpan() {
    return NOOP_SPAN;
  },
  startChildSpan() {
    return NOOP_SPAN;
  },
  async shutdown() {
    /* no-op */
  },
};

/* --------------------------------------------------------------------- */
/*  OTel-backed implementation — loaded lazily, optional peer deps.       */
/* --------------------------------------------------------------------- */

/**
 * Create a real tracer from the OTel SDK. Lazily imports
 * `@opentelemetry/api` + `@opentelemetry/sdk-trace-base` +
 * `@opentelemetry/exporter-trace-otlp-http` so the default install
 * doesn't drag them in. Throws a readable error when those packages
 * aren't installed but `telemetry.otel` is set.
 */
export async function createOtelTracer(config: OtelConfig): Promise<JanuScopeTracer> {
  const { sdk, exporter, resource } = await loadOtelModules();

  const resourceInstance = resource.resourceFromAttributes({
    "service.name": config.serviceName ?? "januscope",
  });
  const provider = new sdk.BasicTracerProvider({
    resource: resourceInstance,
    spanProcessors: [
      new sdk.BatchSpanProcessor(
        new exporter.OTLPTraceExporter({
          url: config.endpoint,
          ...(config.headers ? { headers: config.headers } : {}),
        }),
      ),
    ],
  });
  // Explicitly DO NOT call `provider.register()`. That sets OTel's
  // global tracer provider, and OTel's `register()` is
  // first-writer-wins: if a host process (or the MCP client) has
  // already configured OTel, our registration is silently ignored
  // and our spans never leave the process. By pulling the tracer
  // directly from our provider, JanuScope's spans always reach our
  // exporter regardless of what the host did with the global. See
  // CodeRabbit review of 5855364.
  const tracer = provider.getTracer("januscope", "0");

  const wrapSpan = (otelSpan: {
    setAttribute(k: string, v: unknown): unknown;
    setStatus(s: { code: number; message?: string }): unknown;
    recordException(e: unknown): unknown;
    end(): unknown;
  }): JanuScopeSpan => ({
    setAttribute(key, value) {
      otelSpan.setAttribute(key, value);
    },
    setStatus(status, description) {
      // OTel status codes: UNSET=0, OK=1, ERROR=2.
      otelSpan.setStatus({
        code: status === "error" ? 2 : 1,
        ...(description ? { message: description } : {}),
      });
    },
    recordError(err) {
      otelSpan.recordException(
        err instanceof Error ? err : { name: "Error", message: String(err) },
      );
      otelSpan.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) });
    },
    end() {
      otelSpan.end();
    },
  });

  return {
    enabled: true,
    startSpan(name, attrs) {
      const span = tracer.startSpan(name, attrs ? { attributes: attrs } : {});
      return wrapSpan(span);
    },
    startChildSpan(parent, name, attrs) {
      // We don't thread OTel context through our minimal interface; the
      // parent relation is established via the active context when the
      // pipeline runs under OTel's propagation. For our hot path the
      // simplest useful behaviour is to start a fresh span with the
      // attributes — parent linkage comes from OTel's active context if
      // the host set one up. Consumers wanting strict parent spans can
      // use the raw OTel API directly.
      void parent;
      const span = tracer.startSpan(name, attrs ? { attributes: attrs } : {});
      return wrapSpan(span);
    },
    async shutdown() {
      await provider.shutdown();
    },
  };
}

interface OtelTracer {
  startSpan(
    name: string,
    options?: { attributes?: Record<string, string | number | boolean> },
  ): {
    setAttribute(k: string, v: unknown): unknown;
    setStatus(s: { code: number; message?: string }): unknown;
    recordException(e: unknown): unknown;
    end(): unknown;
  };
}

interface OtelModules {
  sdk: {
    BasicTracerProvider: new (opts: unknown) => {
      shutdown(): Promise<void>;
      getTracer(name: string, version?: string): OtelTracer;
    };
    BatchSpanProcessor: new (exporter: unknown) => unknown;
  };
  exporter: {
    OTLPTraceExporter: new (opts: unknown) => unknown;
  };
  resource: {
    resourceFromAttributes(attrs: Record<string, string>): unknown;
  };
}

async function loadOtelModules(): Promise<OtelModules> {
  // Fire every import in parallel and collect outcomes. If any fail,
  // list ALL missing specs in one error so the user doesn't have to
  // install-one-at-a-time to discover what else is missing.
  // Promise.all-style rejection names only the first failure, and the
  // order is not deterministic across resolver versions.
  const specs = [
    "@opentelemetry/sdk-trace-base",
    "@opentelemetry/exporter-trace-otlp-http",
    "@opentelemetry/resources",
  ] as const;
  const results = await Promise.allSettled(specs.map((spec) => import(spec)));

  const missing: Array<{ spec: string; reason: string }> = [];
  const modules: Record<string, unknown> = {};
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      missing.push({ spec: specs[i]!, reason });
    } else {
      modules[specs[i]!] = r.value;
    }
  });

  if (missing.length > 0) {
    const specList = missing.map((m) => m.spec).join(" ");
    const reasons = missing.map((m) => `  - ${m.spec}: ${m.reason}`).join("\n");
    throw new Error(
      `januscope: telemetry.otel is configured but ${missing.length} OpenTelemetry peer ` +
        `dependenc${missing.length === 1 ? "y is" : "ies are"} missing:\n${reasons}\n` +
        `Install with: npm install ${specList}`,
    );
  }

  return {
    sdk: modules["@opentelemetry/sdk-trace-base"] as OtelModules["sdk"],
    exporter: modules["@opentelemetry/exporter-trace-otlp-http"] as OtelModules["exporter"],
    resource: modules["@opentelemetry/resources"] as OtelModules["resource"],
  };
}

/* --------------------------------------------------------------------- */
/*  Attribute helpers                                                     */
/* --------------------------------------------------------------------- */

/** Build a flat attributes object for a pipeline-root span. */
export function messageAttributes(
  direction: "client" | "server",
  method: string | undefined,
  tool: string | undefined,
  classification: Classification | undefined,
): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {
    "januscope.direction": direction,
  };
  if (method) attrs["januscope.method"] = method;
  if (tool) attrs["januscope.tool"] = tool;
  if (classification) attrs["januscope.classification"] = classification;
  return attrs;
}
