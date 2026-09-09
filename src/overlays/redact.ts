// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * `redact` overlay.
 *
 * Scrubs tool-call responses before they leave the overlay. Two rule types:
 *
 * - `regex: <pattern>` - applied to every text value in the payload.
 * - `field: <path>`   - applied to JSON structures (usually
 *                        `structuredContent`) matching a dotted path
 *                        with `*` (one level) and `**` (any depth).
 *
 * This overlay runs AFTER `audit` in the server->client direction, which
 * means the audit log sees un-redacted data (useful for incident review)
 * while the LLM only sees scrubbed output. See docs/specs/spec-v0.3.md.
 */

import type { Overlay } from "../pipeline.js";
import { isResponse, type JsonRpcErrorBody } from "../rpc.js";
import { redactPythonLiteral } from "./python-literal.js";

export type RedactRule = { regex: string } | { field: string };

export type ApplyTo = "text" | "all" | "fields";

export interface RedactOverlayOptions {
  rules: ReadonlyArray<RedactRule>;
  replacement?: string;
  applyTo?: ApplyTo;
}

interface CompiledRules {
  regexes: RegExp[];
  fieldPatterns: FieldPattern[];
}

export function createRedactOverlay(options: RedactOverlayOptions): Overlay {
  const compiled = compileRules(options.rules);
  const replacement = options.replacement ?? "[REDACTED]";
  const applyTo: ApplyTo = options.applyTo ?? "text";

  return {
    name: "redact",
    kind: "gate",
    onServerMessage(msg) {
      const hasResult = "result" in msg;
      const hasError = "error" in msg;
      if (!hasResult && !hasError) {
        return { kind: "forward", msg };
      }
      if (!isResponse(msg) || hasResult === hasError) {
        throw new TypeError("redact: ambiguous response envelope");
      }
      if ("error" in msg) {
        const error = scrubError(msg.error, compiled, replacement);
        return { kind: "forward", msg: { ...msg, error } };
      }
      const result = scrubResult(msg.result, compiled, replacement, applyTo);
      return { kind: "forward", msg: { ...msg, result } };
    },
  };
}

function scrubError(
  error: JsonRpcErrorBody,
  rules: CompiledRules,
  replacement: string,
): JsonRpcErrorBody {
  if (
    !error ||
    typeof error !== "object" ||
    Array.isArray(error) ||
    !Number.isFinite(error.code) ||
    typeof error.message !== "string"
  ) {
    throw new TypeError("redact: invalid error response");
  }
  const payload = structuredCloneCompat(error) as unknown as Record<string, unknown>;
  applyFieldRules(payload, rules.fieldPatterns, replacement);
  // Both error-relative paths (data.email) and data-relative paths
  // (email) work; recursive presets such as **.email cover either.
  if (payload.data && typeof payload.data === "object") {
    applyFieldRules(payload.data as Record<string, unknown>, rules.fieldPatterns, replacement);
  }
  scrubStrings(payload, (text) => scrubText(text, rules, replacement));
  // Policy fields must never rewrite JSON-RPC's numeric control code.
  return { ...payload, code: error.code } as unknown as JsonRpcErrorBody;
}

function scrubStrings(node: unknown, scrub: (text: string) => string): void {
  if (!node || typeof node !== "object") return;
  const object = node as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    const value = object[key];
    if (typeof value === "string") object[key] = scrub(value);
    else scrubStrings(value, scrub);
  }
}

function scrubResult(
  result: unknown,
  rules: CompiledRules,
  replacement: string,
  applyTo: ApplyTo,
): unknown {
  if (typeof result === "string") return scrubText(result, rules, replacement);
  if (!result || typeof result !== "object") return result;

  // Deep clone so the original (held by the audit overlay upstream) is preserved.
  const cloned = structuredCloneCompat(result) as Record<string, unknown>;

  // 1. Apply field-path rules to the top-level result object. Works for
  //    MCPs that populate `structuredContent` or similar structured
  //    fields on the JSON-RPC result.
  if (rules.fieldPatterns.length > 0) {
    applyFieldRules(cloned, rules.fieldPatterns, replacement);
  }

  if (applyTo === "all") {
    scrubStrings(cloned, (text) => scrubText(text, rules, replacement));
  } else {
    // MCPs may duplicate text blocks inside structuredContent. Traverse
    // those copies too, while preserving the default non-text boundary.
    scrubTextBlocks(cloned, (text) => scrubText(text, rules, replacement));
  }

  return cloned;
}

