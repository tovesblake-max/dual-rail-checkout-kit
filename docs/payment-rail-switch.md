# Payment Rail Switch — Runbook

How to flip between CardsShield and PsiFi without downtime. Read [docs/architecture.md](./architecture.md) first if you want to understand WHY this works the way it does.

## The procedure (in three commands)

```bash
cd <your-site>

# 1. Replace the env value
vercel env rm NEXT_PUBLIC_PRIMARY_CARD_RAIL production --yes
echo "<rail>" | vercel env add NEXT_PUBLIC_PRIMARY_CARD_RAIL production

# 2. Redeploy (REQUIRED — NEXT_PUBLIC_* is inlined at build time)
vercel --prod --yes

# 3. Smoke-test (see below)
```

Replace `<rail>` with either `cardsshield` or `psifi`. Anything else hard-fails the build via the env validator.

## When to flip

| Trigger | Action |
| --- | --- |
| KingsGate portal shows webhook delivery failures > 5% | Flip to PsiFi |
| KingsGate PayPal subaccount paused / under review | Flip to PsiFi |
| PsiFi API returning > 5% 5xx | Flip to CardsShield |
| Customer complaints about declines spike on one rail | Investigate the rail; flip if confirmed broken |
| Planned migration / pricing renegotiation | Flip in advance, leave a week before flipping back |

A non-trigger: "this rail's rate is higher than the other." Don't flip back and forth on rate. Pick the cheaper rail as default; the expensive one is there for outages.

## Smoke tests after a flip

Run all four. Any fails → flip back immediately.

### 1. Routing is correct

```bash
curl -sI https://<your-domain>/checkout | grep -iE "HTTP|location"
# Expect: HTTP/2 200 (or your normal cache headers)
```

### 2. Active rail label

Visit the checkout page in incognito. The page header should mention the rail you just flipped to (the demo page in this kit prints `Active rail: <rail>` for debugging — production sites should remove this).

### 3. Real $1 test order

- Open `/catalog` in incognito.
- Add one item.
- Click "Checkout".
- Fill in name/email/phone/address.
- Iframe auto-loads.
- Complete a $1 charge (use the gateway's sandbox if available; in prod, use a real card on a real $1 item and refund after).
- Verify "Payment received" UI.
- Verify the order appears in admin within 30s.

### 4. Webhook delivery

Check Vercel function logs for the rail's notify route:
- CardsShield → `/api/cs/notify`
- PsiFi → `/api/psifi/notify`

Both routes stay live regardless of which rail is primary. A late webhook from the OTHER rail (e.g. a customer who paid via PsiFi right before the flip) still gets honored.

## What to monitor for 24 hours post-flip

- **Card decline rate.** Both rails report this in their dashboards.
- **Webhook delivery success.**
  - CardsShield → KingsGate portal → Webhooks log
  - PsiFi → app.psifi.app → Webhooks → Endpoints → recent deliveries
- **Customer-service inbox** for "I paid but no confirmation" emails — early warning of a stuck reconcile / dropped webhook.
- **Conversion funnel.** Whatever you use (PostHog, GA4, Heap, Mixpanel) — track `checkout_started` → `checkout_session_created` → `checkout_completed` for the day before vs day of. Drop-off > 5% above baseline is worth investigating.

## Common failures

### "Flip didn't take — customers still on old rail"

You forgot to redeploy. `vercel env add` writes the value to Vercel's storage, but existing deploys keep their old inlined value until the next build.

Fix: `vercel --prod --yes` after every env change. Always.

### Build fails with `[checkout-config] NEXT_PUBLIC_PRIMARY_CARD_RAIL has invalid value`

The validator caught a typo. Valid values are exactly `cardsshield` or `psifi`.

Common typos:
- `psify` (missing final i)
- `cardshield` (missing s)
- `kingsgate` (use `cardsshield` for that rail — the env value is the rail's CLIENT identifier, not the brand)
- `paypal` (use `cardsshield` — KingsGate's PayPal sub-flow is what `cardsshield` selects)

### Iframe loads but stays blank

CSP is blocking it. Check the browser console for `Refused to frame ...`. Add the blocked origin to the host's `next.config.ts` CSP `frame-src`. Same applies to `connect-src` for XHR egress from inside the iframe.

### KingsGate iframe loads but PayPal button does nothing

KingsGate's PayPal subaccount is paused, or `CS_PAYMENT_GATEWAY=2` (Stripe) is set instead of `1`. Set to `1`.

If the subaccount is paused for real (KingsGate ops issue), flip to PsiFi immediately while you reach out to KingsGate support.

### PsiFi iframe instantly shows "session expired"

PsiFi session TTL is 1800s. If the customer sits on the page for 30+ min, the session goes stale. The auto-fire client mints a new one on the next fingerprint change.

Workaround: refresh the page.

### Webhook signature verification fails

`PSIFI_WEBHOOK_SECRET` is wrong. Re-copy from `app.psifi.app` → Webhooks → endpoint detail. The secret format is `ep_<rawstring>` or `whsec_<base64>`; copy the full string including the prefix.

Common cause: copy-paste from a PDF sneaks in a non-ASCII character (curly quote, em-dash, etc.). The kit auto-trims whitespace but can't normalize encoding. If your secret looks correct but verification fails, retype it manually.

## Disabling all checkout (emergency)

The kit doesn't ship a maintenance kill-switch. If both rails are broken simultaneously and you need to stop taking orders entirely, the fastest path is:

```bash
# Hot-patch the checkout page to redirect to /maintenance
echo "export default function() { return null; }" > src/app/page.tsx
vercel --prod --yes
```

Or set up a route-level redirect via middleware. A proper kill-switch (env var → middleware 503) is on the TODO list but not built.

## Auditing the switch

Every flip should leave a trail. Recommended log entry shape (in your team's incident tracker):

```
Timestamp:     2026-05-15 14:32 UTC
From rail:     psifi
To rail:       cardsshield
Reason:        PsiFi returning 5xx > 8% over the last 15 min (see Vercel logs)
Smoke-tested:  ✓ routing, ✓ active label, ✓ $1 test order, ✓ webhook
Operator:      blake
Rollback ETA:  N/A (will stay on cardsshield until PsiFi confirms resolution)
```

This makes post-mortems trivial and prevents the "wait, did we already flip back?" confusion that happens during long outages.
