// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
/**
 * Credential-vault backends for ${scheme://ref} substitution.
 *
 * The ordinary ${VAR} path reads from the process environment.
 * When the operator already uses HashiCorp Vault, AWS Secrets
 * Manager, or 1Password, forcing them to first resolve every secret
 * into an env var is friction. JanuScope recognises three extra
 * URI-shaped references and fetches them lazily at startup:
 *
 *   ${vault://<path>#<field>}          HashiCorp Vault KV v2
 *   ${aws-sm://<arn-or-name>#<field>}  AWS Secrets Manager
 *   ${1pw://<op-reference>}            1Password (op:// URL)
 *
 * Backend SDKs are OPTIONAL peer deps loaded lazily. The default
 * install doesn't drag them in. A well-formed lens that uses only
 * ${VAR} (or no substitution at all) never touches this module.
 *
 * All backends READ only. JanuScope is a proxy, not a secret
 * manager — we never mint or rotate credentials.
 */

import { detectSecretRefs } from "./config.js";

/** Supported backend schemes. */
export type SecretScheme = "vault" | "aws-sm" | "1pw";

/** A parsed secret reference. */
export interface SecretRef {
  /** The whole <scheme>://<rest> string the user wrote. */
  raw: string;
  scheme: SecretScheme;
  /** Path / ARN / item reference — scheme-specific. */
  path: string;
  /**
   * Optional field selector (part after '#'). Many secret stores
   * return a JSON object; this picks a single key out.
   */
  field?: string;
}

/**
 * Parse a scheme://... reference. Returns null if the string
 * doesn't look like a supported backend reference (so the caller
 * can fall back to plain env-var substitution).
 */
export function parseSecretRef(ref: string): SecretRef | null {
  const match = /^([a-z0-9-]+):\/\/(.*)$/.exec(ref);
  if (!match) return null;
  const scheme = match[1]!;
  const rest = match[2]!;
  if (scheme !== "vault" && scheme !== "aws-sm" && scheme !== "1pw") {
    return null;
  }
  const hashIdx = rest.indexOf("#");
  if (hashIdx === -1) {
    return { raw: ref, scheme, path: rest };
  }
  return {
    raw: ref,
    scheme,
    path: rest.slice(0, hashIdx),
    field: rest.slice(hashIdx + 1),
  };
}

/**
 * Resolve every secret reference in `value` (or its nested
 * strings). Returns a map keyed by `raw` so callers can pass it
 * into substituteEnv(..., { resolvers }) for the actual splice.
 */
export async function resolveAllSecretRefs(value: unknown): Promise<Map<string, string>> {
  const refs = detectSecretRefs(value);
  if (refs.length === 0) return new Map();

  const parsed: SecretRef[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const raw of refs) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    const p = parseSecretRef(raw);
    if (p === null) unknown.push(raw);
    else parsed.push(p);
  }
  if (unknown.length > 0) {
    throw new Error(
      `januscope: unknown secret backend scheme in ${unknown.length} reference(s): ` +
        `${unknown.slice(0, 3).join(", ")}${unknown.length > 3 ? ", …" : ""}. ` +
        `Supported schemes: vault://, aws-sm://, 1pw://`,
    );
  }

  const resolutions = await Promise.all(
    parsed.map(async (ref) => [ref.raw, await resolveOne(ref)] as const),
  );
  return new Map(resolutions);
}

async function resolveOne(ref: SecretRef): Promise<string> {
  switch (ref.scheme) {
    case "vault":
      return resolveVault(ref);
    case "aws-sm":
      return resolveAwsSm(ref);
    case "1pw":
      return resolveOnePassword(ref);
  }
}

/* -------------------------------------------------------------------------
 * HashiCorp Vault — KV v2 via direct HTTPS (no SDK; uses built-in fetch).
 * Requires VAULT_ADDR and VAULT_TOKEN in the environment.
 * ---------------------------------------------------------------------- */

/**
 * Produce a version of the secret reference safe to include in logs.
 * Keeps the scheme + a short trailing hint and masks the middle so an
 * attacker grepping stderr doesn't learn vault mount names, ARN account
 * IDs, or 1Password vault/item names. Operators debugging a real
 * failure can set `JANUSCOPE_VERBOSE_SECRETS=1` to see the raw ref.
 */
function saferef(raw: string): string {
  if (process.env.JANUSCOPE_VERBOSE_SECRETS === "1") return raw;
  const sep = raw.indexOf("://");
  if (sep === -1) return "[redacted]";
  const scheme = raw.slice(0, sep);
  const rest = raw.slice(sep + 3);
  // Keep the very first and very last 3 chars of the body so the
  // operator can still tell two different refs apart in logs, but
  // not enough to reconstruct the path.
  const preview = rest.length <= 8 ? "…" : `${rest.slice(0, 3)}…${rest.slice(-3)}`;
  return `${scheme}://${preview}`;
}

