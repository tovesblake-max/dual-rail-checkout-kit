# Architecture

A technical reference for what the kit is actually doing under the hood. Read this if you're debugging an outage or extending the kit; skip if you just want to drop it in (see [INTEGRATION.md](../INTEGRATION.md)).

## Layered overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Browser                                                                    │
│                                                                             │
│  Checkout page                                                              │
│   ├─ Customer form (name, email, phone, address)                            │
│   ├─ Auto-fire useEffect                                                    │
│   │   ├─ fingerprint useMemo (null until form valid)                        │
│   │   ├─ debounce 800ms                                                     │
│   │   ├─ AbortController                                                    │
│   │   └─ branches on CARD_RAIL → fetch mint endpoint                        │
│   └─ Inline iframe component (rail-specific)                                │
│       ├─ <PsifiEmbeddedFrame>     — same-origin postMessage from bridge     │
│       └─ <CardsShieldEmbeddedFrame> — script-rehydrate + postMessage hbeat  │
│                                                                             │
└────────────────────┬────────────────────────────────────────────────────────┘
                     │ fetch
                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Next.js server (App Router routes)                                         │
│                                                                             │
│  /api/checkout/express          ← CardsShield mint (paymentFormHtml)        │
│  /api/checkout/express-psifi    ← PsiFi mint (sessionId + url)              │
│  /api/checkout/result           ← Rail-agnostic polling                     │
│  /api/cs/notify                 ← KingsGate webhook (verify via API 3.2)    │
│  /api/cs/order-detail           ← KingsGate API 0 callback                  │
│  /api/psifi/notify              ← PsiFi webhook (Svix-verified)             │
│                                                                             │
└────────────────────┬────────────────────────────────────────────────────────┘
                     │ HTTPS + signed
                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Gateway side                                                               │
│                                                                             │
│  KingsGate         api.cardsshield.com / *.keysidecommerce.com              │
│   └─ PayPal-backed iframe + sub-rail                                        │
│                                                                             │
│  PsiFi             api.psifi.app                                            │
│   └─ Apple Pay / Google Pay / card / crypto unified iframe                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## The switch

`src/lib/checkout-config.ts` reads `NEXT_PUBLIC_PRIMARY_CARD_RAIL` once at module-evaluation time. The constant is then imported by:

- `src/app/page.tsx` (or wherever your checkout lives) — branches the mint endpoint + iframe component
- Any analytics / display copy that wants to differentiate rails

Because `NEXT_PUBLIC_*` is inlined at BUILD time by Next.js, the value in the deployed bundle is fixed at deploy time. Changing the env var in your provider's dashboard does NOTHING without a redeploy. This is intentional — a runtime-readable value would create distributed state inconsistencies (some requests on old rail, some on new).

The validator throws on invalid values. A typo like `psify` won't silently fall back to a default; the build fails. We made this choice after an outage where a typo silently kept the broken rail live.

## Auto-fire mint pattern

The core UX win of the kit is "the iframe loads itself when shipping is valid." Implementation:

### Fingerprint

A `useMemo` that returns `null` until every form field validates, then returns a stable JSON hash of all the inputs that affect the gateway session:

```ts
const fingerprint = useMemo<string | null>(() => {
  if (!customer.firstName.trim()) return null;
  if (!customer.email.includes("@")) return null;
  // ...
  return JSON.stringify({
    c: { f: customer.firstName, e: customer.email, ... },
    a: { a1: address.address1, c: address.city, ... },
    items: items.map(i => `${i.sku}x${i.quantity}@${i.priceCents}`).join("|"),
    coupon: appliedCoupon?.code || null,
  });
}, [customer, address, items, appliedCoupon]);
```

Two things matter:
1. **Null until valid** — the auto-fire effect bails on null, so we never mint with incomplete data.
2. **Deterministic** — the same inputs always produce the same string, so we can compare it against the already-minted session's fingerprint to detect "needs re-mint."

### Debounced auto-fire effect

```ts
useEffect(() => {
  if (!fingerprint) return;                            // form not valid
  if (session?.fingerprint === fingerprint) return;    // already minted

  let cancelled = false;
  const timer = setTimeout(async () => {
    if (cancelled) return;
    if (mintAbortRef.current) mintAbortRef.current.abort();
    const ac = new AbortController();
    mintAbortRef.current = ac;
    // ... fetch with signal: ac.signal ...
  }, 800);

  return () => { cancelled = true; clearTimeout(timer); };
}, [fingerprint, retryNonce]);
```

Three layers of cancellation:

