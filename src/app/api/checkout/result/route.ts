import { NextResponse } from "next/server";
import { getCheckoutSession } from "@/lib/psifi";
import { getPaymentStatus } from "@/lib/cardsshield";
import { orderStore } from "@/lib/order-store";

/**
 * Rail-agnostic session-status polling endpoint.
 *
 * Channel 2 of the iframe completion-detection layering — the
 * embedded frame components hit this every 2 seconds asking "did
 * the gateway mark this session/order as paid yet?"
 *
 * The endpoint looks up the order in the store (by orderNumber OR
 * sessionId), figures out which rail minted it, and routes the
 * status check to the right gateway. Returns a normalized
 * { status: "completed" | "failed" | "pending" } shape that both
 * iframe components consume identically.
 *
 * Status mapping:
 *   - rail-specific "completed"         → "completed"
 *   - rail-specific "expired" | "failed" → "failed"
 *   - everything else / errors          → "pending" (keep polling)
 *
 * Production hardening:
 *   - Cache the gateway response for 1-2s so 50 simultaneous tabs
 *     don't fanout to 50 gateway GETs
 *   - Rate-limit per IP so an abandoned tab doesn't spam
 *   - Look up local DB first; only call gateway if local says unpaid
 */

export async function POST(request: Request) {
  let body: { sessionId?: string; orderNumber?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // Body might be empty — also accept params via query string.
  }
  const url = new URL(request.url);
  const sessionId =
    body.sessionId ||
    url.searchParams.get("sessionId") ||
    url.searchParams.get("session_id") ||
    "";
  const orderNumber =
    body.orderNumber ||
    url.searchParams.get("orderNumber") ||
    url.searchParams.get("order_number") ||
    "";

  if (!sessionId && !orderNumber) {
    return NextResponse.json(
      { status: "pending", reason: "missing sessionId/orderNumber" },
      { status: 400 },
    );
  }

  // Look up the order so we know which rail to query.
  let order = orderNumber ? orderStore.get(orderNumber) : null;
  if (!order && sessionId) {
    order = orderStore.findByPsifiSessionId(sessionId);
  }

  if (!order) {
    // No local record — could be a stale session from before a cold
    // start. Stay in pending; the webhook will catch it eventually.
    return NextResponse.json({ status: "pending", reason: "order not found locally" });
  }

  // Short-circuit if we've already recorded a terminal state.
  if (order.status === "paid") return NextResponse.json({ status: "completed" });
  if (order.status === "failed") return NextResponse.json({ status: "failed" });

  // Otherwise call the gateway to check.
  if (order.rail === "psifi" && order.psifiSessionId) {
    const res = await getCheckoutSession(order.psifiSessionId);
    if (!res.ok || !res.data) {
      return NextResponse.json({ status: "pending" });
    }
    if (res.data.status === "completed") {
      orderStore.patch(order.orderNumber, { status: "paid" });
      return NextResponse.json({ status: "completed" });
    }
    if (res.data.status === "expired" || res.data.status === "failed") {
      orderStore.patch(order.orderNumber, { status: "failed" });
      return NextResponse.json({ status: "failed", reason: res.data.status });
    }
    return NextResponse.json({ status: "pending" });
  }

  if (order.rail === "cardsshield") {
    const res = await getPaymentStatus(order.orderNumber);
    if (res.code !== 200 || !res.status) {
      return NextResponse.json({ status: "pending" });
    }
    if (res.status === "completed") {
      orderStore.patch(order.orderNumber, { status: "paid" });
      return NextResponse.json({ status: "completed" });
    }
    if (res.status === "fail") {
      orderStore.patch(order.orderNumber, { status: "failed" });
      return NextResponse.json({ status: "failed" });
    }
    return NextResponse.json({ status: "pending" });
  }

  return NextResponse.json({ status: "pending" });
}

export async function GET(request: Request) {
  // Convenience: support GET too for curl-based debugging.
  return POST(request);
}
