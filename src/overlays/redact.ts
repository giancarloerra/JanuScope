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
import { isSuccess, type JsonRpcSuccess } from "../rpc.js";

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
    onServerMessage(msg) {
      if (!isSuccess(msg)) {
        return { kind: "forward", msg };
      }
      const scrubbed = scrubResult(msg.result, compiled, replacement, applyTo);
      const out: JsonRpcSuccess = { ...msg, result: scrubbed };
      return { kind: "forward", msg: out };
    },
  };
}

function scrubResult(
  result: unknown,
  rules: CompiledRules,
  replacement: string,
  applyTo: ApplyTo,
): unknown {
  if (!result || typeof result !== "object") return result;

  // Deep clone so the original (held by the audit overlay upstream) is preserved.
  const cloned = structuredCloneCompat(result) as Record<string, unknown>;

  // 1. Apply field-path rules to the top-level result object. Works for
  //    MCPs that populate `structuredContent` or similar structured
  //    fields on the JSON-RPC result.
  if (rules.fieldPatterns.length > 0) {
    applyFieldRules(cloned, rules.fieldPatterns, replacement);
  }

  if (applyTo === "all" && rules.regexes.length > 0) {
    applyRegexRecursive(cloned, rules.regexes, replacement);
  } else if (applyTo === "text" || applyTo === "fields") {
    // 2. For each text content block, additionally try to parse the
    //    `text` as JSON and apply field-path rules to the parsed
    //    structure. Many MCPs (including the official Postgres one)
    //    return rows as a JSON string inside a `text` block — without
    //    this step, `**.email` could never reach into that string.
    //    Then apply regex rules on the (possibly re-serialised) text.
    const content = (cloned as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string"
        ) {
          const typed = block as { text: string };
          let text = typed.text;

          if (rules.fieldPatterns.length > 0) {
            const json = tryParseJson(text);
            if (json) {
              for (const pattern of rules.fieldPatterns) {
                walkAndRedact(json.parsed, pattern.segments, 0, replacement);
              }
              text = json.pretty
                ? JSON.stringify(json.parsed, null, 2)
                : JSON.stringify(json.parsed);
            } else {
              // Fallback: some MCPs wrap their JSON in a narrative envelope
              // (e.g. the official MongoDB MCP brackets results in
              // <untrusted-user-data-…>…</untrusted-user-data-…> tags).
              // If we can isolate an embedded JSON object/array, redact
              // the parsed form and splice it back in. This makes field
              // rules like `**.email` reach into those wrappers.
              const embedded = extractEmbeddedJsonBlock(text);
              if (embedded) {
                for (const pattern of rules.fieldPatterns) {
                  walkAndRedact(embedded.parsed, pattern.segments, 0, replacement);
                }
                const reSerialised = embedded.pretty
                  ? JSON.stringify(embedded.parsed, null, 2)
                  : JSON.stringify(embedded.parsed);
                text = embedded.before + reSerialised + embedded.after;
              }
            }
          }

          if (rules.regexes.length > 0) {
            text = applyRegexList(text, rules.regexes, replacement);
          }

          typed.text = text;
        }
      }
    }
  }

  return cloned;
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

function applyRegexRecursive(node: unknown, regexes: RegExp[], replacement: string): void {
  if (typeof node !== "object" || node === null) return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v = node[i];
      if (typeof v === "string") {
        node[i] = applyRegexList(v, regexes, replacement);
      } else {
        applyRegexRecursive(v, regexes, replacement);
      }
    }
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (typeof v === "string") {
      obj[key] = applyRegexList(v, regexes, replacement);
    } else {
      applyRegexRecursive(v, regexes, replacement);
    }
  }
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
    throw new Error(`redact: invalid regex '${pattern}': ${msg}`);
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

function applyFieldRules(
  root: Record<string, unknown>,
  patterns: FieldPattern[],
  replacement: string,
): void {
  for (const pattern of patterns) {
    walkAndRedact(root, pattern.segments, 0, replacement);
  }
}

function walkAndRedact(
  node: unknown,
  segments: FieldSegment[],
  index: number,
  replacement: string,
): void {
  if (index >= segments.length) return;
  const segment = segments[index];
  if (!segment) return;

  if (segment.kind === "deep") {
    // Deep wildcard: match at current depth, or descend further.
    walkAndRedact(node, segments, index + 1, replacement);
    if (node && typeof node === "object") {
      if (Array.isArray(node)) {
        for (const child of node) {
          walkAndRedact(child, segments, index, replacement);
        }
      } else {
        for (const v of Object.values(node as Record<string, unknown>)) {
          walkAndRedact(v, segments, index, replacement);
        }
      }
    }
    return;
  }

  if (!node || typeof node !== "object") return;

  const isLast = index === segments.length - 1;

  if (segment.kind === "one") {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (isLast) {
          node[i] = replacement;
        } else {
          walkAndRedact(node[i], segments, index + 1, replacement);
        }
      }
    } else {
      const obj = node as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (isLast) {
          obj[key] = replacement;
        } else {
          walkAndRedact(obj[key], segments, index + 1, replacement);
        }
      }
    }
    return;
  }

  if (segment.kind === "index") {
    if (!Array.isArray(node)) return;
    if (segment.index < 0 || segment.index >= node.length) return;
    if (isLast) {
      node[segment.index] = replacement;
    } else {
      walkAndRedact(node[segment.index], segments, index + 1, replacement);
    }
    return;
  }

  // literal segment
  if (Array.isArray(node)) {
    for (const child of node) {
      walkAndRedact(child, segments, index, replacement);
    }
    return;
  }
  const obj = node as Record<string, unknown>;
  if (!(segment.name in obj)) return;
  if (isLast) {
    obj[segment.name] = replacement;
  } else {
    walkAndRedact(obj[segment.name], segments, index + 1, replacement);
  }
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
