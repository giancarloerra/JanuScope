import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSecretRef, resolveAllSecretRefs } from "../src/secrets.js";
import { detectSecretRefs, substituteEnv } from "../src/config.js";

describe("parseSecretRef", () => {
  it("parses vault://<path>#<field>", () => {
    const r = parseSecretRef("vault://kv/prod/database#url");
    expect(r).toEqual({
      raw: "vault://kv/prod/database#url",
      scheme: "vault",
      path: "kv/prod/database",
      field: "url",
    });
  });

  it("parses aws-sm://<arn> without a field", () => {
    const r = parseSecretRef("aws-sm://arn:aws:secretsmanager:us-east-1:111:secret/stripe");
    expect(r).toEqual({
      raw: "aws-sm://arn:aws:secretsmanager:us-east-1:111:secret/stripe",
      scheme: "aws-sm",
      path: "arn:aws:secretsmanager:us-east-1:111:secret/stripe",
    });
  });

  it("parses 1pw://vaults/<v>/items/<i>/fields/<f>", () => {
    const r = parseSecretRef("1pw://vaults/eng/items/stripe/fields/key");
    expect(r?.scheme).toBe("1pw");
    expect(r?.path).toBe("vaults/eng/items/stripe/fields/key");
  });

  it("returns null for an unknown scheme", () => {
    expect(parseSecretRef("http://example.com")).toBeNull();
    expect(parseSecretRef("foobar://x")).toBeNull();
  });

  it("returns null for a plain env var", () => {
    expect(parseSecretRef("DATABASE_URL")).toBeNull();
  });
});

describe("detectSecretRefs", () => {
  it("finds refs nested in objects and arrays", () => {
    expect(
      detectSecretRefs({
        target: {
          env: {
            A: "${vault://kv/a#x}",
            B: "prefix-${aws-sm://arn:secret#k}-suffix",
          },
          args: ["--key", "${1pw://x}"],
        },
      }),
    ).toEqual(["vault://kv/a#x", "aws-sm://arn:secret#k", "1pw://x"]);
  });

  it("ignores ${VAR} env-var refs (those aren't secrets)", () => {
    expect(detectSecretRefs("${DATABASE_URL}")).toEqual([]);
  });

  it("returns duplicates in order (dedupe is the caller's job)", () => {
    expect(detectSecretRefs({ a: "${vault://kv/a}", b: "${vault://kv/a}" })).toEqual([
      "vault://kv/a",
      "vault://kv/a",
    ]);
  });
});

describe("substituteEnv with resolvers", () => {
  it("splices resolver values into ${scheme://...} positions", () => {
    const resolvers = new Map([
      ["vault://kv/db#url", "postgres://real-value"],
      ["aws-sm://arn:stripe#k", "rk_live_xxx"],
    ]);
    const result = substituteEnv(
      {
        target: {
          env: {
            DATABASE_URL: "${vault://kv/db#url}",
            STRIPE_KEY: "${aws-sm://arn:stripe#k}",
            PLAIN: "${PATH}",
          },
        },
      },
      { PATH: "/usr/bin" },
      { resolvers },
    );
    expect(result).toEqual({
      target: {
        env: {
          DATABASE_URL: "postgres://real-value",
          STRIPE_KEY: "rk_live_xxx",
          PLAIN: "/usr/bin",
        },
      },
    });
  });

  it("calls onMissing for an unresolved ${scheme://...} reference", () => {
    const seen: string[] = [];
    substituteEnv(
      "${vault://kv/nope#x}",
      {},
      {
        resolvers: new Map(),
        onMissing: (n) => seen.push(n),
      },
    );
    expect(seen).toEqual(["vault://kv/nope#x"]);
  });

  it("leaves malformed ${weird stuff} braces untouched so the user can debug", () => {
    // "not an identifier, not a scheme" — neither VAR nor secret-ref.
    const result = substituteEnv("${has spaces}", {});
    expect(result).toBe("${has spaces}");
  });

  it("does not let a runaway ${ swallow newlines", () => {
    // A YAML value with a stray `${` and no same-line closer must NOT
    // match across a newline — the regex is newline-bounded after the
    // review fix.
    const input = "prefix ${oops\nnext-line stays put";
    expect(substituteEnv(input, {})).toBe(input);
  });
});

