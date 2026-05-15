# Customization Guide

Every place in the kit that needs to be wired into your host site is marked with a literal `// CUSTOMIZE:` comment in the source. This doc walks through each one.

Search the codebase: `grep -rn "CUSTOMIZE:" src/`

## 1. `src/lib/catalog.ts` — Catalog adapter

**What it is:** the kit's only inbound dependency on your product catalog.

**What it ships:** a hardcoded `DEMO_ITEM` ($15 demo product) and a hardcoded `DEMO10` coupon (10% off).

**What you replace it with:** an adapter to your real catalog + coupon storage.

### Required surface

```ts
export interface CartItem {
  sku: string;
  name: string;
  priceCents: number;
  quantity: number;
}

export interface Coupon {
  code: string;
  discountCents: number;
  description: string;
}

export function findCoupon(code: string): Coupon | null {
  // 1. Look up `code` in your DB.
  // 2. Verify expiry — return null if expired.
  // 3. Verify usage cap — return null if maxed.
  // 4. Optionally: verify per-customer cap (requires passing customerId).
  // 5. Return { code, discountCents, description } or null.
}
```

The cart item shape is what your client sends in mint requests. The mint routes (`/api/checkout/express` and `/api/checkout/express-psifi`) re-look up prices server-side (in your catalog table) — they don't trust the client's `priceCents`. So the catalog adapter should also expose a `findProduct(sku)` function that the mint routes call.

### Why server-side recompute matters

A malicious client could send `priceCents: 1` for a $15 product. If you trust the client's number, you charge $0.01. If you re-look up server-side from your products table, you charge $15 regardless of what the client claimed.

Pattern in the mint route:

```ts
const items = body.items.map((clientItem) => {
  const product = findProduct(clientItem.sku);
  if (!product) throw new Error(`Unknown SKU: ${clientItem.sku}`);
  return {
    sku: product.sku,
    name: product.name,
    priceCents: product.priceCents,         // ← server-trusted
    quantity: clientItem.quantity,           // ← client-supplied, but bounded by Zod
  };
});
```

The kit's demo `express` routes skip this step because the demo catalog has one product. Replace before shipping.

## 2. `src/lib/order-store.ts` — Order persistence

**What it is:** a process-local in-memory `Map` that holds order snapshots between mint and webhook.

**What it ships:** a working in-memory implementation that loses orders on function cold starts.

**What you replace it with:** a DB-backed adapter (Drizzle, Prisma, Kysely, raw SQL).

### Required surface

```ts
interface StoredOrder {
  orderNumber: string;
  rail: "cardsshield" | "psifi";
  psifiSessionId?: string;
  customer: { firstName; lastName; email; phone };
  shippingAddress: { address1; address2?; city; state; zip };
  totalCents: number;
  lineItems: Array<{ sku; name; priceCents; quantity }>;
  couponCode?: string;
  status: "unpaid" | "paid" | "failed";
  createdAt: number;
  updatedAt: number;
}

export const orderStore = {
  put(order: StoredOrder): void                    // INSERT or upsert by orderNumber
  get(orderNumber: string): StoredOrder | null
  patch(orderNumber, patch): StoredOrder | null    // UPDATE with returning
  findByPsifiSessionId(sessionId): StoredOrder | null
};

export function generateOrderNumber(): string {
  // Your own ID scheme. Must be unique across all orders and short
  // enough to fit in KingsGate's order_id field (typically 32 chars).
}
```

### Why a DB matters in production

The kit's in-memory store works for local dev + small demos but DOES NOT survive Vercel function cold starts. In production, an order minted in one Lambda invocation isn't visible to the polling route running in another invocation 30 seconds later. You'll see "Order not found locally" in logs, and the customer's "is my payment going through?" experience will be broken.

### Minimal Drizzle adapter

```ts
import { db } from "@/lib/db";
import { orders } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const orderStore = {
  put: async (order: StoredOrder) => {
    await db.insert(orders).values({
      orderNumber: order.orderNumber,
      // ... map fields ...
    }).onConflictDoUpdate({ target: orders.orderNumber, set: { updatedAt: new Date() } });
  },
  get: async (orderNumber: string) => {
    const [row] = await db.select().from(orders).where(eq(orders.orderNumber, orderNumber)).limit(1);
    return row ? { /* map back */ } : null;
  },
  // ...
};
```

