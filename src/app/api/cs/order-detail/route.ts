import { NextResponse } from "next/server";
import {
  buildOrderDetail,
  verifyApiKeyHeader,
} from "@/lib/cardsshield";
import { orderStore } from "@/lib/order-store";

/**
 * CardsShield API 0 — Get Order Detail (inbound).
 *
 *   Direction: CS → Platform
 *   Endpoint:  This route. CardsShield hits it during iframe mount.
 *   Auth:      `api_key` query string (same shared key we send
 *              outbound). Verified with constant-time compare via
 *              `verifyApiKeyHeader`.
 *
 * CardsShield calls this WHILE the customer is watching the iframe
 * load. The iframe sits idle until our response comes back, so this
 * endpoint MUST be fast (<500ms) and MUST return the order details
 * in the exact shape from the spec.
 *
 * The response shape is `CSOrderDetail` (see `src/lib/cardsshield.ts`).
 * Field names match CardsShield's spec — don't rename.
 *
 * Idempotent — CardsShield may call this multiple times for the same
 * order_id (retries, refresh, etc.). Always return the same payload.
 */

export async function GET(request: Request) {
  if (!verifyApiKeyHeader(request)) {
    return NextResponse.json(
      { code: 401, msg: "Invalid api_key" },
      { status: 401 },
    );
  }

  const url = new URL(request.url);
  const orderNumber =
    url.searchParams.get("order_id") || url.searchParams.get("token") || "";

  if (!orderNumber) {
    return NextResponse.json(
      { code: 400, msg: "missing order_id" },
      { status: 400 },
    );
  }

  const order = orderStore.get(orderNumber);
  if (!order) {
    // No local record. In production this would mean a stale
    // session id, a cross-environment leak (prod webhook for dev
    // order), or DB lookup failure. Return 404 in the body but
    // 200 HTTP so CardsShield doesn't retry forever — they'll surface
    // the error to the customer's iframe instead.
    return NextResponse.json(
      { code: 404, msg: `unknown order ${orderNumber}` },
      { status: 200 },
    );
  }

  const detail = buildOrderDetail({
    orderNumber: order.orderNumber,
    totalDollars: order.totalCents / 100,
    customer: order.customer,
    shippingAddress: order.shippingAddress,
    lineItems: order.lineItems.map((li) => ({
      name: li.name,
      sku: li.sku,
      quantity: li.quantity,
      priceCents: li.priceCents,
    })),
  });

  return NextResponse.json({ code: 0, ...detail });
}

// Some CardsShield integration tests POST this endpoint. Accept both.
export async function POST(request: Request) {
  return GET(request);
}
