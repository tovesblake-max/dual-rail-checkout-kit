/**
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CUSTOMIZE: replace this file with your real catalog adapter.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * The kit only needs two surfaces from the catalog:
 *
 *   1. `findCoupon(code)` — server-side coupon validation, called
 *      from both mint routes. Production should hit your DB with
 *      expiry / usage-cap checks. The demo just hardcodes one code.
 *
 *   2. The shape of cart items in the mint-route request body. See
 *      `src/app/api/checkout/express/route.ts` schema for the exact
 *      fields. Keep `priceCents` server-trusted — never accept the
 *      client's claimed price as authoritative.
 *
 * The DEMO_ITEM export below is referenced from the demo checkout
 * page (`src/app/page.tsx`) so the kit ships as a working
 * standalone example. In real integration, replace the demo page
 * with your real product/cart UI and delete DEMO_ITEM.
 */

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

// Demo catalog — one item at $15.
export const DEMO_ITEM: CartItem = {
  sku: "DEMO-001",
  name: "Demo Product",
  priceCents: 1500,
  quantity: 1,
};

// Demo coupon — DEMO10 takes $1.50 off (10% of $15).
const COUPONS: Record<string, Coupon> = {
  DEMO10: {
    code: "DEMO10",
    discountCents: 150,
    description: "10% off the demo product",
  },
};

export function findCoupon(code: string): Coupon | null {
  return COUPONS[code.trim().toUpperCase()] ?? null;
}
