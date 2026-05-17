# Dual-Rail Checkout Kit

**Drop-in Next.js 15 checkout with hot-swappable PsiFi + CardsShield/KingsGate rails. One env var picks which iframe renders. Same auto-fire UX on both.**

If you're an AI coding agent, read [AGENTS.md](./AGENTS.md) instead — it has machine-readable integration instructions.

---

## Why this exists

E-commerce sites that depend on a single payment processor break when that processor breaks. KingsGate's PayPal subaccount has gone down. PsiFi's gateway has thrown 502s. Stripe has had multi-hour outages. When it happens to a small merchant, every minute is lost revenue and refunds you'll be writing for weeks.

This kit gives you two production-grade card rails wired in parallel, both kept current 24/7, and a single env var to flip between them. Outage on one → flip to the other in 90 seconds. No code change. No customer disruption visible (same UX shape on both).

---

## The three rails

| Rail | UX shape | Backend | Settles | Use when |
| --- | --- | --- | --- | --- |
| `cardsshield` | `<CardsShieldEmbeddedFrame>` (inline iframe, auto-fire) | KingsGate API 1.2 → `/api/checkout/express` | Weekly to bank, PayPal owns ID verification, 0% reserve | Default. Near-zero chargebacks. ~3-4% blended rate. |
| `psifi` | `<PsifiEmbeddedFrame>` (inline iframe, auto-fire) | PsiFi v2 sessions → `/api/checkout/express-psifi` | Daily crypto to wallet, no KYC, no reserve | KingsGate down. Apple Pay / Google Pay / crypto / fiat in one iframe. ~10% rate. |
| `quiklie` | "Pay $X.XX" button → full-page redirect to Quiklie HPP | Quiklie HPP → `/api/checkout/express-quiklie-hpp` | Per Quiklie merchant agreement | High-risk-friendly card processor. PCI SAQ-A via hosted page. No embedded iframe (Quiklie's HPP X-Frame-Options behavior untested). |

`cardsshield` and `psifi` ship the same "single form → auto-fire inline iframe as soon as shipping validates → no Pay button" UX. `quiklie` uses the same form + auto-fire mint, but renders an explicit "Pay" button instead of an iframe (HPP only).

All three handle coupon re-mints, address edits, and abandoned cart cleanup symmetrically.

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│  YOUR SITE  (CARD_RAIL picked at build time from env var)         │
│                                                                   │
│   ┌──────────────────────┐    fingerprint changes                 │
│   │ shipping form        │ ──────────────┐                        │
│   └──────────────────────┘               ▼                        │
│                          ┌─────────────────────────────────┐      │
│                          │  auto-fire useEffect            │      │
│                          │  · debounce 800ms               │      │
│                          │  · AbortController cancels      │      │
│                          │    stale in-flight mints        │      │
│                          │  · forks on CARD_RAIL           │      │
│                          └─────────────┬───────────────────┘      │
│                                        ▼                          │
│           POST /api/checkout/express OR /api/checkout/express-psifi │
│                                        ▼                          │
│   ┌──────────────────────┐    ┌─────────────────────────────┐     │
│   │  RAIL                │    │  iframe component           │     │
│   │  cardsshield         │ ─▶ │  <CardsShieldEmbeddedFrame> │     │
│   │  psifi               │ ─▶ │  <PsifiEmbeddedFrame>       │     │
│   └──────────────────────┘    └─────────────────────────────┘     │
│                                        │                          │
│                                        │ 3-channel completion     │
│                                        │ detection                │
│                                        ▼                          │
│                          /checkout/callback (success / failure)   │
└───────────────────────────────────────────────────────────────────┘
```

---

## Quick start

```bash
# 1. Clone + install
git clone https://github.com/tovesblake-max/dual-rail-checkout-kit.git
cd dual-rail-checkout-kit
npm install

# 2. Configure
cp .env.example .env.local
# → set NEXT_PUBLIC_PRIMARY_CARD_RAIL=cardsshield (or psifi)
# → set NEXT_PUBLIC_SITE_URL=http://localhost:3000
# → set the active rail's credentials (see .env.example for full list)

# 3. Run
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), fill in the form, and watch the iframe auto-load. Try coupon code `DEMO10` to see the re-mint flow in action.

To flip rails: edit `NEXT_PUBLIC_PRIMARY_CARD_RAIL` in `.env.local`, restart `npm run dev`. (`NEXT_PUBLIC_*` vars are inlined at build time, so dev needs a restart.)

---

## Production deploy

```bash
npx vercel
```

Set the same env vars in the Vercel dashboard. Configure webhook URLs in each gateway's portal:

- **PsiFi** → `app.psifi.app` → Webhooks → Endpoints → add `https://<your-domain>/api/psifi/notify`
- **KingsGate** → portal → Webhooks → Notify URL → set to `https://<your-domain>/api/cs/notify`. Also set the Order Detail API URL to `https://<your-domain>/api/cs/order-detail`.

Smoke test by minting a $1 order on each rail. Both should land in your dashboard within 30s.

### To flip rails in production

```bash
npx vercel env rm NEXT_PUBLIC_PRIMARY_CARD_RAIL production --yes
echo "<rail>" | npx vercel env add NEXT_PUBLIC_PRIMARY_CARD_RAIL production
npx vercel --prod --yes
```

