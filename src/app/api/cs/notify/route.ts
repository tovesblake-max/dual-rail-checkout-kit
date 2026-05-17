import { NextResponse, after } from "next/server";
import { getPaymentStatus } from "@/lib/cardsshield";
import { orderStore } from "@/lib/order-store";

/**
 * CardsShield / CardsShield webhook receiver (Notify URL, API 3.1).
 *
 * CardsShield fires a GET to this URL when payment completes.
 * Importantly, the inbound webhook itself is NOT the source of
 * truth — per the spec we MUST call API 3.2 (getPaymentStatus) to
 * verify the status server-side before flipping our order.
 *
 *   Inbound:  GET /api/cs/notify?order_id=<orderNumber>
 *   Action:   POST /custom/notify-payment with token=<orderNumber>
 *             → if status=completed → mark order paid + persist shield_domain
 *             → if status=fail      → mark order failed
 *             → otherwise           → leave as pending; retry next poll
 *
 * The CardsShield side will retry the notify call if we return non-2xx,
 * so always return 200 (with the appropriate body) after handling.
 *
 * Side effects in `after()` for the same reason as the PsiFi handler:
 * we want the response back quickly so the gateway's retry queue
 * doesn't wedge.
 */

export async function GET(request: Request) {
  const url = new URL(request.url);
  const orderNumber = url.searchParams.get("order_id") || "";

  if (!orderNumber) {
    console.warn("[cs-notify] missing order_id query param");
    return NextResponse.json({ ok: false, error: "missing order_id" }, { status: 400 });
  }

  console.log(`[cs-notify] received notify for order ${orderNumber}`);

  // ── Side effects (run after the response is sent) ──────────────
  // CUSTOMIZE: production code wires in fulfillment here. The block
  // below just calls API 3.2 to verify + flips the local store.
  // Replace with your real workflow.
  after(async () => {
    try {
      const status = await getPaymentStatus(orderNumber);
      if (status.code !== 200) {
        console.warn(`[cs-notify] getPaymentStatus failed for ${orderNumber}:`, status);
        return;
      }
      const order = orderStore.get(orderNumber);
      if (!order) {
        console.warn(`[cs-notify] no local order ${orderNumber}`);
        return;
      }
      if (status.status === "completed") {
        orderStore.patch(orderNumber, { status: "paid" });
        // CUSTOMIZE: save `status.shield_domain` to your order row.
        // It's required for refund + tracking-sync API calls later.
        console.log(
          `[cs-notify] order ${orderNumber} marked paid · shield_domain=${status.shield_domain}`,
        );
        // TODO (production): send receipt email, enqueue fulfillment, etc.
      } else if (status.status === "fail") {
        orderStore.patch(orderNumber, { status: "failed" });
      }
    } catch (err) {
      console.error("[cs-notify] side-effect error", err);
    }
  });

  // CardsShield expects a 200 with an empty/ok body to dequeue the
  // notify. If we don't return promptly they'll retry.
  return NextResponse.json({ ok: true });
}

// CardsShield uses GET for notify per the spec, but some
// integration tests send POST. Accept both.
export async function POST(request: Request) {
  return GET(request);
}
