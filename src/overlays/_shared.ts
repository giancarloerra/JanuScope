// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * Tiny helpers shared across overlays that filter or match on tool
 * names. Kept in its own module so the glob convention and the
 * `params.name` extraction rule live in exactly one place.
 */

/**
 * Extract the `name` field from a `tools/call` request's `params`.
 * Returns `null` when params is missing, not an object, or `name` is
 * not a string — overlays should treat that as "pass through".
 */
export function extractToolName(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const name = (params as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

/**
 * Whole-message variant of {@link extractToolName}. Accepts any
 * JSON-RPC message shape; returns `null` for non-`tools/call`
 * messages (responses, notifications, other methods). Used by the
 * pipeline's telemetry layer, which sees both directions and must
 * not misread a response as a malformed request.
 */
export function extractToolNameFromMessage(msg: unknown): string | null {
  if (!msg || typeof msg !== "object") return null;
  const method = (msg as { method?: unknown }).method;
  if (method !== "tools/call") return null;
  return extractToolName((msg as { params?: unknown }).params);
}

/**
 * Compile a literal-or-glob rule to a predicate. `*` expands to
 * `[^:]*` (same convention as many glob dialects, matches any run of
 * characters except `:`). Escapes regex metacharacters in the literal
 * parts so patterns like `v1.*` are treated as "v1 dot anything", not
 * "v1 any-char anything".
 *
 * ReDoS hardening: consecutive `*` characters are collapsed to a
 * single `*` BEFORE expansion. Without this, a glob like `*****` would
 * compile to `[^:]*[^:]*[^:]*[^:]*[^:]*` and trigger catastrophic
 * polynomial backtracking on inputs that can never match (e.g.
 * `aaaa…aaa:`). Multiple consecutive wildcards are semantically
 * equivalent to a single one in every glob dialect, so this collapse
 * is loss-free.
 */
export function compileToolMatcher(rule: string): (name: string) => boolean {
  if (!rule.includes("*")) {
    return (name) => name === rule;
  }
  const collapsed = rule.replace(/\*+/g, "*");
  const escaped = collapsed.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^:]*");
  const regex = new RegExp(`^${escaped}$`);
  return (name) => regex.test(name);
}