async function resolveVault(ref: SecretRef): Promise<string> {
  const addr = process.env.VAULT_ADDR;
  const token = process.env.VAULT_TOKEN;
  if (!addr) {
    throw new Error(
      `januscope: vault:// reference '${saferef(ref.raw)}' needs VAULT_ADDR in the environment.`,
    );
  }
  if (!token) {
    throw new Error(
      `januscope: vault:// reference '${saferef(ref.raw)}' needs VAULT_TOKEN in the environment.`,
    );
  }
  const kvVersion = process.env.VAULT_KV_VERSION === "1" ? 1 : 2;
  const { mount, path } = splitVaultMountPath(ref.path);
  const url =
    kvVersion === 2
      ? `${trimRight(addr, "/")}/v1/${mount}/data/${path}`
      : `${trimRight(addr, "/")}/v1/${mount}/${path}`;

  // Bounded timeout so a misconfigured / unreachable Vault address
  // can't hang the proxy startup forever. Default 10s; operators
  // running behind a slow network can override via VAULT_FETCH_TIMEOUT_MS.
  // The fetch itself remains a single-shot — retries are a Vault-client
  // concern, not the resolver's.
  const timeoutMs = parseTimeoutEnv(process.env.VAULT_FETCH_TIMEOUT_MS, 10_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { "X-Vault-Token": token, Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") {
      throw new Error(
        `januscope: vault:// fetch for '${saferef(ref.raw)}' timed out after ${timeoutMs}ms. ` +
          `Check VAULT_ADDR reachability or set VAULT_FETCH_TIMEOUT_MS to a higher value.`,
        { cause: err },
      );
    }
    // Network-level failure (DNS, ECONNREFUSED, TLS, etc.). Re-wrap so
    // the caller sees a januscope-namespaced message including the
    // saferef'd ref but NOT the raw URL (which may include the mount
    // / path the operator considers sensitive).
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`januscope: vault:// fetch for '${saferef(ref.raw)}' failed (${msg}).`, {
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    throw new Error(
      `januscope: vault:// fetch failed for '${saferef(ref.raw)}' (${resp.status} ${resp.statusText}).`,
    );
  }
  const body = (await resp.json()) as { data?: { data?: Record<string, unknown> } };
  const secretData = kvVersion === 2 ? (body.data?.data ?? undefined) : (body.data ?? undefined);
  if (!secretData || typeof secretData !== "object") {
    throw new Error(`januscope: vault:// fetch for '${saferef(ref.raw)}' returned no secret data.`);
  }
  return pickField(secretData as Record<string, unknown>, ref, ref.raw);
}

/**
 * Parse a positive-integer timeout from a string env var. Falls back
 * to the default if the env is missing, empty, non-numeric, zero, or
 * negative — operator typos shouldn't silently disable the timeout.
 */
function parseTimeoutEnv(raw: string | undefined, defaultMs: number): number {
  if (raw === undefined || raw === "") return defaultMs;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return defaultMs;
  return n;
}

function splitVaultMountPath(p: string): { mount: string; path: string } {
  const slash = p.indexOf("/");
  // Vault KV (v1 and v2) requires a non-empty path under the mount:
  //   v2: /v1/<mount>/data/<path>     <- <path> must not be empty
  //   v1: /v1/<mount>/<path>          <- <path> must not be empty
  // A reference like `vault://kv` (no slash) or `vault://kv/` (empty path
  // after slash) would otherwise produce a request to /v1/kv/data/ with
  // an empty path segment, which Vault returns as 404 with a confusing
  // body. Reject early with a clear januscope-namespaced message.
  if (slash === -1 || slash === p.length - 1) {
    throw new Error(
      `januscope: vault:// reference '${p}' is missing the path under the mount. ` +
        `Use the form 'vault://<mount>/<path>#<field>' (e.g. 'vault://kv/prod/db#url').`,
    );
  }
  return { mount: p.slice(0, slash), path: p.slice(slash + 1) };
}

/* -------------------------------------------------------------------------
 * AWS Secrets Manager — via @aws-sdk/client-secrets-manager (optional dep).
 * ---------------------------------------------------------------------- */

interface SecretsManagerClient {
  send(cmd: unknown): Promise<{ SecretString?: string }>;
}
interface SecretsManagerSdk {
  SecretsManagerClient: new (config?: { region?: string }) => SecretsManagerClient;
  GetSecretValueCommand: new (opts: { SecretId: string }) => unknown;
}

let smSdk: SecretsManagerSdk | null | undefined;
// Per-region client cache. Constructing a SecretsManagerClient is
// cheap but not free; a config with 20 aws-sm:// refs used to pay
// 20x that. Key by region string so multi-region lenses still work.
const smClientsByRegion = new Map<string, SecretsManagerClient>();

async function resolveAwsSm(ref: SecretRef): Promise<string> {
  if (smSdk === undefined) {
    try {
      const awsSdkSpec = "@aws-sdk/client-secrets-manager";
      smSdk = (await import(awsSdkSpec)) as unknown as SecretsManagerSdk;
    } catch {
      smSdk = null;
    }
  }
  if (smSdk === null) {
    throw new Error(
      `januscope: aws-sm:// reference '${saferef(ref.raw)}' needs the optional peer dependency ` +
        `'@aws-sdk/client-secrets-manager'. Install with: ` +
        `npm install @aws-sdk/client-secrets-manager`,
    );
  }
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  const regionKey = region ?? "<default>";
  let client = smClientsByRegion.get(regionKey);
  if (!client) {
    client = new smSdk.SecretsManagerClient(region ? { region } : {});
    smClientsByRegion.set(regionKey, client);
  }
  const response = await client.send(new smSdk.GetSecretValueCommand({ SecretId: ref.path }));
  if (!response.SecretString) {
    throw new Error(
      `januscope: aws-sm:// fetch for '${saferef(ref.raw)}' returned no SecretString ` +
        `(binary secrets are not supported).`,
    );
  }
  if (!ref.field) return response.SecretString;
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.SecretString);
  } catch {
    throw new Error(
      `januscope: aws-sm:// reference '${saferef(ref.raw)}' has a field selector ` +
        `but the stored secret is not JSON.`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      `januscope: aws-sm:// reference '${saferef(ref.raw)}' has a field selector but the ` +
        `parsed secret is not a JSON object.`,
    );
  }
  return pickField(parsed as Record<string, unknown>, ref, ref.raw);
}

