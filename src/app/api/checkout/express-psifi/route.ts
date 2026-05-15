import { NextResponse, after } from "next/server";
import { z } from "zod";
import {
  createCheckoutSession,
  expireCheckoutSession,
} from "@/lib/psifi";
import { findCoupon } from "@/lib/catalog";
import { orderStore, generateOrderNumber } from "@/lib/order-store";

/**
 * PsiFi mint route.
 *
 *   Returns: { orderNumber, sessionId, url, total, status: "redirect", method: "psifi" }
 *
 * Flow:
 *   1. Validate the incoming cart + customer + shipping data.
 *   2. Recompute the total server-side.
 *   3. Generate an orderNumber.
 *   4. Mint a PsiFi checkout session via /api/v2/checkout-sessions.
 *   5. If the client supplied `previousSessionId` (the session id
 *      from its previous mint on this page-load), schedule an
 *      `expireCheckoutSession` for it via Next.js `after()` so the
 *      cleanup happens off the response critical path.
 *   6. Stash the order in the store keyed by orderNumber for the
 *      webhook + polling endpoints to find later.
 *
 * Production hardening (intentionally NOT in the kit):
 *   - Rate limiting per IP
 *   - Duplicate-detection guard
 *   - DB transaction wrapping the order insert + session create
 *   - PSIFI_PLACEHOLDER_PRODUCT_ID fallback for SKUs not yet synced
 *
 * The kit's in-memory order store doesn't survive function cold
 * starts on Vercel — replace it with a DB before shipping.
 */

const schema = z.object({
  items: z
    .array(
      z.object({
        sku: z.string(),
        name: z.string(),
        priceCents: z.number().int().min(0),
        quantity: z.number().int().min(1),
      }),
    )
    .min(1),
  customer: z.object({
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    email: z.string().email().max(255),
    phone: z.string().min(7).max(30),
  }),
  shippingAddress: z.object({
    address1: z.string().min(1).max(255),
    address2: z.string().max(255).optional(),
    city: z.string().min(1).max(100),
    state: z.string().min(1).max(50),
    zip: z.string().min(1).max(20),
    country: z.string().default("US"),
  }),
  couponCode: z.string().min(1).max(50).optional(),
  idempotencyKey: z.string().regex(/^[a-fA-F0-9-]{16,64}$/),
  /** Embed iframe (true) or full-page redirect (false). */
  embedded: z.boolean().optional(),
  /** Previous session id from this page-load — expired off the
   *  critical path via after(). Optional. */
  previousSessionId: z.string().min(1).max(120).optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }
  const {
    items,
    customer,
    shippingAddress,
    couponCode,
    embedded,
    previousSessionId,
  } = parsed.data;

  const subtotal = items.reduce(
    (sum, i) => sum + i.priceCents * i.quantity,
    0,
  );
  let discount = 0;
  if (couponCode) {
    const coupon = findCoupon(couponCode);
    if (coupon) discount = coupon.discountCents;
  }
  const totalCents = Math.max(0, subtotal - discount);

  const orderNumber = generateOrderNumber();
  const siteUrl = (
    process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"
  )
    .trim()
    .replace(/\/+$/, "");

  const redirectUrl = embedded
    ? `${siteUrl}/embedded-bridge?order_number=${encodeURIComponent(orderNumber)}`
    : `${siteUrl}/checkout/callback?order_number=${encodeURIComponent(orderNumber)}&method=psifi`;

  // Optional contextual product. When set, the hosted page shows
  // your product name instead of a generic dollar amount line.
  const demoProductId = (process.env.PSIFI_DEMO_PRODUCT_ID || "").trim();
  const products = demoProductId
    ? items.map((i) => ({ productId: demoProductId, quantity: i.quantity }))
    : undefined;

  const sessionRes = await createCheckoutSession({
    orderNumber,
    totalDollars: totalCents / 100,
    products,
    customer: {
      email: customer.email,
      name: `${customer.firstName} ${customer.lastName}`.trim(),
      phone: customer.phone,
    },
    redirectUrl,
    webhookUrl: `${siteUrl}/api/psifi/notify`,
    expiresInSeconds: 1800,
    metadata: {
      order_number: orderNumber,
      coupon: couponCode || null,
      items_count: items.length,
    },
  });

  if (!sessionRes.ok || !sessionRes.data?.url) {
    return NextResponse.json(
      {
        orderNumber,
        error: "Payment gateway unavailable. Please try again.",
        psifi_debug: {
          http_status: sessionRes.status,
          error: sessionRes.error,
        },
      },
      { status: 502 },
    );
  }

  // Stash AFTER successful session creation so we have the
  // sessionId to bind to the order.
  orderStore.put({
    orderNumber,
    rail: "psifi",
    psifiSessionId: sessionRes.data.id,
    customer,
    shippingAddress,
    totalCents,
    lineItems: items,
    couponCode,
    status: "unpaid",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  // Stale-session cleanup. PsiFi's expire call is idempotent — safe
  // to fire even if the previous session was already paid / expired.
  if (previousSessionId && previousSessionId !== sessionRes.data.id) {
    after(async () => {
      try {
        await expireCheckoutSession(previousSessionId);
      } catch (err) {
        console.warn("[express-psifi] expire previous session failed", {
          previousSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  return NextResponse.json({
    orderNumber,
    sessionId: sessionRes.data.id,
    url: sessionRes.data.url,
    total: totalCents,
    status: "redirect",
    method: "psifi",
  });
}