Replace `<rail>` with `cardsshield` or `psifi`. The build will hard-fail on a typo (the env validator throws on invalid values). Full runbook: [docs/payment-rail-switch.md](./docs/payment-rail-switch.md).

---

## What's in the box

```
dual-rail-checkout-kit/
├── README.md                     # this file
├── AGENTS.md                     # instructions for AI coding agents
├── INTEGRATION.md                # step-by-step drop-in guide for humans
├── LICENSE
├── .env.example                  # heavily commented env template
├── next.config.ts                # CSP allowlists for all three rails (REQUIRED)
├── package.json
├── tsconfig.json
├── docs/
│   ├── architecture.md           # deep technical reference
│   ├── payment-rail-switch.md    # the flip runbook
│   ├── customization.md          # every CUSTOMIZE: hook explained
│   └── troubleshooting.md        # statusCode 5, iframe-block, ITP, refunds
├── scripts/
│   └── probe-quiklie-hpp-embed.mjs  # dev tool: can Quiklie HPP be iframed?
├── src/
│   ├── app/
│   │   ├── page.tsx              # demo checkout (replace with your own)
│   │   ├── checkout/callback/    # post-purchase landing
│   │   ├── embedded-bridge/      # PsiFi → parent handoff
│   │   └── api/
│   │       ├── checkout/
│   │       │   ├── express/             # CardsShield mint
│   │       │   ├── express-psifi/       # PsiFi mint
│   │       │   ├── express-quiklie-hpp/ # Quiklie mint
│   │       │   └── result/              # rail-agnostic polling
│   │       ├── psifi/notify/      # PsiFi webhook
│   │       ├── quiklie/notify/    # Quiklie webhook
│   │       └── cs/
│   │           ├── notify/        # KingsGate webhook
│   │           └── order-detail/  # KingsGate API 0 callback
│   ├── components/
│   │   ├── PsifiEmbeddedFrame.tsx
│   │   └── CardsShieldEmbeddedFrame.tsx
│   └── lib/
│       ├── checkout-config.ts    # the env switch + validator (3 rails)
│       ├── psifi.ts              # PsiFi gateway client + webhook verify
│       ├── cardsshield.ts        # KingsGate gateway client + API 0 helper
│       ├── quiklie.ts            # Quiklie HPP client + refund + webhook verify
│       ├── catalog.ts            # demo catalog (replace)
│       └── order-store.ts        # in-memory store (replace with DB)
```

---

## Customization hook points

Every place you need to plug your own data layer in is marked with a literal `// CUSTOMIZE:` comment in the source. As of v1.1 there are six:

1. **`src/lib/catalog.ts`** — replace demo product + coupon with your catalog lookups.
2. **`src/lib/order-store.ts`** — replace in-memory `Map` with your DB.
3. **`src/app/page.tsx`** — replace the demo page with your real checkout UI (keep the auto-fire pattern).
4. **`src/app/api/psifi/notify/route.ts`** `after()` block — wire in your fulfillment.
5. **`src/app/api/cs/notify/route.ts`** `after()` block — same.
6. **`src/app/api/quiklie/notify/route.ts`** `after()` block — same.

Full details in [docs/customization.md](./docs/customization.md).

---

## Dev tools

**Probe whether Quiklie HPP can be iframed on your account:**

```bash
node ./scripts/probe-quiklie-hpp-embed.mjs
```

Mints a $0.50 test session, inspects `X-Frame-Options` + CSP `frame-ancestors` headers on the hosted page URL, reports a verdict. Useful for deciding whether to upgrade Quiklie from the default Pay-button-redirect UX to a true embedded iframe.

The probe also disambiguates Quiklie's confusing `statusCode: 5` failure — distinguishes "HPP not provisioned on your account" from "wrong midType lane."

---

## Troubleshooting

Common symptoms with diagnoses: [docs/troubleshooting.md](./docs/troubleshooting.md). Covers `statusCode 5`, iframe-block CSP errors, Safari ITP, KingsGate origin rotations, PsiFi session expiry, Quiklie refund via API (since the dashboard hides the button), and more.

---

## What this kit does NOT do

- **Subscription billing.** One-shot checkout only.
- **Fraud screening.** No 3DS challenge handling, velocity checks, or vendor fraud APIs. Each gateway has its own; wire to them separately.
- **Multi-currency.** USD only. All three rails support more — the kit just doesn't bother.
- **Account creation / login.** Guest checkout flow. If you need auth, layer it on the host site separately.
- **Cart persistence across devices.** No CartProvider, no session storage. The demo holds cart state in component state.

The kit is intentionally lean. It does the hard part — two gateways wired in parallel with a clean switch — and nothing else.

---

## License

MIT. See [LICENSE](./LICENSE).

---

## Related repos

- [psifi-autofire-checkout](https://github.com/tovesblake-max/psifi-autofire-checkout) — earlier focused reference implementation of just the PsiFi auto-fire iframe pattern.
- [psifi-checkout-starter](https://github.com/tovesblake-max/psifi-checkout-starter) — broader PsiFi-only integration including catalog sync + reconciliation cron.
