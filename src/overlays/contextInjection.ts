// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * `contextInjection` overlay.
 *
 * The static-text counterpart to `dbSchema`. Where `dbSchema`
 * introspects a live database at startup and splices the result
 * into a SQL tool's description, this overlay takes operator-
 * supplied text (inline in the YAML, or from a file the operator
 * maintains) and splices it into the named tools' descriptions on
 * the way out.
 *
 * Use cases the dbSchema mechanism doesn't cover:
 *   - Linear / Atlassian: the small set of project / team / status
 *     enums the LLM needs before it can write a meaningful query.
 *   - Filesystem (tight root): a directory skeleton so the model
 *     stops walking `list_directory` for every read.
 *   - Any lens where the operator can pre-supply context and
 *     wants to skip discovery round-trips.
 *
 * Why this is "observer" not "gate": the worst case if the overlay
 * crashes is the LLM gets the upstream tool description without the
 * extra context — the model loses a shortcut, not a guardrail. So
 * the overlay should fail-open (consistent with `dbSchema` and
 * `instructions`).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { isSuccess, type JsonRpcMessage, type JsonRpcSuccess } from "../rpc.js";
import type { Overlay } from "../pipeline.js";

export interface ContextInjectionOptions {
  /** Tool names whose description receives the text. At least one. */
  injectInto: ReadonlyArray<string>;
  /** Inline text. Mutually exclusive with `textFile`. */
  text?: string;
  /**
   * Path to a file. Mutually exclusive with `text`. Path resolution
   * conventions:
   *   - Absolute path: used as-is.
   *   - `~/...` path: expanded to the user's home.
   *   - Relative path: the config loader resolves it against the
   *     lens config file's directory before this overlay sees it,
   *     so by the time we read it here it is already absolute. (If
   *     the overlay is constructed programmatically without going
   *     through the loader, a relative path falls back to
   *     resolution against `process.cwd()`.)
   */
  textFile?: string;
  /** Append (default) or prepend the text relative to the upstream description. */
  position?: "prepend" | "append";
}

/**
 * Tool shape we read from a `tools/list` response. Permissive: only
 * the `name` field is required, everything else passes through
 * unchanged.
 */
interface ToolLike {
  name: string;
  description?: string;
  [key: string]: unknown;
}

export function createContextInjectionOverlay(options: ContextInjectionOptions): Overlay {
  const text = resolveText(options);
  const targets = new Set(options.injectInto);
  const position = options.position ?? "append";

  // An empty / whitespace-only context is a config smell. We don't
  // throw because the operator may legitimately point at a file that
  // hasn't been populated yet (e.g. a cron just hasn't run); we just
  // become a no-op overlay.
  const isEmpty = text.trim().length === 0;

  return {
    name: "contextInjection",
    kind: "observer",
    setup(ctx) {
      if (isEmpty) {
        ctx.log(
          "warn",
          "context text is empty; overlay is a no-op until the source provides content",
        );
      }
    },
    onServerMessage(msg) {
      if (isEmpty || !isToolsListResult(msg)) {
        return { kind: "forward", msg };
      }
      const newTools = msg.result.tools.map((t) => maybeInject(t, targets, text, position));
      const transformed: JsonRpcSuccess = {
        ...msg,
        result: { ...msg.result, tools: newTools },
      };
      return { kind: "forward", msg: transformed };
    },
  };
}

function resolveText(options: ContextInjectionOptions): string {
  const hasInline = options.text != null;
  const hasFile = options.textFile != null;
  if (hasInline === hasFile) {
    // Schema-level validation already enforces XOR, but the overlay is
    // also a public construction site (library users can build it
    // bypassing the schema). Keep the runtime guard.
    throw new Error("contextInjection: exactly one of `text` or `textFile` must be set");
  }
  if (hasInline) {
    return options.text!;
  }
  const path = expandHome(options.textFile!);
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`contextInjection: could not read textFile ${path}: ${reason}`, {
      cause: err,
    });
  }
}

function expandHome(path: string): string {
  if (path === "~" || path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  // The loader already resolves relative paths against the lens
  // config directory; this fallback covers the programmatic-
  // construction case.
  return resolve(path);
}

function maybeInject(
  tool: ToolLike,
  targets: ReadonlySet<string>,
  text: string,
  position: "prepend" | "append",
): ToolLike {
  if (!targets.has(tool.name)) return tool;
  const existing = typeof tool.description === "string" ? tool.description : "";
  // Two newlines between the upstream description and the injected
  // text, so the LLM sees them as separate paragraphs in the
  // description rather than a run-on.
  const sep = existing.length > 0 ? "\n\n" : "";
  const description =
    position === "append" ? `${existing}${sep}${text}` : `${text}${sep}${existing}`;
  return { ...tool, description };
}

function isToolsListResult(msg: JsonRpcMessage): msg is JsonRpcSuccess & {
  result: { tools: ToolLike[] };
} {
  if (!isSuccess(msg)) return false;
  const result = msg.result;
  if (!result || typeof result !== "object") return false;
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return false;
  return tools.every((t) => t && typeof t === "object" && typeof (t as ToolLike).name === "string");
}