1. **Debounce timer cancellation** — if fingerprint changes again within 800ms, the previous timer is cleared before firing.
2. **`cancelled` flag** — if the effect's cleanup runs DURING the fetch (component unmount or fingerprint change while in-flight), the late response is ignored.
3. **`AbortController`** — actually cancels the network request so the fetch promise rejects with AbortError. Saves bandwidth + frees the connection.

The `retryNonce` dep is bumped by the "Try again" button to re-fire the effect even when fingerprint hasn't changed (recovery from a transient gateway 5xx).

### Previous-session cleanup

When a re-mint succeeds (e.g. customer applies a coupon), the previous session is now stale. For PsiFi we send `previousSessionId` in the next mint request; the route uses `next/server` `after()` to call `expireCheckoutSession` AFTER returning the new session, so the customer sees the new iframe immediately without waiting on the cleanup.

For CardsShield, there's no equivalent expire API. Stale orders are left to a cleanup cron (NOT included in this kit — add one to your host site if you care about merchant-dashboard tidiness).

## Iframe completion detection

Both rails need to detect when payment completes inside the iframe and navigate the parent window to `/checkout/callback`. The two rails use different mechanisms.

### PsiFi (`<PsifiEmbeddedFrame>`)

Three channels layered for reliability:

| Channel | Trigger | Latency | Failure mode |
| --- | --- | --- | --- |
| 1. postMessage | PsiFi redirects iframe to `/embedded-bridge` → bridge posts to parent | ~50ms | Safari ITP occasionally drops postMessages |
| 2. Polling | Parent polls `/api/checkout/result` every 2s | up to 2s | Always works (authoritative — reads PsiFi session state) |
| 3. onload URL inspection | iframe onload fires; check `contentWindow.location.href` for `/embedded-bridge` | ~50ms | Belt-and-braces; same trigger as channel 1 |

Any channel firing first wins; the others become idempotent no-ops via the `completedRef` guard.

Origin validation: the bridge page lives on our own domain, so `event.origin === window.location.origin` is the right check. Anything else is either PsiFi chrome chatter or a forgery attempt.

### CardsShield (`<CardsShieldEmbeddedFrame>`)

KingsGate's iframe does NOT redirect to a bridge page. Instead, when payment completes, the iframe redirects the PARENT window directly to `/checkout/callback?order_number=...`. So no parent-side completion detection is needed.

What the parent DOES do during the iframe's lifetime:

1. **100ms heartbeat** — sends `cs-platformValidationStatus` + `mecom-paypalPlatformValidationStatus` postMessage to the iframe every tick, telling it our shipping form is valid. Required by the KingsGate spec.
2. **postMessage listener** — when the iframe asks for shipping data (via `cs-feedbackPlatformValidationStatus` or the `mecom-paypal*` analog), we respond with `cs-platformOrderInfo` containing the shipping payload in KingsGate's exact field shape.
3. **Resize handler** — the iframe asks the parent to set its height via `mecom-paypalBodyResizeContainer`. We clamp to 192-720px and apply.
4. **Origin allowlist** — only accept messages from `*.cardsshield.com`, `*.thekingsgateway.com`, `*.paymentshields.com`, `*.keysidecommerce.com`. KingsGate's brand surfaces have multiplied; missing any of these breaks the integration.
5. **Boot timeout** — 15s after mount, if no postMessage from a CardsShield origin has arrived, show a "payment unavailable" error.

## API 0 callback (CardsShield-only)

KingsGate's iframe hits `/api/cs/order-detail` DURING iframe mount to read order details. The customer's iframe sits idle until our response comes back, so the endpoint MUST be fast (<500ms) and return the order in the exact spec shape.

The kit's `order-store.ts` is the in-memory backing for this. Production: replace with DB lookup. The response shape is `CSOrderDetail` (see `src/lib/cardsshield.ts`).

Auth: shared-secret via `api_key` query string. KingsGate doesn't use HMAC signing for this call — just the same key we send outbound. Constant-time-equal compare via `verifyApiKeyHeader`.

## Webhooks

Both rails fire webhooks to notify us when payment completes. The kit handles both with the same general pattern:

1. Read raw body (needed for signature verification — the signature is computed over the exact bytes, not the parsed JSON).
2. Verify signature.
3. Return 200 OK immediately.
4. Run side effects in `next/server` `after()` so they don't block the response.

### Why `after()` matters

Vercel functions terminate as soon as the response stream closes, and any pending Promise gets killed mid-flight. We learned this the hard way when fulfillment emails stopped firing on a production deploy: fire-and-forget `sendEmail(...).catch(...)` got cancelled the moment the route handler returned 200.

`after()` is Next.js 15's official primitive for "do this after the response is sent but before the runtime shuts down." It's the right tool for fulfillment side effects.

### Signature verification