function scrubTextBlocks(node: unknown, scrub: (text: string) => string): void {
  if (!node || typeof node !== "object") return;
  const object = node as Record<string, unknown>;
  if (object.type === "text" && typeof object.text === "string") {
    object.text = scrub(object.text);
  }
  for (const value of Object.values(object)) {
    if (value && typeof value === "object") scrubTextBlocks(value, scrub);
  }
}

function scrubText(text: string, rules: CompiledRules, replacement: string): string {
  if (rules.fieldPatterns.length > 0) {
    const json = tryParseJson(text);
    if (json) {
      const fieldsChanged = applyFieldRules(
        json.parsed as Record<string, unknown>,
        rules.fieldPatterns,
        replacement,
      );
      const normalized = json.pretty
        ? JSON.stringify(json.parsed, null, 2)
        : JSON.stringify(json.parsed);
      // Retain regex matching against decoded JSON escapes before deciding
      // that the original text can be forwarded without normalization.
      const redacted = applyRegexList(normalized, rules.regexes, replacement);
      if (fieldsChanged || redacted !== normalized) return redacted;
    } else {
      const embedded = extractEmbeddedJsonBlock(text);
      if (embedded) {
        const fieldsChanged = applyFieldRules(
          embedded.parsed as Record<string, unknown>,
          rules.fieldPatterns,
          replacement,
        );
        const normalizedJson = embedded.pretty
          ? JSON.stringify(embedded.parsed, null, 2)
          : JSON.stringify(embedded.parsed);
        const normalized = embedded.before + normalizedJson + embedded.after;
        const redacted = applyRegexList(normalized, rules.regexes, replacement);
        if (fieldsChanged || redacted !== normalized) return redacted;
      } else {
        const python = redactPythonLiteral(text, (root) =>
          applyFieldRules(root, rules.fieldPatterns, replacement),
        );
        if (python !== null) text = python;
      }
    }
  }
  return applyRegexList(text, rules.regexes, replacement);
}

/**
 * Cheap sniff: returns the parsed value if `text` (after trimming) is a
 * standalone JSON object or array, otherwise null. Scalars and partial
 * JSON are rejected — we don't want to misidentify a sentence starting
 * with `[` as a JSON array.
 */
function tryParseJson(text: string): { parsed: unknown; pretty: boolean } | null {
  const trimmed = text.trim();
  if (trimmed.length < 2) return null;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  const looksLikeObject = first === "{" && last === "}";
  const looksLikeArray = first === "[" && last === "]";
  if (!looksLikeObject && !looksLikeArray) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    // Preserve "pretty" formatting if the input had any newlines
    // between tokens.
    const pretty = /[\r\n]/.test(trimmed);
    return { parsed, pretty };
  } catch {
    return null;
  }
}

/**
 * Fallback for text that isn't pure JSON (the common shape for MCPs that
 * wrap their results in a narrative preamble + security-warning envelope,
 * e.g. the official MongoDB MCP). We attempt to isolate a single JSON
 * object or array embedded in the middle of the string by:
 *   1. Finding the first `{` or `[`, and
 *   2. Walking the string with a balanced-brace scanner that respects
 *      string literals and escapes.
 *
 * Returns `null` unless the candidate substring parses cleanly to an
 * object or array — we never redact off a scalar match. Conservative by
 * design: at most one JSON block is extracted per text block.
 */
