/**
 * CardsShield / KingsGate gateway client (one of the two rails this
 * kit ships).
 *
 * Source of truth: https://csdocs.thekingsgateway.com (Integration
 * Guide v2.4)
 *
 * Brand note: the product is now "KingsGate" but the gateway domain
 * is still `cardsshield.com` — env vars + variable names keep the
 * historical `CS_` prefix.
 *
 * PCI scope: SAQ-A. The gateway hosts the card-entry form. Your
 * origin never sees PAN or CVV. Card data flows entirely between
 * the customer's browser, the embedded KingsGate iframe, and
 * KingsGate's PCI-DSS Level 1 infrastructure.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * SURFACE AREA SHIPPED HERE:
 *   - `getPaymentFormHtml(orderNumber)` — API 1.2, mint the iframe HTML
 *   - `getPaymentResult(orderNumber)`   — API 2.6, callback-time check
 *   - `getPaymentStatus(orderNumber)`   — API 3.2, server-side verify
 *
 * NOT SHIPPED (intentionally — bolt these onto the kit if needed):
 *   - Refund (API 10.1) — HMAC-signed, requires CS_SECRET_KEY
 *   - Tracking sync (API 10.2) — same HMAC contract as refund
 *   - Stripe sub-flow (server-to-server, different choreography)
 *
 * DO NOT MODIFY the public functions below unless KingsGate changes
 * their API. The shapes here match the spec exactly.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

// `.trim()` everywhere — `vercel env add` from a shell pipe sometimes
// stores values with a trailing \n, which silently breaks auth on
// every outbound request. Trimming is idempotent.
const CS_GATEWAY_URL = (process.env.CS_GATEWAY_URL || "https://dev-gw.cardsshield.com")
  .trim()
  .replace(/\/+$/, "");
const CS_API_KEY = (process.env.CS_API_KEY || "").trim();
const CS_PLATFORM_NAME = (process.env.CS_PLATFORM_NAME || "").trim();
const CS_ENDPOINT_TOKEN = (process.env.CS_ENDPOINT_TOKEN || "").trim();
const CS_PAYMENT_GATEWAY = (process.env.CS_PAYMENT_GATEWAY || "1").trim();

// ── Type contracts mirroring the KingsGate API spec ─────────────

/**
 * KingsGate's status values for API 2.6 / 3.2 responses. The spec
 * allows the platform to define more values, but these are the
 * canonical ones. Anything else is treated as `pending` and left
 * for the webhook flow to reconcile.
 */
export type CSPaymentStatus = "completed" | "fail" | "pending";

/**
 * "1" = PayPal — requires the JS choreography this kit ships
 *      (validation status + order info via postMessage).
 * "2" = Stripe — server-to-server only. No client JS contract.
 */
export type CSPaymentGateway = "1" | "2";

interface CSResponseBase {
  code: number; // 200 = success on outbound, 0 = success on inbound API 0
  msg?: string;
}

export interface CSGetPaymentFormResponse extends CSResponseBase {
  /** HTML to inject into the checkout payment form area. */
  content?: string;
}

export interface CSPaymentResultResponse extends CSResponseBase {
  status?: CSPaymentStatus;
  /** Transaction ID from KingsGate / underlying processor. */
  trade_no?: string;
  /** Order number echoed back from the platform. */
  order_number?: string;
}

export interface CSPaymentStatusResponse extends CSResponseBase {
  status?: CSPaymentStatus;
  /**
   * Per-order shield domain — REQUIRED downstream for refund +
   * tracking calls. Save it on the order row at notify time.
   * Example: "demo4.cardsshield.com".
   */
  shield_domain?: string;
  trade_no?: string;
  order_number?: string;
}

// ── Internal helpers ───────────────────────────────────────────

function csUrl(path: string): string {
  if (!CS_API_KEY || !CS_PLATFORM_NAME) {
    throw new Error(
      "CardsShield is not configured. Set CS_API_KEY and CS_PLATFORM_NAME in .env.local.",
    );
  }
  const params = new URLSearchParams({
    api_key: CS_API_KEY,
    cs_platform_name: CS_PLATFORM_NAME,
  });
  return `${CS_GATEWAY_URL}${path}?${params.toString()}`;
}

// ── Outbound API calls ─────────────────────────────────────────

/**
 * API 1.2 — Get HTML Content
 *
 *   Direction: Platform → CS
 *   Endpoint:  POST {CS_GATEWAY_URL}/custom/get-payment-form
 *              ?api_key=<api_key>&cs_platform_name=<platform>
 *   Body:      { "token": "<order_id>" }
 *
 * Returns the HTML snippet (iframe + bootstrap script) we inject
 * into the checkout payment form area. While the form is loading,
 * KingsGate calls our API 0 to read the order details.
 *
 * `token` is the same as `order_id` from API 0 — your orderNumber.
 */
export async function getPaymentFormHtml(
  orderNumber: string,
): Promise<CSGetPaymentFormResponse> {
  const res = await fetch(csUrl("/custom/get-payment-form"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: orderNumber }),
  });
  return res.json();
}

