import { NextResponse, after } from "next/server";
import { verifyWebhookSignature } from "@/lib/psifi";
import { orderStore } from "@/lib/order-store";

/**
 * PsiFi webhook receiver.
 *
 * In production this is the PRIMARY fulfillment trigger — when PsiFi
 * fires `transaction.updated` with `status: completed`, you:
 *   - Flip your order to paid
 *   - Capture analytics / conversion pixels
 *   - Send confirmation receipts
 *   - Enqueue fulfillment / shipping
 *
 * The iframe completion-detection channels are just UX nice-to-haves;
 * the webhook is the source of truth.
 *
 * Signature verification is non-negotiable — anyone on the open
 * internet can POST to this URL. A forged event could trigger
 * fulfillment. Fail closed.
 *
 * Side effects run in next/server `after()` so they don't block the
 * 200 ACK back to PsiFi. Svix considers any response > 15s a failure
 * and retries the event, so slow handlers wedge the retry queue.
 */

export async function POST(request: Request) {
  const rawBody = await request.text();

  const verification = verifyWebhookSignature(rawBody, {
    id: request.headers.get("svix-id"),
    timestamp: request.headers.get("svix-timestamp"),
    signature: request.headers.get("svix-signature"),
  });

  if (!verification.ok) {
    console.warn("[psifi-notify] signature verification failed:", verification.reason);
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const payload = verification.payload;
  const eventType = String(payload.type || "");
  const data = (payload.data as Record<string, unknown>) || {};
  const sessionId = String(data.session_id || data.id || "");
  const status = String(data.status || "");
  const externalId = String(data.external_id || "");

  console.log("[psifi-notify] verified webhook", {
    eventType,
    sessionId,
    status,
    externalId,
  });

  // ── Side effects (run after the response is sent) ──────────────
  // CUSTOMIZE: this is where production code wires in fulfillment.
  // The block below just flips the local order-store status. Replace
  // with your real workflow: DB update, email send, ShipStation
  // push, conversion-pixel fire, etc.
  after(async () => {
    try {
      if (eventType === "transaction.updated" && status === "completed") {
        const order =
          orderStore.findByPsifiSessionId(sessionId) ||
          (externalId ? orderStore.get(externalId) : null);
        if (order) {
          orderStore.patch(order.orderNumber, { status: "paid" });
          console.log(`[psifi-notify] order ${order.orderNumber} marked paid`);
          // TODO (production): send receipt email, enqueue fulfillment, etc.
        } else {
          console.warn(
            `[psifi-notify] no local order for session ${sessionId} / external ${externalId}`,
          );
        }
      }
      if (
        eventType === "transaction.updated" &&
        (status === "failed" || status === "expired")
      ) {
        const order =
          orderStore.findByPsifiSessionId(sessionId) ||
          (externalId ? orderStore.get(externalId) : null);
        if (order) {
          orderStore.patch(order.orderNumber, { status: "failed" });
        }
      }
    } catch (err) {
      console.error("[psifi-notify] side-effect error", err);
    }
  });

  return NextResponse.json({ ok: true });
}