/* -------------------------------------------------------------------------
 * 1Password — via @1password/sdk (optional dep).
 * Reference form: 1pw://<op-reference>, or the structured
 * vaults/<vault>/items/<item>/fields/<field> path which we translate.
 * ---------------------------------------------------------------------- */

interface OnePasswordClient {
  secrets: {
    resolve(reference: string): Promise<string>;
  };
}
interface OnePasswordSdk {
  createClient(opts: {
    auth: string;
    integrationName: string;
    integrationVersion: string;
  }): Promise<OnePasswordClient>;
}

let opSdk: OnePasswordSdk | null | undefined;
// Key the 1Password client by the service-account token so a host
// that loads two lenses with different OP_SERVICE_ACCOUNT_TOKEN values
// gets two independent clients instead of the second silently reusing
// the first's auth. See review of 7c8364f.
const opClientsByToken = new Map<string, OnePasswordClient>();

async function resolveOnePassword(ref: SecretRef): Promise<string> {
  if (opSdk === undefined) {
    try {
      const opSdkSpec = "@1password/sdk";
      opSdk = (await import(opSdkSpec)) as unknown as OnePasswordSdk;
    } catch {
      opSdk = null;
    }
  }
  if (opSdk === null) {
    throw new Error(
      `januscope: 1pw:// reference '${saferef(ref.raw)}' needs the optional peer dependency ` +
        `'@1password/sdk'. Install with: npm install @1password/sdk`,
    );
  }
  const token = process.env.OP_SERVICE_ACCOUNT_TOKEN;
  if (!token) {
    throw new Error(
      `januscope: 1pw:// reference '${saferef(ref.raw)}' needs OP_SERVICE_ACCOUNT_TOKEN in the environment.`,
    );
  }
  let opClient = opClientsByToken.get(token);
  if (!opClient) {
    opClient = await opSdk.createClient({
      auth: token,
      integrationName: "januscope",
      integrationVersion: "0.3.0",
    });
    opClientsByToken.set(token, opClient);
  }
  const body = ref.field ? `${ref.path}#${ref.field}` : ref.path;
  const opReference = body.startsWith("op://") ? body : `op://${body}`;
  return opClient.secrets.resolve(opReference);
}

/* ---------------------------------------------------------------------- */

function pickField(data: Record<string, unknown>, ref: SecretRef, rawForErrors: string): string {
  if (!ref.field) {
    const keys = Object.keys(data);
    if (keys.length === 1) {
      const only = data[keys[0]!];
      if (typeof only === "string") return only;
    }
    throw new Error(
      `januscope: secret '${saferef(rawForErrors)}' is an object with ${keys.length} field(s); ` +
        `add '#<field>' to the reference to pick one.`,
    );
  }
  const val = data[ref.field];
  if (typeof val !== "string") {
    throw new Error(
      `januscope: secret '${saferef(rawForErrors)}' has no string field '${ref.field}' ` +
        `(available: ${Object.keys(data).join(", ")})`,
    );
  }
  return val;
}

function trimRight(s: string, ch: string): string {
  let out = s;
  while (out.endsWith(ch)) out = out.slice(0, -1);
  return out;
}