/**
 * API 2.6 — Return Payment Result
 *
 *   Direction: Platform → CS
 *   Endpoint:  POST {CS_GATEWAY_URL}/custom/return-payment-result
 *              ?api_key=<api_key>&cs_platform_name=<platform>
 *   Body:      { "token": "<order_id>" }
 *
 * Called from /checkout/callback after the user is redirected back
 * from the iframe payment flow. Returns the final payment status.
 */
export async function getPaymentResult(
  orderNumber: string,
): Promise<CSPaymentResultResponse> {
  const res = await fetch(csUrl("/custom/return-payment-result"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: orderNumber }),
  });
  return res.json();
}

/**
 * API 3.2 — Get Payment Status
 *
 *   Direction: Platform → CS
 *   Endpoint:  POST {CS_GATEWAY_URL}/custom/notify-payment
 *              ?api_key=<api_key>&cs_platform_name=<platform>
 *   Body:      { "token": "<order_id>" }
 *
 * Called by /api/cs/notify to verify payment status server-side
 * before flipping payment_status on your order row. The response
 * includes `shield_domain` — save it on the order, required as the
 * endpoint URL for refunds + tracking sync.
 */
export async function getPaymentStatus(
  orderNumber: string,
): Promise<CSPaymentStatusResponse> {
  const res = await fetch(csUrl("/custom/notify-payment"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: orderNumber }),
  });
  return res.json();
}

// ── API 0: KingsGate calls US to read order details ─────────────

/**
 * Order-detail payload that /api/cs/order-detail must return when
 * KingsGate's iframe calls it during form mount. Field names match
 * KingsGate's spec exactly — don't rename.
 *
 * The kit's bundled /api/cs/order-detail route constructs this from
 * an in-memory store keyed by order_id. In production, replace the
 * store with your DB lookup.
 */
export interface CSOrderDetail {
  /** Your platform-side order id (same as `orderNumber`). */
  order_id: string;
  /** Total in major units (dollars). KingsGate expects a number. */
  amount: number;
  /** ISO currency code, e.g. "USD". */
  currency_code: string;
  /** Customer email — used by PayPal for receipt + ID verification. */
  buyer_email: string;
  buyer_first_name: string;
  buyer_last_name: string;
  /** Phone — digits only, no formatting. PayPal validates format. */
  buyer_phone: string;
  shipping_address: {
    line1: string;
    line2: string;
    city: string;
    state: string;
    postal_code: string;
    country: string;
  };
  /**
   * Cart contents in KingsGate's line-item shape. The total of
   * line_items[].amount * quantity should match the top-level
   * `amount`. KingsGate displays the line items in the PayPal
   * receipt + chargeback ledger.
   */
  line_items: Array<{
    name: string;
    sku?: string;
    quantity: number;
    amount: number; // unit price in major units (dollars)
  }>;
  /**
   * Gateway routing — "1" PayPal or "2" Stripe. Pulled from env
   * unless overridden per-order.
   */
  payments: {
    interface_type_param: {
      token: string; // CS_ENDPOINT_TOKEN
    };
    payment_gateway: CSPaymentGateway;
  };
}

/**
 * Helper to assemble the API 0 response from an in-memory order.
 * In production, build this from your DB row instead.
 */
export function buildOrderDetail(input: {
  orderNumber: string;
  totalDollars: number;
  customer: {
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
  };
  shippingAddress: {
    address1: string;
    address2?: string;
    city: string;
    state: string;
    zip: string;
  };
  lineItems: Array<{
    name: string;
    sku?: string;
    quantity: number;
    priceCents: number;
  }>;
}): CSOrderDetail {
  return {
    order_id: input.orderNumber,
    amount: input.totalDollars,
    currency_code: "USD",
    buyer_email: input.customer.email,
    buyer_first_name: input.customer.firstName,
    buyer_last_name: input.customer.lastName,
    buyer_phone: (input.customer.phone || "")
      .replace(/\D/g, "")
      .replace(/^1(\d{10})$/, "$1"),
    shipping_address: {
      line1: input.shippingAddress.address1,
      line2: input.shippingAddress.address2 || "",
      city: input.shippingAddress.city,
      state: input.shippingAddress.state,
      postal_code: input.shippingAddress.zip,
      country: "US",
    },
    line_items: input.lineItems.map((li) => ({
      name: li.name,
      sku: li.sku,
      quantity: li.quantity,
      amount: li.priceCents / 100,
    })),
    payments: {
      interface_type_param: { token: CS_ENDPOINT_TOKEN },
      payment_gateway: (CS_PAYMENT_GATEWAY === "2" ? "2" : "1") as CSPaymentGateway,
    },
  };
}

/**
 * Verify an inbound API 0 call from KingsGate carries the expected
 * api_key. CardsShield's API 0 doesn't use HMAC signing — it just
 * passes the shared `api_key` in the query string, same key we send
 * outbound. We compare server-side.
 */
export function verifyApiKeyHeader(request: Request): boolean {
  if (!CS_API_KEY) return false;
  const url = new URL(request.url);
  const incoming = url.searchParams.get("api_key");
  return incoming === CS_API_KEY;
}