describe("resolveAllSecretRefs (vault backend via fetch mock)", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.VAULT_ADDR = "https://vault.example:8200";
    process.env.VAULT_TOKEN = "s.test-token";
    delete process.env.VAULT_KV_VERSION;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it("fetches a KV v2 secret and picks the named field", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              data: { url: "postgres://from-vault", owner: "dba" },
              metadata: {},
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as typeof globalThis.fetch;
    const map = await resolveAllSecretRefs({ x: "${vault://kv/prod/db#url}" });
    expect(map.get("vault://kv/prod/db#url")).toBe("postgres://from-vault");
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe("https://vault.example:8200/v1/kv/data/prod/db");
  });

  it("falls back to KV v1 when VAULT_KV_VERSION=1", async () => {
    process.env.VAULT_KV_VERSION = "1";
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ data: { key: "v1-value" } }), { status: 200 }),
    ) as typeof globalThis.fetch;
    const map = await resolveAllSecretRefs({ x: "${vault://secret/foo#key}" });
    expect(map.get("vault://secret/foo#key")).toBe("v1-value");
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe("https://vault.example:8200/v1/secret/foo");
  });

  it("surfaces a clear error when VAULT_ADDR is missing", async () => {
    delete process.env.VAULT_ADDR;
    await expect(resolveAllSecretRefs({ x: "${vault://kv/a#b}" })).rejects.toThrow(/VAULT_ADDR/);
  });

  // CodeRabbit catch: a reference without a path under the mount
  // (e.g. `vault://kv` or `vault://kv/`) used to silently issue
  // a request to /v1/kv/data/ with an empty trailing segment, which
  // Vault returns as 404 with a confusing body. Reject early.
  it("rejects a vault:// reference with no path under the mount", async () => {
    await expect(resolveAllSecretRefs({ x: "${vault://kv}" })).rejects.toThrow(
      /missing the path under the mount/,
    );
    await expect(resolveAllSecretRefs({ x: "${vault://kv/}" })).rejects.toThrow(
      /missing the path under the mount/,
    );
    // Sanity: a well-formed reference still works.
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ data: { data: { x: "ok" } } }), { status: 200 }),
    ) as typeof globalThis.fetch;
    const map = await resolveAllSecretRefs({ y: "${vault://kv/foo#x}" });
    expect(map.get("vault://kv/foo#x")).toBe("ok");
  });

  it("surfaces a clear error when Vault returns non-2xx", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("forbidden", { status: 403, statusText: "Forbidden" }),
    ) as typeof globalThis.fetch;
    await expect(resolveAllSecretRefs({ x: "${vault://kv/a#b}" })).rejects.toThrow(/403/);
  });

  // Bounded fetch timeout — without this an unreachable / slow Vault
  // hangs the proxy startup forever (CodeRabbit caught the missing
  // AbortController). The fetch mock honours the AbortSignal so the
  // test can drive the abort path deterministically without sleeping.
  it("times out a hung Vault fetch with a clear error message", async () => {
    process.env.VAULT_FETCH_TIMEOUT_MS = "50"; // tight so the test is fast
    globalThis.fetch = vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => {
      // Resolve only when aborted; otherwise hang.
      return new Promise((_, reject) => {
        const sig = init?.signal;
        if (!sig) return; // unhandled — would hang test
        if (sig.aborted) {
          const e = new Error("aborted");
          (e as { name: string }).name = "AbortError";
          reject(e);
          return;
        }
        sig.addEventListener("abort", () => {
          const e = new Error("aborted");
          (e as { name: string }).name = "AbortError";
          reject(e);
        });
      });
    }) as typeof globalThis.fetch;
    await expect(resolveAllSecretRefs({ x: "${vault://kv/a#b}" })).rejects.toThrow(
      /timed out after 50ms/,
    );
  });

  it("respects VAULT_FETCH_TIMEOUT_MS override; falls back to 10000ms default on bogus values", async () => {
    // Confirm the env-var hook accepts a positive integer and ignores
    // garbage. We don't actually fire the timeout here; we just assert
    // the env-var path works through to the abort message.
    for (const bogus of ["", "abc", "0", "-100", "NaN"]) {
      process.env.VAULT_FETCH_TIMEOUT_MS = bogus;
      // With a bogus value we'd fall back to 10s default — which is
      // too long for a test. Instead, mock fetch to abort instantly so
      // we can read the message.
      globalThis.fetch = vi.fn((_url: unknown) => {
        const e = new Error("aborted");
        (e as { name: string }).name = "AbortError";
        return Promise.reject(e);
      }) as typeof globalThis.fetch;
      await expect(resolveAllSecretRefs({ x: "${vault://kv/a#b}" })).rejects.toThrow(
        /timed out after 10000ms/,
      );
    }
  });

  it("picks the single field when the secret has exactly one key and no '#' given", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { data: { value: "lonely" } } }), { status: 200 }),
    ) as typeof globalThis.fetch;
    const map = await resolveAllSecretRefs({ x: "${vault://kv/a}" });
    expect(map.get("vault://kv/a")).toBe("lonely");
  });

  it("refuses to guess when the secret has multiple fields and no selector", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { data: { a: "1", b: "2" } } }), { status: 200 }),
    ) as typeof globalThis.fetch;
    await expect(resolveAllSecretRefs({ x: "${vault://kv/a}" })).rejects.toThrow(/add '#/);
  });

  it("names a missing field explicitly in the error", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ data: { data: { a: "1" } } }), { status: 200 }),
    ) as typeof globalThis.fetch;
    await expect(resolveAllSecretRefs({ x: "${vault://kv/a#b}" })).rejects.toThrow(
      /no string field 'b'/,
    );
  });

  it("deduplicates identical refs before fetching", async () => {
    const mock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { data: { url: "same" } } }), { status: 200 }),
    );
    globalThis.fetch = mock as typeof globalThis.fetch;
    await resolveAllSecretRefs({ a: "${vault://kv/x#url}", b: "${vault://kv/x#url}" });
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe("secrets: error redaction", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  it("error message redacts the vault path by default", async () => {
    process.env.VAULT_ADDR = "https://vault.example";
    process.env.VAULT_TOKEN = "t";
    delete process.env.JANUSCOPE_VERBOSE_SECRETS;
    globalThis.fetch = vi.fn(
      async () => new Response("no", { status: 403, statusText: "Forbidden" }),
    ) as typeof globalThis.fetch;

    try {
      await resolveAllSecretRefs({ x: "${vault://kv/very-secret-mount/prod/stripe#key}" });
      throw new Error("should have rejected");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("vault://");
      // Full path must NOT appear in the default mode — only a short
      // preview.
      expect(msg).not.toContain("very-secret-mount/prod/stripe");
      expect(msg).not.toContain("#key");
      // Preview form keeps scheme + first-3 / last-3 chars.
      expect(msg).toMatch(/vault:\/\/kv\/…\w{2,3}/);
    }
  });

  it("JANUSCOPE_VERBOSE_SECRETS=1 opts in to the full ref in errors", async () => {
    process.env.VAULT_ADDR = "https://vault.example";
    process.env.VAULT_TOKEN = "t";
    process.env.JANUSCOPE_VERBOSE_SECRETS = "1";
    globalThis.fetch = vi.fn(
      async () => new Response("no", { status: 403, statusText: "Forbidden" }),
    ) as typeof globalThis.fetch;

    try {
      await resolveAllSecretRefs({ x: "${vault://kv/prod/db#url}" });
      throw new Error("should have rejected");
    } catch (err) {
      expect((err as Error).message).toContain("vault://kv/prod/db#url");
    }
  });
});
