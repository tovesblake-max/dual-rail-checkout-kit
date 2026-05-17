import { NextResponse } from "next/server";
import { z } from "zod";
import { processPaymentHPP } from "@/lib/quiklie";
import { findCoupon } from "@/lib/catalog";
import { orderStore, generateOrderNumber } from "@/lib/order-store";

/**
 * Quiklie HPP (Hosted Payment Page) mint route.
 *
 *   Returns: { orderNumber, sessionId, url, total, status: "redirect", method: "quiklie" }
 *
 * Flow:
 *   1. Validate the incoming cart + customer + shipping data.
 *   2. Recompute the total server-side (the client's number is
 *      display-only — never trust it as authoritative).
 *   3. Generate an orderNumber.
 *   4. Call Quiklie /api/v2/process-payment/hpp → returns
 *      `quikleeRedirectUrl` (the hosted payment page URL).
 *   5. Stash the order in the store so the webhook handler + result
 *      polling endpoints can find it by orderNumber.
 *   6. Return the redirect URL to the client; client full-page-navigates
 *      the customer to Quiklie's HPP. Customer enters card data on
 *      Quiklie's domain (PCI SAQ-A — your origin never sees PAN/CVV).
 *   7. After payment, Quiklie redirects the browser back to our
 *      `redirectUrl` (typically /checkout/callback?order_number=...)
 *      AND fires an async webhook to /api/quiklie/notify with the
 *      final result.
 *
 * Quiklie-specific gotcha: midType must match what your merchant
 * account is provisioned for. The wrong value returns statusCode 5
 * "No eligible MIDs available." Default is TWO_D — override via
 * NEXT_PUBLIC_QUIKLIE_HPP_MIDTYPE=THREE_D if Quiklie support tells
 * you your account uses the 3DS lane.
 *
 * Production hardening (not in the kit):
 *   - Rate limiting per IP
 *   - Duplicate-detection guard (only block on COMPLETED matches —
 *     pending re-mints are legitimate)
 *   - DB transaction wrapping order insert + gateway call
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
  const { items, customer, shippingAddress, couponCode, idempotencyKey } = parsed.data;

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

  // midType default: TWO_D matches what most non-3DS Quiklie merchant
  // accounts are provisioned for. If your account requires 3DS, set
  // NEXT_PUBLIC_QUIKLIE_HPP_MIDTYPE=THREE_D in your env.
  const midType =
    process.env.NEXT_PUBLIC_QUIKLIE_HPP_MIDTYPE === "THREE_D"
      ? ("THREE_D" as const)
      : ("TWO_D" as const);
  const descriptor = (process.env.QUIKLIE_DESCRIPTOR || "DEMO STORE").slice(0, 22);

  // Extract caller IP from headers (best-effort — Quiklie wants
  // SOMETHING, even 0.0.0.0 is accepted but ip-based fraud rules work
  // better with the real one).
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "0.0.0.0";

  const quiklieRes = await processPaymentHPP({
    amountDollars: totalCents / 100,
    billing: {
      firstName: customer.firstName,
      lastName: customer.lastName,
      email: customer.email,
      phone: customer.phone,
      address: shippingAddress.address1,
      zipCode: shippingAddress.zip,
      city: shippingAddress.city,
      state: shippingAddress.state,
      country: shippingAddress.country || "US",
    },
    callbackUrl: `${siteUrl}/api/quiklie/notify`,
    redirectUrl: `${siteUrl}/checkout/callback?order_number=${encodeURIComponent(orderNumber)}&method=quiklie`,
    ipAddress: ip,
    transactionReferenceId: idempotencyKey,
    midType,
    descriptor,
  });

  if (!quiklieRes.ok || !quiklieRes.data) {
    console.warn("[express-quiklie-hpp] gateway error", {
      orderNumber,
      http_status: quiklieRes.status,
      raw: quiklieRes.raw?.slice(0, 500),
    });
    return NextResponse.json(
      {
        orderNumber,
        error: "Payment gateway unavailable. Please try again.",
        quiklie_debug: { http_status: quiklieRes.status, raw_excerpt: quiklieRes.raw?.slice(0, 500) },
      },
      { status: 502 },
    );
  }

  const quiklieData = quiklieRes.data;
  if (!quiklieData.quikleeRedirectUrl) {
    console.warn("[express-quiklie-hpp] unexpected gateway response", {
      orderNumber,
      statusCode: quiklieData.statusCode,
      message: quiklieData.message,
    });
    return NextResponse.json(
      {
        orderNumber,
        error:
          quiklieData.message ||
          "Could not start payment. Please try again.",
        quiklie_debug: { status_code: quiklieData.statusCode, message: quiklieData.message },
      },
      { status: 502 },
    );
  }

  // Stash the order. The webhook + polling endpoint look it up by
  // orderNumber. Quiklie's qkpaymentId is stored on the same record
  // so /api/quiklie/notify can match webhook payloads back to it.
  orderStore.put({
    orderNumber,
    rail: "quiklie",
    psifiSessionId: undefined, // psifi-only field
    customer,
    shippingAddress,
    totalCents,
    lineItems: items,
    couponCode,
    status: "unpaid",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // Stash Quiklie's payment id via a generic field — see
    // src/lib/order-store.ts for the StoredOrder shape.
    quikliePaymentId: quiklieData.qkpaymentId,
  });

  return NextResponse.json({
    orderNumber,
    sessionId: quiklieData.qkpaymentId,
    url: quiklieData.quikleeRedirectUrl,
    total: totalCents,
    method: "quiklie",
    status: "redirect",
  });
}
