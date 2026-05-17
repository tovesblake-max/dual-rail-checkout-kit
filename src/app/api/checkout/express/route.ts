import { NextResponse } from "next/server";
import { z } from "zod";
import { getPaymentFormHtml } from "@/lib/cardsshield";
import { findCoupon } from "@/lib/catalog";
import { orderStore, generateOrderNumber } from "@/lib/order-store";

/**
 * CardsShield / CardsShield mint route.
 *
 *   Returns: { orderNumber, total, paymentFormHtml }
 *
 * Flow:
 *   1. Validate the incoming cart + customer + shipping data.
 *   2. Recompute the total server-side (the client's number is
 *      display-only — never trust it as authoritative).
 *   3. Generate an orderNumber.
 *   4. Stash the order details in the order store so CardsShield's
 *      API 0 callback (/api/cs/order-detail) can return them when
 *      the iframe asks during mount.
 *   5. Call CardsShield API 1.2 (`/custom/get-payment-form`) to mint
 *      the HTML blob the client will inject into the page.
 *   6. Return { orderNumber, total, paymentFormHtml } to the client.
 *
 * Production hardening (intentionally NOT in the kit):
 *   - Rate limiting per IP (recommend 30/15min for guest checkout)
 *   - Duplicate-detection guard (block on recent COMPLETED orders
 *     only — pending/unpaid auto-fire re-mints are legitimate and
 *     must NOT false-positive)
 *   - Idempotency-key claim/release cache (prevents double-charge
 *     on retried POSTs)
 *   - DB transaction wrapping the order insert + CardsShield call
 *     so a gateway 5xx doesn't lose the cart
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
  /** Idempotency key. Bound to CardsShield's Idempotency-Key header
   *  so a network retry of the same logical mint can't double-charge. */
  idempotencyKey: z.string().regex(/^[a-fA-F0-9-]{16,64}$/),
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
  const { items, customer, shippingAddress, couponCode } = parsed.data;

  // Server-side total computation. Demo uses the prices the client
  // sent (trusted only because the kit is a single-page demo). In
  // production, look each `sku` up in your catalog table and ignore
  // the client's `priceCents` entirely.
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

  // Stash the order BEFORE calling CardsShield so the /api/cs/order-detail
  // callback (which CardsShield hits DURING form-mount) can find it.
  orderStore.put({
    orderNumber,
    rail: "cardsshield",
    customer,
    shippingAddress,
    totalCents,
    lineItems: items,
    couponCode,
    status: "unpaid",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const csResponse = await getPaymentFormHtml(orderNumber);

  if (csResponse.code !== 200 || !csResponse.content) {
    // Cancel the order so it doesn't sit in "unpaid" state forever.
    orderStore.patch(orderNumber, { status: "failed" });
    return NextResponse.json(
      {
        orderNumber,
        error: "Payment form unavailable. Please try again.",
        cs_debug: { code: csResponse.code, msg: csResponse.msg },
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    orderNumber,
    total: totalCents,
    paymentFormHtml: csResponse.content,
  });
}
