---
mcp: "@stripe/mcp"
mcpUrl: https://docs.stripe.com/mcp
testedVersion: "@stripe/mcp latest 2026-04"
testedAt: "2026-04-18"
maintainer: "@giancarloerra"
category: saas
status: probed
tags: [stripe, payments, financial, readonly, pci]
---

# Stripe (official `@stripe/mcp`) — JanuScope Lens

Wraps [`@stripe/mcp`](https://www.npmjs.com/package/@stripe/mcp), Stripe's own MCP server ([docs](https://docs.stripe.com/mcp)). Stripe data is **financial and regulated** — your security/compliance team will ask about this, and this lens is the answer.

## What this lens does

- **`instructions`** — explicit read-only policy covering the full Stripe write surface (create, update, cancel, refund, void, pay out). Names the PII / card / key patterns that must never be returned.
- **`block`** — proxy-layer backstop. Hides every write-capable tool with glob patterns (`create_*`, `update_*`, `delete_*`, `cancel_*`, `refund_*`, `void_*`, `pay_*`, `capture_*`, …) plus explicit high-value targets (`create_refund`, `create_payout`, …). New write tools the MCP adds are caught by the globs. `stripe_api_execute` is blocked literally.
- **`redact`** — Stripe secret-key patterns (`sk_live_*`, `sk_test_*`, `rk_*`), card PAN (Luhn-shape), email, phone, SSN, and field names like `card_number`, `cvc`, `tax_id`.
- **`audit`** — JSONL compliance log at `~/mcp-audit-stripe.jsonl`. For PCI-adjacent work you probably want a tamper-evident sink in addition.

No `sqlGuard` (Stripe isn't SQL) and no `dbSchema`.

### The three defence layers for Stripe (in order)

| Layer                                                     | What it stops                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. **Restricted API Key (`rk_*`)** at Stripe              | Surface narrowing at the authoritative layer — the MCP only sees the resources the key is scoped to. This is Stripe's own mechanism for tool gating since `@stripe/mcp` 0.3 (the former `--tools=<allowlist>` flag was removed upstream — see the one-line deprecation notice the MCP prints on start). |
| 2. **`block:` rules** at the JanuScope proxy (this lens)  | Catches write-verb tools inside the resources the RAK does expose (`create_customer`, `create_refund`, `stripe_api_execute`, …). Glob-based so future Stripe additions are covered.                                                                                                                     |
| 3. **`redact:` + `instructions:`** at the JanuScope proxy | PII, card-PAN, and secret-key scrubbing on the response; policy text pushed into every tool description the LLM reads.                                                                                                                                                                                  |

**Create the RAK, not a full secret key.** [Dashboard → API keys → Create restricted key](https://dashboard.stripe.com/apikeys/create). Grant read-only on the exact resources you want the LLM to touch (e.g. `customers: read`, `charges: read`, `invoices: read`, `disputes: read`). Everything else stays 403 at Stripe's edge, regardless of what the LLM tries.

Going back to a full `sk_*` secret key collapses layer 1 to "anything Stripe lets you do" and puts the entire protective load on layer 2 alone — which is not enough for financial data. Don't do that without a RAK-can't-work story.

## Tool names this lens assumes

The `@stripe/mcp` tool list is large and evolves with Stripe's API. Exact names aren't enumerated here because the glob rules (`create_*` / `update_*` / `delete_*` / `refund_*` / `cancel_*`) catch them by verb. Run `tools/list` against your installed version if you want to audit the exact surface.

## Prerequisites

- **Stripe Restricted API Key (`rk_*`) scoped to read-only** (layer 3, mandatory for production — Stripe writes move money). NEVER pass a full secret key (`sk_live_*` or `sk_test_*`) via `STRIPE_SECRET_KEY`; those keys can do anything Stripe lets your account do, including refunds, payouts, and customer creation. Instead, in the Stripe dashboard go to Developers → API keys → Create restricted key. Toggle **all** permissions to "Read" or "None" — none on "Write" — then copy the `rk_live_*` / `rk_test_*` value into `STRIPE_SECRET_KEY`. The `@stripe/mcp` binary accepts `rk_*` keys via the same env var (it's a single-key reader, no `--api-key` flag needed). JanuScope's block list, the verb globs, and the SURFACE BOUNDARY policy are layers 1 and 2 (defence in depth); only the RAK scope physically prevents `create_payout` / `create_refund` / `update_subscription` if the agent host runs the `stripe` CLI or `curl` against `api.stripe.com` reusing the same key. See [SECURITY.md](../../../SECURITY.md#three-layer-model) for the full model.

## Customising

Required environment variable:

| Variable            | Purpose                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY` | Stripe secret key. **Strongly prefer a restricted key (`rk_*`) scoped to read-only** over a full `sk_*` — that's defence-in-depth at the Stripe API level. |

> **Recommendation**: create a [restricted API key](https://dashboard.stripe.com/apikeys/create) with read-only permissions on only the resources you want to expose. Pair with this lens for two independent enforcement layers.

## Usage

```json
{
  "mcpServers": {
    "stripe": {
      "command": "januscope",
      "args": ["--config", "/absolute/path/to/stripe-official/config.yaml"]
    }
  }
}
```

## Changelog

- **2026-04-18** — Re-probed against live `tools/list` (status: `active` → `probed`).
- **2026-04-17** — Initial contribution (@giancarloerra).
