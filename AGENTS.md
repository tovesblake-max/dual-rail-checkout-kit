# AGENTS.md — Instructions for AI coding agents

You're an AI integrating this kit into an existing Next.js site. Read this file first. It tells you what to copy, what to customize, and what to leave alone.

## What this kit is

A drop-in checkout module for Next.js 15 (App Router) + React 19. Three payment gateways are wired in parallel:

- **CardsShield / KingsGate** — PayPal-backed, weekly bank settlement, near-zero chargebacks. PCI SAQ-A. Inline auto-fire iframe.
- **PsiFi** — Crypto-settled, daily payouts, no KYC, unified Apple Pay / Google Pay / card / crypto. PCI SAQ-A. Inline auto-fire iframe.
- **Quiklie** — High-risk-friendly card processor with Hosted Payment Page (HPP). PCI SAQ-A. Full-page redirect (no iframe — explicit Pay button after auto-fire mint).

A single env var (`NEXT_PUBLIC_PRIMARY_CARD_RAIL=cardsshield|psifi|quiklie`) picks which one renders. All three stay wired in the codebase 24/7. Flipping is one env change + redeploy.

The customer-facing UX is consistent across rails: a single combined form, debounced auto-fire mint on stable form input, no manual "submit shipping" step. The two iframe rails additionally skip the Pay button (iframe loads directly); the Quiklie HPP rail renders an explicit "Pay $X.XX" button that redirects to the hosted page.

## File map

```
src/
├── app/
│   ├── layout.tsx                          ← Root layout. Replace with the host's.
│   ├── globals.css                         ← Tailwind tokens. MERGE with host's.
│   ├── page.tsx                            ← Demo checkout. REPLACE with host's UI;
│   │                                          copy the auto-fire pattern from here.
│   ├── checkout/callback/page.tsx          ← Post-purchase landing. Keep.
│   ├── embedded-bridge/page.tsx            ← PsiFi iframe-to-parent handoff. Keep.
│   └── api/
│       ├── checkout/
│       │   ├── express/route.ts            ← CardsShield mint route. KEEP.
│       │   ├── express-psifi/route.ts      ← PsiFi mint route. KEEP.
│       │   └── result/route.ts             ← Rail-agnostic polling. KEEP.
│       ├── psifi/notify/route.ts           ← PsiFi webhook receiver. KEEP.
│       └── cs/
│           ├── notify/route.ts             ← KingsGate webhook receiver. KEEP.
│           └── order-detail/route.ts       ← KingsGate API 0 callback. KEEP.
├── components/
│   ├── PsifiEmbeddedFrame.tsx              ← PsiFi iframe + 3-channel completion. DO NOT MODIFY.
│   └── CardsShieldEmbeddedFrame.tsx        ← KingsGate iframe + postMessage choreography. DO NOT MODIFY.
└── lib/
    ├── checkout-config.ts                  ← The switch. DO NOT MODIFY.
    ├── psifi.ts                            ← PsiFi gateway client. DO NOT MODIFY.
    ├── cardsshield.ts                      ← KingsGate gateway client. DO NOT MODIFY.
    ├── catalog.ts                          ← REPLACE with the host's catalog adapter.
    └── order-store.ts                      ← REPLACE with the host's DB adapter.
```

## What to MODIFY (clear hook points)

Search the codebase for the literal token `CUSTOMIZE:` — every place you need to plug something in is marked with that comment. As of v1.0 there are five hook points:

1. **`src/lib/catalog.ts`** — replace `DEMO_ITEM` + `findCoupon` with the host's real catalog/coupon lookups. Server-side coupon validation MUST happen here, not on the client.

2. **`src/lib/order-store.ts`** — replace the entire in-memory `Map` with the host's DB adapter (Drizzle, Prisma, raw SQL, etc.). The `StoredOrder` shape is intentionally minimal; extend freely. The in-memory store DOES NOT survive function cold starts on Vercel — orders WILL be lost in production unless you swap this out.