function extractEmbeddedJsonBlock(
  text: string,
): { before: string; parsed: unknown; after: string; pretty: boolean } | null {
  const startIdx = text.search(/[{[]/);
  if (startIdx === -1) return null;
  const open = text[startIdx];
  const close = open === "{" ? "}" : "]";

  // Balanced scan honouring JSON string literals.
  let depth = 0;
  let inString = false;
  let escape = false;
  let endIdx = -1;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx === -1) return null;

  const candidate = text.slice(startIdx, endIdx + 1);
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    return {
      before: text.slice(0, startIdx),
      parsed,
      after: text.slice(endIdx + 1),
      pretty: /[\r\n]/.test(candidate),
    };
  } catch {
    return null;
  }
}

function applyRegexList(value: string, regexes: RegExp[], replacement: string): string {
  let out = value;
  // Use a replacer *function* so the configured replacement is treated
  // literally. Passing a string allows `$&`, `$1`, `$$`, etc. to be
  // interpreted as special patterns by String.prototype.replace, which
  // would leak captured matches into the scrubbed output — the exact
  // opposite of what this overlay promises.
  const replacer = (): string => replacement;
  for (const re of regexes) {
    out = out.replace(re, replacer);
  }
  return out;
}

/* ----------------------------- Field paths ----------------------------- */

type FieldSegment =
  | { kind: "literal"; name: string }
  | { kind: "one" } // *
  | { kind: "deep" } // **
  | { kind: "index"; index: number };

interface FieldPattern {
  segments: FieldSegment[];
}

function compileRules(rules: ReadonlyArray<RedactRule>): CompiledRules {
  const regexes: RegExp[] = [];
  const fieldPatterns: FieldPattern[] = [];
  for (const rule of rules) {
    if ("regex" in rule) {
      regexes.push(compileRegex(rule.regex));
    } else {
      fieldPatterns.push({ segments: compileFieldPath(rule.field) });
    }
  }
  return { regexes, fieldPatterns };
}

/**
 * Accepts either a bare JS-style pattern or a pattern with a leading
 * inline flag group like `(?i)`, `(?is)`, `(?m)` (common in PCRE /
 * Python / Go regex dialects that Lens authors reach for reflexively).
 * JavaScript's `RegExp` does not parse inline flags, so we strip the
 * leading group and translate its letters into the constructor's
 * `flags` argument. `g` is always on; unknown letters are rejected
 * with a helpful error so typos do not silently degrade.
 */
function compileRegex(pattern: string): RegExp {
  let flags = "g";
  let body = pattern;
  const inlineFlagsMatch = /^\(\?([a-zA-Z]+)\)/.exec(pattern);
  if (inlineFlagsMatch) {
    for (const ch of inlineFlagsMatch[1]!) {
      // Map PCRE-style single-letter flags to JS-RegExp equivalents.
      // `i` / `m` / `s` / `u` have direct counterparts; anything else
      // is rejected rather than silently dropped.
      if (ch === "i" || ch === "m" || ch === "s" || ch === "u") {
        if (!flags.includes(ch)) flags += ch;
      } else {
        throw new Error(
          `redact: unsupported inline-flag '${ch}' in regex '${pattern}' (supported: i, m, s, u)`,
        );
      }
    }
    body = pattern.slice(inlineFlagsMatch[0].length);
  }
  try {
    return new RegExp(body, flags);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`redact: invalid regex '${pattern}': ${msg}`, { cause: err });
  }
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function compileFieldPath(path: string): FieldSegment[] {
  const rawSegments = path.split(".");
  const segments: FieldSegment[] = [];
  for (const raw of rawSegments) {
    if (raw === "**") {
      segments.push({ kind: "deep" });
      continue;
    }
    if (raw === "*") {
      segments.push({ kind: "one" });
      continue;
    }
    let rest = raw;
    const firstBracket = rest.indexOf("[");
    if (firstBracket !== -1) {
      const head = rest.slice(0, firstBracket);
      if (head.length > 0) {
        if (!IDENT_RE.test(head)) {
          throw new Error(`redact: bad field path segment '${head}' in '${path}'`);
        }
        segments.push({ kind: "literal", name: head });
      }
      rest = rest.slice(firstBracket);
      while (rest.length > 0) {
        if (!rest.startsWith("[")) {
          throw new Error(`redact: expected '[' in field path '${path}'`);
        }
        const bracketEnd = rest.indexOf("]");
        if (bracketEnd === -1) {
          throw new Error(`redact: unclosed bracket in field path '${path}'`);
        }
        const inside = rest.slice(1, bracketEnd);
        if (!/^\d+$/.test(inside)) {
          throw new Error(`redact: non-numeric index in field path '${path}'`);
        }
        segments.push({ kind: "index", index: Number.parseInt(inside, 10) });
        rest = rest.slice(bracketEnd + 1);
      }
      continue;
    }
    if (!IDENT_RE.test(raw)) {
      throw new Error(`redact: bad field path segment '${raw}' in '${path}'`);
    }
    segments.push({ kind: "literal", name: raw });
  }
  return segments;
}

