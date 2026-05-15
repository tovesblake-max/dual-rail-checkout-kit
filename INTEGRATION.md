# INTEGRATION.md — Drop-in guide for humans

A step-by-step walkthrough of dropping this kit into an existing Next.js 15 site. For AI-agent instructions see [AGENTS.md](./AGENTS.md). For the full architecture see [docs/architecture.md](./docs/architecture.md).

## Prerequisites

- A Next.js 15 app using the App Router and React 19.
- Tailwind CSS v4 (the components use `bg-card`, `text-foreground`, etc. — if you use different design tokens, you'll need a small Tailwind theme tweak in `src/app/globals.css`).
- A deployment provider that supports `next/server` `after()` — Vercel, Cloudflare Workers, or self-hosted Node. (Vercel is most thoroughly tested.)
- An account with at least ONE of the two gateways:
  - KingsGate via [thekingsgateway.com](https://thekingsgateway.com)
  - PsiFi via [app.psifi.app](https://app.psifi.app)

You can run with both, but you only need one to ship.

## Step 1 — Copy files into the host project

From the kit root, copy:

```
src/lib/checkout-config.ts        →  src/lib/checkout-config.ts
src/lib/psifi.ts                  →  src/lib/psifi.ts
src/lib/cardsshield.ts            →  src/lib/cardsshield.ts
src/lib/catalog.ts                →  (KEEP as reference; replace below)
src/lib/order-store.ts            →  (KEEP as reference; replace below)
src/components/PsifiEmbeddedFrame.tsx        →  src/components/PsifiEmbeddedFrame.tsx
src/components/CardsShieldEmbeddedFrame.tsx  →  src/components/CardsShieldEmbeddedFrame.tsx
src/app/api/checkout/express/route.ts        →  src/app/api/checkout/express/route.ts
src/app/api/checkout/express-psifi/route.ts  →  src/app/api/checkout/express-psifi/route.ts
src/app/api/checkout/result/route.ts         →  src/app/api/checkout/result/route.ts
src/app/api/psifi/notify/route.ts            →  src/app/api/psifi/notify/route.ts
src/app/api/cs/notify/route.ts               →  src/app/api/cs/notify/route.ts
src/app/api/cs/order-detail/route.ts         →  src/app/api/cs/order-detail/route.ts
src/app/checkout/callback/page.tsx           →  src/app/checkout/callback/page.tsx
src/app/embedded-bridge/page.tsx             →  src/app/embedded-bridge/page.tsx
```

Don't copy `src/app/page.tsx` (the demo page) — you'll write your own checkout page using the same auto-fire pattern.

## Step 2 — Merge `next.config.ts`

The kit's CSP allowlists `*.psifi.app`, `*.cardsshield.com`, `*.thekingsgateway.com`, `*.paymentshields.com`, `*.keysidecommerce.com`, and `*.paypal.com`. If the host already has a CSP, ADD these directives to the existing `frame-src` and `connect-src` — don't replace yours wholesale.

Without these CSP allowlists, the browser silently blocks the iframe and the checkout dies. Verify after deploy:

```bash
curl -sI https://your-site.com/checkout | grep -i content-security-policy
```

You should see all the rail-related domains in both `frame-src` and `connect-src`.

## Step 3 — Install dependencies

```bash
npm install lucide-react svix zod
```

(Plus `next`, `react`, `react-dom` which you already have.)

## Step 4 — Wire env vars

Copy the relevant block from `.env.example` into the host's `.env.local` and deployment provider:

```bash
# The switch
NEXT_PUBLIC_PRIMARY_CARD_RAIL=cardsshield   # or "psifi"
NEXT_PUBLIC_SITE_URL=https://your-site.com

# PsiFi (only if using)
PSIFI_API_KEY=...
PSIFI_WEBHOOK_SECRET=...

# CardsShield (only if using)
CS_GATEWAY_URL=https://your-merchant-gateway.cardsshield.com
CS_API_KEY=...
CS_PLATFORM_NAME=YOUR_PLATFORM_NAME
CS_ENDPOINT_TOKEN=...
CS_PAYMENT_GATEWAY=1
```

The build will FAIL with a clear error if `NEXT_PUBLIC_PRIMARY_CARD_RAIL` is missing or invalid. That's intentional.

## Step 5 — Replace `src/lib/catalog.ts` with your catalog adapter

The kit only needs:

```ts
export function findCoupon(code: string): Coupon | null {
  // Look up `code` in your coupons table.
  // Validate expiry + usage cap.
  // Return null if invalid.
}
```

The cart item shape used by the mint routes is `{ sku, name, priceCents, quantity }`. Keep `priceCents` server-trusted — never accept the client's claimed price as authoritative. The mint route should re-look up each SKU in your products table.

## Step 6 — Replace `src/lib/order-store.ts` with your DB adapter

The kit's in-memory `Map` doesn't survive function cold starts on Vercel. Replace it with a DB-backed adapter that implements the same interface:

```ts
export const orderStore = {
  put(order: StoredOrder): void           // INSERT or UPDATE in your DB
  get(orderNumber: string): StoredOrder | null
  patch(orderNumber: string, patch: Partial<StoredOrder>): StoredOrder | null
  findByPsifiSessionId(sessionId: string): StoredOrder | null
};
```

The `StoredOrder` shape (see `src/lib/order-store.ts`) is intentionally minimal. Extend it with your own fields (utm_*, customer_user_id, fulfillment_status, etc.). The kit's code paths only read the documented fields.

## Step 7 — Write your checkout page

The demo `src/app/page.tsx` is a working reference. The pattern to copy:

1. **State**: `customer`, `address`, `session: RailSession | null`, `mintError`, `retryNonce`.
2. **Fingerprint useMemo** — null until form validates; serializes everything that affects the session.
3. **Auto-fire useEffect** — debounced 800ms, AbortController for cancellation, branches on `CARD_RAIL` to pick endpoint + response handler.
4. **iframeStatus state machine** — `"idle" | "minting" | "ready" | "error"`.
5. **Render branches**: `<PsifiEmbeddedFrame>` when `session.rail === "psifi"`, `<CardsShieldEmbeddedFrame>` when `session.rail === "cardsshield"`.

The form fields + summary card are your design. The auto-fire logic is what makes the kit work.

## Step 8 — Wire fulfillment in the webhook handlers

Open `src/app/api/psifi/notify/route.ts` and `src/app/api/cs/notify/route.ts`. Each has a `// CUSTOMIZE:` comment inside the `after()` block.

You need to:

- Look up the order by `external_id` (PsiFi) or `order_id` (KingsGate).
- Flip `paymentStatus` to `paid` in your DB.
- Save `status.shield_domain` (KingsGate only) to your order row — required for refund + tracking later.
- Send a receipt email.
- Push to fulfillment (ShipStation, ShipBob, whatever).
- Fire conversion pixels (Meta, GA4, TikTok, etc.).
- Increment coupon usage counter.

All of this happens INSIDE `after()` so the response goes back to the gateway quickly. Slow handlers wedge the gateway's retry queue.

## Step 9 — Configure webhook URLs in each gateway portal

### PsiFi
- Log in to [app.psifi.app](https://app.psifi.app)
- Go to Webhooks → Endpoints → Add endpoint
- URL: `https://your-site.com/api/psifi/notify`
- Events: `transaction.updated` at minimum
- Copy the signing secret into `PSIFI_WEBHOOK_SECRET`

### KingsGate
- Log in to your KingsGate portal
- Find Notify URL setting — set to `https://your-site.com/api/cs/notify`
- Find Order Detail API URL — set to `https://your-site.com/api/cs/order-detail`
- (You may also need to add your domain to KingsGate's CSP `frame-ancestors` allowlist if they enforce one. Reach out to KingsGate support if the iframe loads blank.)

## Step 10 — Smoke test

```bash
# Build
npm run build

# Local dev test
npm run dev
# → open localhost:3000/your-checkout-page
# → fill in form → verify iframe loads
# → complete a $1 test order in PsiFi's sandbox or KingsGate's dev environment
# → verify the webhook hits your notify route (check logs)
# → verify the order flips to "paid" in your DB
# → verify the customer lands on /checkout/callback with success state

# Production
vercel --prod
# → repeat the test above against the live URL
# → set up gateway dashboards to monitor for outages
```

## Step 11 — Flip rails (when you need to)

```bash
cd your-site
vercel env rm NEXT_PUBLIC_PRIMARY_CARD_RAIL production --yes
echo "<rail>" | vercel env add NEXT_PUBLIC_PRIMARY_CARD_RAIL production
vercel --prod --yes
```

Replace `<rail>` with `cardsshield` or `psifi`. Full smoke-test procedure: [docs/payment-rail-switch.md](./docs/payment-rail-switch.md).

## Troubleshooting

### Build fails with `[checkout-config] NEXT_PUBLIC_PRIMARY_CARD_RAIL has invalid value`

The validator caught a typo. Valid values are exactly `cardsshield` or `psifi`. Common typos: `psify` (missing final i), `cardshield` (missing s), `kingsgate` (use `cardsshield` for that rail).

### Iframe loads but stays blank

Browser is silently blocking it via CSP. Open dev tools console; look for `Refused to frame ...`. Add the blocked origin to `next.config.ts` CSP `frame-src`, redeploy.

### Iframe loads but never sends a postMessage

The iframe's origin doesn't match the allowlist in the component. Open dev tools console; you'll see the inbound message origin in the `[CS_FORENSIC]` or polling logs. Add the origin substring to the whitelist in `src/components/CardsShieldEmbeddedFrame.tsx` (around line 165).

### "Order not found locally" in `/api/checkout/result`

You're using the kit's in-memory `order-store.ts` in production. Function cold starts wipe it. Replace with a DB adapter (Step 6).

### Webhook fires but signature verification fails

`PSIFI_WEBHOOK_SECRET` is wrong or has whitespace. The kit auto-trims, but copy-paste from a PDF can sneak in non-ASCII characters. Re-copy from the Webhook Portal.

### KingsGate iframe shows blank PayPal button area

KingsGate's PayPal subaccount is paused, OR `CS_PAYMENT_GATEWAY=2` (Stripe) is set instead of `1`. Set to `1` for the embedded-iframe PayPal flow. Stripe is a different (server-to-server) integration the kit doesn't ship.

### `Refused to load script from .../cs-loader.js due to MIME mismatch`

KingsGate's CDN occasionally serves with the wrong `Content-Type`. Usually transient. If it persists, contact KingsGate support.

## When the kit isn't enough

You'll outgrow the kit when:

- You need subscription billing (recurring charges, trial periods, etc.).
- You need multi-currency.
- You need a fraud-screening layer beyond what each gateway provides.
- Your checkout has deep CMS coupling (Shopify, Sanity, Contentful integration).
- You need observability beyond `console.log` (Sentry breadcrumbs, OpenTelemetry traces, PostHog funnel events).

When you reach those points, the kit's gateway clients (`src/lib/psifi.ts`, `src/lib/cardsshield.ts`) and iframe components are still useful — extract them as a standalone package. The auto-fire pattern is also reusable but typically needs adaptation to your data layer.
