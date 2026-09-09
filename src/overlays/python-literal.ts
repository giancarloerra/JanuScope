// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * Field redaction for Python row repr and JSON spans in response text.
 * No Python or expression evaluation: retain source spans and replace only
 * selected values. Unrelated database types and formatting stay verbatim.
 */

interface Node {
  start: number;
  end: number;
  value: unknown;
  children: Array<{ key: string; node: Node }>;
}

interface RedactedText {
  text: string;
  normalized: string;
}

/**
 * Apply field replacements to recognized row spans without evaluating them.
 * Preserve surrounding text and optionally delegate JSON spans to their own rules.
 * Return original-format and normalized variants for a single enclosing regex pass,
 * or null when no handled container is recognized; reject malformed recognized rows.
 */
export function redactPythonLiteral(
  text: string,
  applyFields: (root: Record<string, unknown>) => void,
  redactJson?: (text: string, parsed: unknown) => RedactedText,
): RedactedText | null {
  const edits: Array<{ start: number; end: number; text: string; normalized?: string }> = [];
  const collect = (node: Node): void => {
    const object = node.value as Record<string, unknown>;
    for (const child of node.children) {
      const value = object[child.key];
      if (value !== child.node.value) {
        if (typeof value !== "string") throw new TypeError("redact: invalid field replacement");
        edits.push({ start: child.node.start, end: child.node.end, text: JSON.stringify(value) });
      } else {
        collect(child.node);
      }
    }
  };
  let recognized = false;
  const ends = new Map<number, number | null>();
  for (let position = 0; position < text.length; position++) {
    if (!/[{[(]/.test(text[position]!)) continue;
    const end = containerEnd(text, position, ends);
    const candidate = text.slice(position, end ?? undefined);
    // JSON delegates to its own redaction rules. Skip whole non-row containers
    // so quoted examples inside JSON, sets or string lists are not mistaken
    // for another row.
    if (end !== null) {
      let json: unknown;
      try {
        json = JSON.parse(candidate);
      } catch {
        // A balanced Python representation need not be valid JSON.
      }
      if (json !== undefined) {
        if (redactJson) {
          const redacted = redactJson(candidate, json);
          edits.push({ start: position, end, ...redacted });
          recognized = true;
        }
        position = end - 1;
        continue;
      }
    }
    const wrappers = /^(?:[[(]\s*)*/.exec(candidate)![0];
    if (
      !/^\{\s*(?:'(?:\\[^\r\n]|[^'\\\r\n])*'|"(?:\\[^\r\n]|[^"\\\r\n])*")\s*:/.test(
        candidate.slice(wrappers.length),
      )
    ) {
      if (end !== null && (text[position] === "{" || /^[[(]\s*['"]/.test(candidate))) {
        position = end - 1;
      } else if (wrappers.length > 0) {
        position += wrappers.length - 1;
      }
      continue;
    }
    // A quoted key followed by a colon identifies a row, rather than a set.
    // Once recognized, malformed or unsupported values must still refuse.
    const root = new LiteralParser(text, position).parse();
    applyFields(root.value as Record<string, unknown>);
    collect(root);
    recognized = true;
    position = root.end - 1;
  }
  if (!recognized) return null;
  let redacted = text;
  let normalized = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    redacted = redacted.slice(0, edit.start) + edit.text + redacted.slice(edit.end);
    normalized =
      normalized.slice(0, edit.start) + (edit.normalized ?? edit.text) + normalized.slice(edit.end);
  }
  return { text: redacted, normalized };
}

/** Cache balanced container ends so nested or incomplete text is scanned once. */
function containerEnd(
  text: string,
  start: number,
  ends: Map<number, number | null>,
): number | null {
  const cached = ends.get(start);
  if (cached !== undefined) return cached;
  const closes: Array<{ start: number; close: string }> = [];
  let quote: string | undefined;
  for (let position = start; position < text.length; position++) {
    const char = text[position]!;
    if (quote) {
      if (char === "\\") position++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "{" || char === "[" || char === "(") {
      closes.push({ start: position, close: char === "{" ? "}" : char === "[" ? "]" : ")" });
    } else if (char === "}" || char === "]" || char === ")") {
      const open = closes.pop();
      if (open?.close !== char) {
        if (open) ends.set(open.start, null);
        for (const pending of closes) ends.set(pending.start, null);
        return null;
      }
      ends.set(open.start, position + 1);
      if (closes.length === 0) return position + 1;
    }
  }
  for (const pending of closes) ends.set(pending.start, null);
  return null;
}

class LiteralParser {
  constructor(
    private readonly source: string,
    private position: number,
  ) {}

  parse(): Node {
    return this.value(0);
  }

  private invalid(): never {
    // Never include source fragments in exceptions or downstream diagnostics.
    throw new TypeError("redact: unsupported Python row representation");
  }

  private space(): void {
    while (/\s/.test(this.source[this.position] ?? "") && this.position < this.source.length) {
      this.position++;
    }
  }

  private value(depth: number): Node {
    if (depth > 256) throw new RangeError("redact: Python row nesting limit exceeded");
    this.space();
    const start = this.position;
    const char = this.source[this.position];
    if (char === "{") return this.container(depth, true);
    if (char === "[" || char === "(") return this.container(depth, false);
    let value: unknown;
    if (char === "'" || char === '"') {
      value = this.string();
    } else if (char === "b" && /['"]/.test(this.source[this.position + 1] ?? "")) {
      this.position++;
      this.string();
      value = Symbol();
    } else {
      const rest = this.source.slice(this.position);
      const atom =
        /^(?:None|True|False|[-]?(?:nan|inf)|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)/.exec(
          rest,
        );
      const constructor =
        /^(?:Decimal|UUID|Range|Multirange|IPv[46](?:Address|Interface|Network)|datetime\.(?:date|datetime|time|timedelta|timezone))\(/.exec(
          rest,
        );
      if (constructor) {
        this.position += constructor[0].length - 1;
        this.scalarConstructor();
      } else if (atom) {
        this.position += atom[0].length;
      } else {
        this.invalid();
      }
      value = Symbol();
    }
    return { start, end: this.position, value, children: [] };
  }

  private container(depth: number, dictionary: boolean): Node {
    const start = this.position;
    const open = this.source[this.position++];
    const close = dictionary ? "}" : open === "[" ? "]" : ")";
    const value: Record<string, unknown> | unknown[] = dictionary ? Object.create(null) : [];
    const children: Node["children"] = [];
    this.space();
    while (this.source[this.position] !== close) {
      let key: string;
      if (dictionary) {
        if (!/['"]/.test(this.source[this.position] ?? "")) this.invalid();
        key = this.string();
        if (Object.hasOwn(value, key)) this.invalid();
        this.space();
        if (this.source[this.position++] !== ":") this.invalid();
      } else {
        key = String(children.length);
      }
      const node = this.value(depth + 1);
      (value as Record<string, unknown>)[key] = node.value;
      children.push({ key, node });
      this.space();
      if (this.source[this.position] === close) break;
      if (this.source[this.position++] !== ",") this.invalid();
      this.space();
    }
    if (this.source[this.position++] !== close) this.invalid();
    return { start, end: this.position, value, children };
  }

  private string(): string {
    const quote = this.source[this.position++];
    let value = "";
    while (this.position < this.source.length) {
      const char = this.source[this.position++]!;
      if (char === quote) return value;
      if (char !== "\\") {
        if (char === "\n" || char === "\r") this.invalid();
        value += char;
        continue;
      }
      const escaped = this.source[this.position++];
      if (escaped === undefined) this.invalid();
      const simple: Record<string, string> = {
        "\\": "\\",
        "'": "'",
        '"': '"',
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        a: "\x07",
        v: "\v",
      };
      if (Object.hasOwn(simple, escaped)) {
        value += simple[escaped];
      } else if (escaped === "x" || escaped === "u" || escaped === "U") {
        const length = escaped === "x" ? 2 : escaped === "u" ? 4 : 8;
        const hex = this.source.slice(this.position, this.position + length);
        if (hex.length !== length || !/^[0-9a-f]+$/i.test(hex)) this.invalid();
        const point = Number.parseInt(hex, 16);
        if (point > 0x10ffff) this.invalid();
        value += String.fromCodePoint(point);
        this.position += length;
      } else if (/[0-7]/.test(escaped)) {
        const tail = /^[0-7]{0,2}/.exec(this.source.slice(this.position))![0];
        value += String.fromCodePoint(Number.parseInt(escaped + tail, 8));
        this.position += tail.length;
      } else {
        this.invalid();
      }
    }
    return this.invalid();
  }

  private scalarConstructor(): void {
    // PostgreSQL scalars include nested constructors and Multirange lists.
    // Balance both kinds of delimiters without evaluating them. A dictionary
    // is not a scalar representation: reject it rather than hiding its fields.
    const closes: string[] = [];
    while (this.position < this.source.length) {
      const char = this.source[this.position]!;
      if (char === "'" || char === '"') {
        this.string();
        continue;
      }
      this.position++;
      if (char === "{" || char === "}") this.invalid();
      if (char === "(" || char === "[") closes.push(char === "(" ? ")" : "]");
      if (closes.length > 256) throw new RangeError("redact: Python scalar nesting limit exceeded");
      if (char === ")" || char === "]") {
        if (closes.pop() !== char) this.invalid();
        if (closes.length === 0) return;
      }
    }
    this.invalid();
  }
}
