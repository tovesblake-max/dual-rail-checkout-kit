# Troubleshooting

Symptoms and what they mean. Distilled from real production incidents.

## Build fails with `[checkout-config] NEXT_PUBLIC_PRIMARY_CARD_RAIL has invalid value`

The env validator caught a typo. Valid values are exactly `cardsshield`, `psifi`, or `quiklie`.

Common typos to watch for: `psify` (missing final `i`), `cardshield` (missing `s`), `kingsgate` (use `cardsshield` — that env value selects KingsGate's PayPal sub-flow), `quicklie` (extra `c`).

## Quiklie returns `statusCode: 5` on every mint

Code 5 is Quiklie's "ERROR" — routing failure. Its meaning is in the `message` field:

| `message` text | What it means | Fix |
|---|---|---|
| `"No eligible payment processors available for the requested transaction"` | HPP flow is not provisioned on your merchant account | Email Quiklie support: "Please enable HPP routing (`/api/v2/process-payment/hpp`) on merchant ID `<your-id>`." |
| `"No eligible MIDs available for the requested transaction"` | HPP is provisioned but your `midType` doesn't match the lane | Flip `NEXT_PUBLIC_QUIKLIE_HPP_MIDTYPE` to the opposite value (`TWO_D` ↔ `THREE_D`) and retry |

Run the probe to diagnose which case you're in:

```bash
QUIKLIE_API_KEY=... QUIKLIE_MERCHANT_ID=... node ./scripts/probe-quiklie-hpp-embed.mjs
```

The script reads the `message` field and tells you which fix to apply.

## Iframe loads but stays blank (cardsshield or psifi)

Browser is silently blocking it via Content-Security-Policy. Open dev tools → Console; look for `Refused to frame ...`.

Fix: add the blocked origin to the host's `next.config.ts` CSP `frame-src`. If you're integrating this kit into an existing Next.js app, you need to MERGE the CSP from this kit's `next.config.ts` into the host's CSP — don't replace yours wholesale, but make sure ALL these origins land in both `frame-src` and `connect-src`:

```
*.psifi.app
*.cardsshield.com
*.thekingsgateway.com
*.paymentshields.com
*.keysidecommerce.com
*.paypal.com
*.quiklie.com
```

## KingsGate iframe loads but the PayPal button does nothing

KingsGate's PayPal subaccount is paused, or `CS_PAYMENT_GATEWAY=2` (Stripe) is set instead of `1`. Set to `1` for the PayPal sub-flow. (The kit doesn't ship the Stripe sub-flow because it's a different — server-to-server — integration.)

If the subaccount is genuinely paused, flip the rail to PsiFi or Quiklie in the meantime.

## CardsShield iframe never sends a postMessage; spinner sits forever

The iframe's origin doesn't match the allowlist in `<CardsShieldEmbeddedFrame>`. KingsGate occasionally rotates the iframe-serving CDN to a new subdomain.

Open dev tools → Console; find the inbound `[CS_FORENSIC]` logs to see the actual message origin. Add the new origin substring to the whitelist in `src/components/CardsShieldEmbeddedFrame.tsx` (search for `origin.includes`).

## PsiFi iframe instantly shows "session expired"

PsiFi sessions have a 1800s (30 min) TTL. If the customer sat on the page for 30+ min, the session went stale. The auto-fire client mints a new one on the next fingerprint change (any form edit). Workaround for the customer: refresh the page.

## Webhook signature verification fails (PsiFi)

`PSIFI_WEBHOOK_SECRET` is wrong. Re-copy from `app.psifi.app` → Webhooks → endpoint detail. The secret format is `ep_<rawstring>` or `whsec_<base64>` — copy the FULL string including the prefix.

Common cause: copy-paste from a PDF sneaks in a non-ASCII character (curly quote, em-dash). The kit auto-trims whitespace but can't normalize encoding. If the secret looks correct but verification still fails, retype it manually.

## Quiklie webhook returns 401 "Unauthorized"

The `X-API-Key` header that Quiklie sent doesn't match what we expect. Two possibilities:

1. You set `QUIKLIE_WEBHOOK_API_KEY` in your env but Quiklie is using a different key for webhooks. Either drop `QUIKLIE_WEBHOOK_API_KEY` (so the verifier falls back to `QUIKLIE_API_KEY`) or update it to match what Quiklie actually sends.
2. The keys have whitespace from an env-add command. The lib auto-trims, but check for trailing newlines: `cat .env.local | grep -E '^QUIKLIE' | cat -A` will show invisible characters.

## "Order not found locally" in `/api/checkout/result`

You're using the kit's in-memory `order-store.ts` in production. Function cold starts on Vercel wipe it. **Replace with a DB adapter before shipping.** See `docs/customization.md` for the replacement pattern.

## Customer paid but no shipping confirmation email

For each rail, the email fires from the webhook handler:
- PsiFi: `/api/psifi/notify` → look in the `after()` block for your custom-wired email send
- CardsShield: `/api/cs/notify` → same pattern
- Quiklie: `/api/quiklie/notify` → same pattern

The kit ships these handlers with a `CUSTOMIZE:` comment pointing at the side-effects block. If you skipped wiring up email there, customers won't get notified. Re-check `docs/customization.md` step 4-5.

## Refunding a Quiklie order

The Quiklie merchant DASHBOARD does not expose a refund button (as of 2026-05-17). Refunds work via API only.

Use the helper:

```ts
import { processRefund } from "@/lib/quiklie";

const result = await processRefund({
  transactionId: order.quikliePaymentId, // stored at mint time
  amountDollars: 15.00,                  // partials supported
  reason: "Customer requested",          // optional, ≤500 chars
});

if (result.ok && result.data?.statusCode === "6") {
  // success — code 6 = REFUNDED
} else if (result.data?.statusCode === "7") {
  // code 7 = REFUND_FAILED (gateway accepted, issuer rejected)
}
```

You'll likely want to wrap this in an admin-gated route (e.g. `/api/admin/orders/refund`).

## Switching rails in production

```bash
vercel env rm NEXT_PUBLIC_PRIMARY_CARD_RAIL production --yes
echo "<rail>" | vercel env add NEXT_PUBLIC_PRIMARY_CARD_RAIL production
vercel --prod --yes
```

`NEXT_PUBLIC_*` env vars are inlined at BUILD time, not read at runtime. The redeploy in step 3 is REQUIRED — without it, the env value changes but nothing on the site does.

See `docs/payment-rail-switch.md` for the full procedure including smoke tests.

## Probing whether Quiklie HPP can be embedded in an iframe

The kit defaults Quiklie to full-page redirect because Quiklie's HPP X-Frame-Options behavior varies per merchant config. To check if YOUR account permits iframe embedding:

```bash
node ./scripts/probe-quiklie-hpp-embed.mjs
```

The script mints a $0.50 test session, fetches the HPP URL, and inspects `X-Frame-Options` + CSP `frame-ancestors` headers. Renders a verdict ("EMBEDDABLE" or "NOT EMBEDDABLE") with reasoning.

If embeddable, you can build a `<QuiklieHppFrame>` component (mirror `<PsifiEmbeddedFrame>`) and swap the Pay-button branch in `src/app/page.tsx` for the iframe. Trade-off: +3-8% completion rate vs ~1-3% lower card auth rate (issuer iframe-context bias). A/B test before rolling out fully.

## Stale ShipStation references in code search

This kit is checkout-only. It does NOT integrate with any fulfillment platform (ShipStation, ShipBob, etc.). If you see ShipStation mentioned in your downstream consumer code, that's host-site integration code you've added on top of the kit — not anything this kit ships.

For fulfillment integration patterns (ShipStation Custom Store pull vs push, KingsGate `autoSyncTrackingForOrder`, etc.), see the broader Stillwater BioLabs reference at https://github.com/tovesblake-max/psifi-checkout-starter.

## When the kit isn't enough

You've outgrown the kit if you need:
- Subscription billing (recurring charges, trial periods)
- Multi-currency
- Server-side fraud screening (Sift, Kount, etc.)
- 3DS challenge UX customization
- Deep CMS coupling (Shopify, Sanity, Contentful)
- Per-BIN or risk-score-based rail routing

At that point, the kit's gateway client libs (`src/lib/*.ts`) and iframe components stay useful as standalone primitives, but extract them as a package and replace the controller layer with your own.
