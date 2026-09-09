// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * Field redaction for the Python row repr emitted by postgres-mcp.
 * No Python or expression evaluation: retain source spans and replace only
 * selected values. Unrelated database types and formatting stay verbatim.
 */

interface Node {
  start: number;
  end: number;
  value: unknown;
  children: Array<{ key: string; node: Node }>;
}

export function redactPythonLiteral(
  text: string,
  applyFields: (root: Record<string, unknown>) => void,
): string | null {
  // Ordinary prose and JSON use the existing paths. Once a Python-style
  // row container is recognized, incomplete/unsupported syntax is an error,
  // never permission to forward the original sensitive row.
  if (!/^\s*(?:\[\s*)*\{\s*['"]/.test(text)) return null;
  const parser = new LiteralParser(text);
  const root = parser.parse();
  applyFields(root.value as Record<string, unknown>);
  const edits: Array<{ start: number; end: number; text: string }> = [];
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
  collect(root);
  let redacted = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    redacted = redacted.slice(0, edit.start) + edit.text + redacted.slice(edit.end);
  }
  return redacted;
}

class LiteralParser {
  private position = 0;

  constructor(private readonly source: string) {}

  parse(): Node {
    const node = this.value(0);
    this.space();
    if (this.position !== this.source.length) this.invalid();
    return node;
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