/** Apply every field rule and report whether any value changed. */
function applyFieldRules(
  root: Record<string, unknown>,
  patterns: FieldPattern[],
  replacement: string,
): boolean {
  let changed = false;
  for (const pattern of patterns) {
    changed = walkAndRedact(root, pattern.segments, 0, replacement) || changed;
  }
  return changed;
}

function walkAndRedact(
  node: unknown,
  segments: FieldSegment[],
  index: number,
  replacement: string,
): boolean {
  if (index >= segments.length) return false;
  const segment = segments[index];
  if (!segment) return false;
  let changed = false;

  if (segment.kind === "deep") {
    // Deep wildcard: match at current depth, or descend further.
    changed = walkAndRedact(node, segments, index + 1, replacement);
    if (node && typeof node === "object") {
      if (Array.isArray(node)) {
        for (const child of node) {
          changed = walkAndRedact(child, segments, index, replacement) || changed;
        }
      } else {
        for (const v of Object.values(node as Record<string, unknown>)) {
          changed = walkAndRedact(v, segments, index, replacement) || changed;
        }
      }
    }
    return changed;
  }

  if (!node || typeof node !== "object") return false;

  const isLast = index === segments.length - 1;

  if (segment.kind === "one") {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (isLast) {
          changed = node[i] !== replacement || changed;
          node[i] = replacement;
        } else {
          changed = walkAndRedact(node[i], segments, index + 1, replacement) || changed;
        }
      }
    } else {
      const obj = node as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (isLast) {
          changed = obj[key] !== replacement || changed;
          obj[key] = replacement;
        } else {
          changed = walkAndRedact(obj[key], segments, index + 1, replacement) || changed;
        }
      }
    }
    return changed;
  }

  if (segment.kind === "index") {
    if (!Array.isArray(node)) return false;
    if (segment.index < 0 || segment.index >= node.length) return false;
    if (isLast) {
      changed = node[segment.index] !== replacement;
      node[segment.index] = replacement;
    } else {
      changed = walkAndRedact(node[segment.index], segments, index + 1, replacement);
    }
    return changed;
  }

  // literal segment
  if (Array.isArray(node)) {
    for (const child of node) {
      changed = walkAndRedact(child, segments, index, replacement) || changed;
    }
    return changed;
  }
  const obj = node as Record<string, unknown>;
  if (!(segment.name in obj)) return false;
  if (isLast) {
    changed = obj[segment.name] !== replacement;
    obj[segment.name] = replacement;
  } else {
    changed = walkAndRedact(obj[segment.name], segments, index + 1, replacement);
  }
  return changed;
}

/* ----------------------------- Utilities ----------------------------- */

function structuredCloneCompat<T>(value: T): T {
  const globalStructuredClone = (globalThis as { structuredClone?: <U>(v: U) => U })
    .structuredClone;
  if (typeof globalStructuredClone === "function") {
    return globalStructuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