(All four methods become `async`. The kit's route handlers already `await` them.)

## 3. `src/app/page.tsx` — Demo checkout page

**What it is:** a working reference implementation of the auto-fire pattern.

**What you replace it with:** your real product/cart UI, with the auto-fire pattern grafted in.

### Pieces to copy verbatim

1. The `RailSession` discriminated union type
2. The `fingerprint` `useMemo`
3. The auto-fire `useEffect` (including the rail branch)
4. The `iframeStatus` state machine
5. The "Try again" retry button + `retryNonce` mechanism

### Pieces to replace

- The hardcoded `DEMO_ITEM` — pull from your real cart state (CartProvider, Redux, Zustand, server-fetched, whatever).
- The form fields and summary card — your design system.
- The coupon UI — connect to your coupon validation endpoint (which calls `findCoupon` server-side).
- The page header copy ("Dual-rail checkout demo") — your branding.

### Pattern variations

The kit's demo assumes a single-page guest checkout (everything on one screen). If your site uses a multi-step wizard (cart → shipping → payment), the auto-fire effect goes on the payment step. Mount it when the user reaches that step; tear down (set `session` to null) when they navigate away.

For logged-in users with saved addresses, the `fingerprint` should switch from a string of typed values to a stable identifier of the SELECTED saved address (e.g. `saved:${addressId}`). Otherwise editing the customer-info section will spuriously invalidate sessions that are still valid for the same shipping address.

## 4. `src/app/api/psifi/notify/route.ts` — PsiFi fulfillment side effects

**What it is:** the webhook receiver for PsiFi events.

**What it ships:** signature verification + `after()` block that just flips the local order-store status.

**What you replace it with:** real fulfillment.

### What "real fulfillment" looks like

Inside the `after()` block, on `eventType === "transaction.updated" && status === "completed"`:

```ts
// 1. Look up the order
const order = await db.query.orders.findFirst({
  where: eq(orders.psifiSessionId, sessionId),
});
if (!order) {
  console.warn("[psifi-notify] no local order for session", sessionId);
  return;
}

// 2. Idempotent state flip (use conditional UPDATE so a redelivered
//    webhook doesn't double-fire side effects).
const result = await db.update(orders)
  .set({ paymentStatus: "completed", paidAt: new Date() })
  .where(and(eq(orders.id, order.id), eq(orders.paymentStatus, "unpaid")))
  .returning();
if (result.length === 0) return; // already marked paid; bail

// 3. Send receipt email
await sendReceiptEmail(order);

// 4. Push to fulfillment provider (ShipStation, ShipBob, etc.)
await pushToShipStation(order);

// 5. Fire conversion pixels (server-side)
await fireMetaConversion(order);
await fireGA4Purchase(order);

// 6. Increment coupon usage
if (order.couponCode) {
  await incrementCouponUsage(order.couponCode);
}

// 7. Affiliate commission tracking
if (order.referralAffiliateId) {
  await recordAffiliateCommission(order);
}
```

Note the "Idempotent state flip" pattern. PsiFi (Svix) will retry webhooks for up to 24h on non-2xx responses. If you process a webhook successfully but the 200 ACK is dropped due to network issues, Svix will redeliver. The atomic conditional UPDATE prevents double-firing side effects.

## 5. `src/app/api/cs/notify/route.ts` — KingsGate fulfillment side effects

**What it is:** the webhook receiver for KingsGate events.

**What it ships:** API 3.2 status verification + `after()` block that flips the local order-store status.

**What you replace it with:** same as PsiFi above — receipt email, fulfillment push, pixels, etc.

### One KingsGate-specific must-do

Save `status.shield_domain` to your order row. It's per-order and REQUIRED downstream for:

- API 10.1 — Refund (HMAC-signed call to `https://<shield_domain>?...`)
- API 10.2 — Tracking sync (same shield_domain endpoint)

Without it, you can't issue refunds programmatically. Sample:

```ts
await db.update(orders)
  .set({
    paymentStatus: "completed",
    paidAt: new Date(),
    csShieldDomain: status.shield_domain,    // ← REQUIRED for refunds later
    csTradeNo: status.trade_no,
  })
  .where(...);
```

## Cosmetic customization (NOT marked with `CUSTOMIZE:`)

### Tailwind theme tokens

The iframe components use design tokens like `bg-card`, `text-foreground`, `border-border`. If your site uses different token names, you can either:

1. Rename your tokens to match the kit's (recommended — the kit's tokens follow shadcn/ui conventions and are widely used).
2. Adjust `src/app/globals.css` to alias your tokens to the kit's. E.g.:
   ```css
   @theme {
     --color-card: var(--your-card-color);
     --color-foreground: var(--your-text-color);
     /* etc */
   }
   ```

### Iframe header strip text

`<PsifiEmbeddedFrame>` and `<CardsShieldEmbeddedFrame>` both show a "Secure payment" label with a green dot + a "PCI-DSS Level 1" badge in the header strip. Edit these strings directly in the components if you want different copy. The chrome is yours to restyle.

### Iframe max height

Both components accept a `maxHeight` prop (defaults to 720px). Pass a smaller value if your page layout is constrained. The components auto-clamp to a 580px floor.

### Footer caption

The footer says "Card details never touch our servers" + the order ref. Edit directly in the components.

## What NOT to customize

These are listed in [AGENTS.md](../AGENTS.md) but worth repeating:

- The gateway client libs (`psifi.ts`, `cardsshield.ts`) — their shapes match the gateways' specs.
- The auto-fire fingerprint structure — change it and you'll get spurious re-mints or stale-session deadlocks.
- The webhook signature verification — never disable "temporarily for debugging." Fail closed.
- The iframe completion-detection channels — they're load-bearing for the "no Pay button" UX.
- The env validator — silent fallbacks on typos hide outages.