- **PsiFi** uses Svix. Headers: `svix-id`, `svix-timestamp`, `svix-signature`. The signed payload is `{id}.{timestamp}.{body}`. Secret format is `ep_<rawstring>` or `whsec_<base64>`; the kit handles both. Fails closed on missing/invalid signatures.
- **CardsShield** doesn't sign the notify call. The webhook just informs us that something happened with `order_id=...`. We MUST follow up by calling API 3.2 (`getPaymentStatus`) server-to-server to verify the actual status. Treating the inbound webhook as authoritative would let an attacker forge fulfillment by hitting the URL directly.

## Polling endpoint contract

`/api/checkout/result` is rail-agnostic. The iframe components call it every 2s during their pre-completion window. It:

1. Looks up the order in `order-store` by `orderNumber` OR `sessionId`.
2. If the local record already says paid/failed, short-circuit (don't call the gateway).
3. Otherwise, call the appropriate rail's status API.
4. Normalize the response to `{ status: "completed" | "failed" | "pending" }`.

Status normalization:
- Gateway-side `completed` → `"completed"` (iframe component navigates to callback)
- Gateway-side `expired` or `failed` → `"failed"` (iframe component tears down + shows retry)
- Anything else (including gateway errors) → `"pending"` (iframe component keeps polling)

Treating gateway errors as `pending` is intentional. A transient 503 from the gateway shouldn't trigger a customer-visible "payment failed" tile.

## Order-store contract

The in-memory store (`src/lib/order-store.ts`) provides four operations:

```ts
put(order: StoredOrder): void
get(orderNumber: string): StoredOrder | null
patch(orderNumber: string, patch: Partial<StoredOrder>): StoredOrder | null
findByPsifiSessionId(sessionId: string): StoredOrder | null
```

In production, replace with a DB adapter that implements the same interface. The `StoredOrder` shape is intentionally minimal — extend it freely.

Why a separate `findByPsifiSessionId`: PsiFi webhooks identify orders by `session_id`, not `orderNumber`. The kit could pass `external_id` (= orderNumber) through PsiFi's metadata and rely on that, but the session-id index is faster and more direct.

## CSP

```
frame-src:
  'self'
  *.psifi.app                  # PsiFi hosted checkout
  *.cardsshield.com            # Legacy KingsGate domain
  *.thekingsgateway.com        # KingsGate docs + portal
  *.paymentshields.com         # KingsGate gateway API egress
  *.keysidecommerce.com        # KingsGate iframe body content
  *.paypal.com                 # PayPal SDK loaded inside the KingsGate iframe

connect-src:
  'self'
  (same list as frame-src)
```

Without these allowlists, the browser silently blocks the iframe and the checkout dies. We've debugged this so many times that the kit's `next.config.ts` ships with all of them baked in.

## Build-time vs runtime configuration

| What | When read | Why |
| --- | --- | --- |
| `NEXT_PUBLIC_PRIMARY_CARD_RAIL` | Build time (inlined into bundle) | Picks which rail's code paths are reachable; runtime flip would create inconsistent state |
| `NEXT_PUBLIC_SITE_URL` | Build time | Used to construct webhook callback URLs |
| `PSIFI_API_KEY`, `CS_API_KEY`, etc. | Runtime (server-only env) | Secrets — never want these inlined into the client bundle |
| `PSIFI_WEBHOOK_SECRET` | Runtime | Secret — same reason |

If you need a runtime-readable rail (e.g. for canary deploys), you'd need to refactor the iframe components to render BOTH and pick at render time based on an API-fetched config. The kit does NOT do this — it's deliberately a build-time switch.

## Things the kit deliberately doesn't do

- **No automatic failover.** Today the flip is operator-driven. Real auto-failover requires either a load balancer in front of both rails or a client-side retry that swaps endpoints on 5xx. Both add significant complexity. If you genuinely need <1min outage tolerance, the kit is the wrong tool — you want a multi-region deployment with health-checked routing.
- **No retry queue.** Failed webhook deliveries from the gateway aren't replayed by us. PsiFi (Svix) retries automatically for 24h. KingsGate retries per their own schedule (typically 3 attempts over 1h).
- **No reconciliation cron.** If a webhook is dropped beyond the gateway's retry window, the order sits in `unpaid` forever. Production sites should add a cron that walks `unpaid` orders < N hours old and polls each gateway's status API. The kit's `findRecentMatchingOrder`-style cron is in the broader SWB repo if you need a starting point.
- **No idempotency cache.** The kit accepts an idempotency-key in the mint request body and passes it to PsiFi's `Idempotency-Key` header / KingsGate's request, so the GATEWAY dedupes. But we don't dedupe at our own server before the gateway call. Production should add a Redis-backed claim/release cache (the broader SWB repo has one in `src/lib/idempotency.ts`).