3. **`src/app/page.tsx`** — replace the entire demo page with the host's real product/cart UI. The auto-fire `useEffect` (around line 170) is the piece to copy into the host's checkout component. Keep the discriminated `RailSession` union and the `iframeStatus` state machine; replace the form fields + summary card with the host's design.

4. **`src/app/api/psifi/notify/route.ts`** (inside the `after()` block) — wire in the host's fulfillment side effects: send receipt email, push to ShipStation, fire conversion pixels, etc. The kit only flips the local order-store status.

5. **`src/app/api/cs/notify/route.ts`** (inside the `after()` block) — same pattern: wire in the host's fulfillment side effects. Also save `status.shield_domain` to your order row — it's required for KingsGate's refund + tracking-sync APIs later.

## What to NOT MODIFY

- **`src/lib/checkout-config.ts`** — the env validator throws on invalid values. Don't add silent fallbacks; they hide outages.
- **`src/lib/psifi.ts`** and **`src/lib/cardsshield.ts`** — the gateway protocol contracts. Field names, header names, signature schemes all match the gateways' specs exactly. Modifying breaks the integration silently.
- **`src/components/PsifiEmbeddedFrame.tsx`** and **`src/components/CardsShieldEmbeddedFrame.tsx`** — the iframe components. The 3-channel completion detection (PsiFi) and postMessage choreography (KingsGate) is load-bearing. The chrome (header strip, footer caption, loading shimmer) is styled with Tailwind tokens that you CAN re-theme by adjusting the tokens in `globals.css`, but don't touch the iframe element itself.

## Environment setup

Copy `.env.example` to `.env.local` and fill in:

- **Always set:** `NEXT_PUBLIC_PRIMARY_CARD_RAIL` (`cardsshield` or `psifi`), `NEXT_PUBLIC_SITE_URL`.
- **If using PsiFi:** `PSIFI_API_KEY`, `PSIFI_WEBHOOK_SECRET`.
- **If using CardsShield:** `CS_GATEWAY_URL`, `CS_API_KEY`, `CS_PLATFORM_NAME`, `CS_ENDPOINT_TOKEN`, `CS_PAYMENT_GATEWAY`.
- **If using Quiklie:** `QUIKLIE_API_KEY`, `QUIKLIE_MERCHANT_ID`, `QUIKLIE_DESCRIPTOR` (≤22 chars), optional `NEXT_PUBLIC_QUIKLIE_HPP_MIDTYPE=THREE_D` if Quiklie support tells you your account uses the 3DS lane (default `TWO_D`).

The build will FAIL with a clear error if `NEXT_PUBLIC_PRIMARY_CARD_RAIL` is missing or invalid. That's intentional.

## CSP

`next.config.ts` ships with a Content-Security-Policy that allows both rails' domains in `frame-src` and `connect-src`:

- `*.psifi.app`
- `*.cardsshield.com`, `*.thekingsgateway.com`, `*.paymentshields.com`, `*.keysidecommerce.com`
- `*.paypal.com` (loaded inside the KingsGate iframe)

If you're MERGING this kit into a host with its own CSP, append these directives — don't replace the host's wholesale. Without them, the browser silently blocks the iframe and the checkout dies.

## Integration checklist

When the human asks you to drop this into an existing Next.js site, do these in order:

1. Copy `src/lib/`, `src/components/`, `src/app/api/`, `src/app/checkout/callback/`, `src/app/embedded-bridge/` into the host project at the same paths.
2. Merge `next.config.ts` CSP directives into the host's existing CSP.
3. Merge `.env.example` env vars into the host's existing `.env.example`. Set the active rail's env vars in the host's deployment provider (Vercel / Netlify / Railway / etc.).
4. Replace `src/lib/catalog.ts` and `src/lib/order-store.ts` with adapters to the host's catalog + DB.
5. Wire the host's checkout page (`/checkout` or `/cart` or wherever) to use the auto-fire pattern from `src/app/page.tsx`. Specifically, copy the `RailSession` union, the `fingerprint` useMemo, the auto-fire `useEffect`, and the `iframeStatus` state machine. The form fields + summary card are the host's own UI.
6. Wire fulfillment side effects in `src/app/api/psifi/notify/route.ts`, `src/app/api/cs/notify/route.ts`, and `src/app/api/quiklie/notify/route.ts` (look for `CUSTOMIZE:`).
7. Configure webhook URLs in the gateway portals to point at `<host>/api/psifi/notify`, `<host>/api/cs/notify`, and `<host>/api/quiklie/notify` respectively.
8. Test by minting a real $1 order on each rail. Flip the env var, redeploy, test the other rail. Both should work.

## Anti-patterns (don't do these)

- **Don't delete the inactive rail.** The whole point of the kit is hot-swap. Keep both wired even if you're only shipping with one.
- **Don't read `process.env.NEXT_PUBLIC_PRIMARY_CARD_RAIL` directly.** Always import `CARD_RAIL` from `@/lib/checkout-config` so the validator runs.
- **Don't trust client-supplied prices.** The mint routes recompute totals from your catalog table server-side. The `priceCents` field in the request body is for display fingerprinting only.
- **Don't disable webhook signature verification "temporarily for debugging".** Forged webhooks trigger fulfillment. Fail closed is the right default.
- **Don't store the gateway response HTML/URL on the client and reuse it.** Each session has a TTL (PsiFi: 1800s, KingsGate: per-merchant) and re-using stale ones causes silent failures. The auto-fire pattern handles re-minting; trust it.

## When to ask the human

- They want to add a third rail (Stripe, Authorize.net, etc.) — non-trivial, needs design work.
- They want to add fraud screening, 3DS challenge handling, or chargeback automation.
- They want to wire in subscription billing (the kit is one-shot checkout only).
- The host site has an existing checkout flow with deep CMS coupling — the integration approach changes from "drop in" to "graft on."

## Reference docs

- `README.md` — high-level overview for humans
- `INTEGRATION.md` — step-by-step drop-in instructions for humans
- `docs/architecture.md` — deeper technical reference
- `docs/payment-rail-switch.md` — the runbook for flipping rails
- `docs/customization.md` — every `CUSTOMIZE:` hook point in detail

If anything in this AGENTS.md conflicts with `docs/`, the docs are authoritative — they're the longer form.

## Dev tools

- **`scripts/probe-quiklie-hpp-embed.mjs`** — mints a $0.50 test Quiklie HPP session and inspects X-Frame-Options + CSP `frame-ancestors` to decide whether the merchant's HPP can be iframed. Also disambiguates Quiklie's `statusCode: 5` (HPP-not-provisioned vs midType-mismatch). Run with `node ./scripts/probe-quiklie-hpp-embed.mjs` from project root, after populating `QUIKLIE_API_KEY` + `QUIKLIE_MERCHANT_ID`.

## Refund

The `processRefund` helper in `src/lib/quiklie.ts` is the only programmatic way to refund a Quiklie transaction — the Quiklie merchant dashboard does NOT expose a refund button as of 2026-05-17. Wrap it in an admin-gated route (e.g. `/api/admin/orders/refund`) and dispatch by gateway:

```ts
if (order.rail === "quiklie") {
  await processRefund({ transactionId: order.quikliePaymentId, amountDollars, reason });
}
```

Refund helpers for KingsGate (API 10.1) and PsiFi are NOT shipped — see `docs/troubleshooting.md` for the API references.

## Troubleshooting

Common failure modes + diagnoses: `docs/troubleshooting.md`. Most user-reported "checkout is broken" reports map to one of:
- Quiklie `statusCode: 5` (account not HPP-provisioned, OR midType lane mismatch)
- CSP blocking iframe load
- PsiFi 30-min session expiry
- KingsGate iframe origin rotation (new CDN subdomain not in allowlist)
- Customer cleared cookies mid-flow / Safari ITP cookie partition
