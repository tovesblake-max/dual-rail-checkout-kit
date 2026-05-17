import { NextResponse, after } from "next/server";
import { verifyWebhookApiKey, QUIKLIE_STATUS } from "@/lib/quiklie";
import { orderStore } from "@/lib/order-store";

/**
 * Quiklie callback webhook.
 *
 * Quiklie POSTs the final transaction result here (URL is configured
 * as `callbackUrl` at mint time). Per Quiklie's spec (section 7) their
 * only auth is an `X-API-Key` header — no HMAC signature on the body.
 *
 * Defense-in-depth pattern from the SWB production handler:
 *   1. Constant-time API key compare (prevents timing oracles)
 *   2. Correlation by transactionReferenceId → local order, with
 *      replay guards on terminal states
 *   3. (Recommended for production, NOT in this kit) Amount match:
 *      verify body.amount equals the order's stored total. Without
 *      this, a leaked API key lets an attacker forge SUCCESS for any
 *      order without knowing its exact total.
 *
 * Side effects run in next/server `after()` so they don't block the
 * 200 ACK back to Quiklie.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CUSTOMIZE: the after() block flips the local order-store status.
 * Wire your real fulfillment side effects in (receipt email,
 * fulfillment push, conversion pixels, etc.).
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

export async function POST(request: Request) {
  const provided = request.headers.get("x-api-key");
  if (!verifyWebhookApiKey(provided)) {
    console.warn("[quiklie-notify] rejected: bad or missing x-api-key");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const transactionReferenceId =
    typeof body.transactionReferenceId === "string"
      ? body.transactionReferenceId
      : null;
  const qkpaymentId =
    typeof body.transactionId === "string" ? body.transactionId : null;
  const status = typeof body.status === "string" ? body.status : "";
  const rawStatusCode =
    typeof body.statusCode === "string"
      ? Number(body.statusCode)
      : typeof body.statusCode === "number"
        ? body.statusCode
        : null;

  if (rawStatusCode === null) {
    console.warn("[quiklie-notify] unparseable statusCode", {
      status,
      rawStatusCode: body.statusCode,
      transactionReferenceId,
    });
    return NextResponse.json({ ok: true, note: "unparseable status" });
  }

  console.log("[quiklie-notify] verified webhook", {
    statusCode: rawStatusCode,
    status,
    qkpaymentId,
    transactionReferenceId,
  });

  // Wire production fulfillment inside this after() block.
  after(async () => {
    try {
      const order = qkpaymentId
        ? orderStore.findByQuikliePaymentId(qkpaymentId)
        : null;

      if (!order) {
        console.warn(
          `[quiklie-notify] no local order for qkpaymentId=${qkpaymentId} txRef=${transactionReferenceId}`,
        );
        return;
      }

      if (rawStatusCode === QUIKLIE_STATUS.SUCCESS) {
        orderStore.patch(order.orderNumber, { status: "paid" });
        console.log(`[quiklie-notify] order ${order.orderNumber} marked paid`);
        // TODO (production): send receipt email, fulfillment push, pixels.
      } else if (
        rawStatusCode === QUIKLIE_STATUS.FAILED ||
        rawStatusCode === QUIKLIE_STATUS.DECLINED
      ) {
        orderStore.patch(order.orderNumber, { status: "failed" });
      }
    } catch (err) {
      console.error("[quiklie-notify] side-effect error", err);
    }
  });

  return NextResponse.json({ ok: true });
}
