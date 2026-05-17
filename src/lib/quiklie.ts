/**
 * Quiklie gateway client (one of the three rails this kit ships).
 *
 * Surface area: HPP (Hosted Payment Page) only. Quiklie's S2S endpoint
 * exists but expands PCI scope to SAQ-D so we don't expose it here.
 *
 * Docs: https://www.quiklie.com/docs (V2 spec)
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * DO NOT MODIFY the public functions below unless Quiklie changes
 * their API. The shapes here match the gateway's protocol exactly.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

const QUIKLIE_BASE = (process.env.QUIKLIE_API_BASE || "https://api.quiklie.com")
  .trim()
  .replace(/\/+$/, "");
const QUIKLIE_API_KEY = (process.env.QUIKLIE_API_KEY || "").trim();
const QUIKLIE_MERCHANT_ID = (process.env.QUIKLIE_MERCHANT_ID || "").trim();

// Quiklie's status codes per their V2 spec. Returned as a string in
// the response envelope; always numeric per spec.
//
// Note: code 5 ("ERROR") is the most common failure value and its
// meaning depends on the `message` field:
//   "No eligible payment processors available" → your account isn't
//      provisioned for the requested flow (e.g. HPP not enabled).
//   "No eligible MIDs available for the requested transaction" → flow
//      is provisioned but midType (TWO_D / THREE_D) doesn't match
//      your account's lane.
// See `scripts/probe-quiklie-hpp-embed.mjs` for diagnostics.
export const QUIKLIE_STATUS = {
  SUCCESS: 1,
  THREE_DS_REQUIRED: 2, // HPP path always returns 2 with a redirect URL
  OTP_REQUIRED: 3,
  DECLINED: 4,
  ERROR: 5, // routing failure — see message for sub-reason
  REFUNDED: 6, // refund-response context only
  REFUND_FAILED: 7, // refund-response context only
} as const;

export interface QuiklieBilling {
  firstName: string;
  lastName: string;
  email: string;
  /** Digits only. We normalize before send (Quiklie rejects empty/formatted). */
  phone: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
}

export interface QuiklieProcessResponse {
  status: string;
  statusCode: string; // numeric-as-string per spec
  qkpaymentId: string;
  amount?: number;
  currency?: string;
  message?: string;
  /** Present on HPP responses (statusCode 2). The hosted payment page URL
   *  the customer should be redirected to. */
  quikleeRedirectUrl?: string;
  extendedMessage?: string | null;
  customerReferenceId?: string;
  transactionReferenceId?: string;
}

export interface QuiklieHPPParams {
  amountDollars: number;
  billing: QuiklieBilling;
  /** Where Quiklie posts the async result webhook. Should be the
   *  externally-reachable URL of your /api/quiklie/notify route. */
  callbackUrl: string;
  /** Where Quiklie sends the customer's browser after the HPP flow
   *  completes (success OR cancel). Typically /checkout/callback. */
  redirectUrl: string;
  ipAddress?: string;
  customerReferenceId?: string;
  /** Use the same ID you'd use as your local idempotency key. Quiklie
   *  dedupes by this — a network retry of the same logical mint can't
   *  double-charge. */
  transactionReferenceId?: string;
  /** TWO_D = no 3DS challenge (most non-3DS merchants land here).
   *  THREE_D = enforced 3DS challenge. Wrong choice → statusCode 5
   *  "No eligible MIDs". Your Quiklie account is provisioned on ONE
   *  of these; ask Quiklie support which lane your merchant is on. */
  midType?: "THREE_D" | "TWO_D";
  /** Statement descriptor (max 22 chars). Some Quiklie MIDs require
   *  it; safer to always provide. */
  descriptor?: string;
}

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": QUIKLIE_API_KEY,
    // Spec requires "api" or "plugin". Native code integration = "api".
    "x-source": "api",
  };
}

/** Quiklie wants amounts as 2-decimal floats (e.g. 15.00 not 15). */
function roundAmount(dollars: number): number {
  return Math.round(dollars * 100) / 100;
}

/** Quiklie rejects empty / formatted phones. Strip non-digits; pad if
 *  too short with a safe placeholder so the request doesn't 400. */
function normalizePhoneForQuiklie(phone: string | undefined): string {
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.length >= 10 && digits.length <= 15) return digits;
  return "0000000000";
}

async function quiklieRequest<T>(
  path: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: T | null; raw: string }> {
  if (!QUIKLIE_API_KEY || !QUIKLIE_MERCHANT_ID) {
    return {
      ok: false,
      status: 0,
      data: null,
      raw: "Quiklie not configured. Set QUIKLIE_API_KEY + QUIKLIE_MERCHANT_ID in .env.local.",
    };
  }
  const url = `${QUIKLIE_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let data: T | null = null;
  try {
    data = raw ? (JSON.parse(raw) as T) : null;
  } catch {
    // keep data null; caller handles raw
  }
  if (!res.ok) {
    console.warn("[quiklie] non-2xx response", {
      path,
      method,
      http_status: res.status,
      raw: raw.slice(0, 1500),
    });
  }
  return { ok: res.ok, status: res.status, data, raw };
}

/**
 * Mint a hosted-payment-page transaction. Returns Quiklie's redirect
 * URL via `quikleeRedirectUrl` on success — the customer should be
 * full-page-redirected to that URL to enter card details.
 *
 * PCI scope: SAQ-A. Customer's card data is collected on Quiklie's
 * domain; your origin never sees PAN / CVV.
 */
export async function processPaymentHPP(params: QuiklieHPPParams) {
  return quiklieRequest<QuiklieProcessResponse>(
    "/api/v2/process-payment/hpp",
    "POST",
    {
      merchantId: QUIKLIE_MERCHANT_ID,
      firstName: params.billing.firstName,
      lastName: params.billing.lastName,
      email: params.billing.email,
      phone: normalizePhoneForQuiklie(params.billing.phone),
      amount: roundAmount(params.amountDollars),
      currencyCode: "USD",
      address: params.billing.address,
      zipCode: params.billing.zipCode,
      city: params.billing.city,
      state: params.billing.state,
      country: params.billing.country,
      ipAddress: params.ipAddress || "0.0.0.0",
      callbackUrl: params.callbackUrl,
      redirectUrl: params.redirectUrl,
      ...(params.customerReferenceId && { customerReferenceId: params.customerReferenceId }),
      ...(params.transactionReferenceId && { transactionReferenceId: params.transactionReferenceId }),
      ...(params.midType && { midType: params.midType }),
      ...(params.descriptor && { descriptor: params.descriptor.slice(0, 22) }),
    },
  );
}

/**
 * Poll a transaction's status by Quiklie's payment id (qkpaymentId
 * from the mint response). Used as a fallback when the callback
 * webhook is missed / delayed.
 *
 * The primary source of truth is the webhook posted to
 * `callbackUrl`; this is for reconciliation only.
 */
export async function getTransactionStatus(qkpaymentId: string) {
  const encoded = encodeURIComponent(qkpaymentId);
  return quiklieRequest<{
    quickleePaymentId: string;
    status: string;
    statusCode: string;
    quikleeMessage?: string;
    amount?: number;
    currency?: string;
    customerReferenceId?: string;
    transactionReferenceId?: string;
  }>(`/api/v2/transaction-status/${encoded}`, "GET");
}

/**
 * Constant-time string compare for webhook auth-header verification.
 * Quiklie webhooks carry an `X-API-Key` matching our QUIKLIE_API_KEY
 * (or a separate QUIKLIE_WEBHOOK_API_KEY if you've provisioned one).
 */
export function verifyWebhookApiKey(provided: string | null): boolean {
  const expected = (process.env.QUIKLIE_WEBHOOK_API_KEY || QUIKLIE_API_KEY).trim();
  if (!expected || !provided) return false;
  if (provided.length !== expected.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return result === 0;
}

// ── Refund ─────────────────────────────────────────────────────────

export interface QuiklieRefundResponse {
  status: string;
  statusCode: string;
  message?: string;
  transactionId?: string;
  qkpaymentId?: string;
  refundId?: string;
  amount?: number;
  currency?: string;
}

/**
 * Issue a refund (full or partial) against a Quiklie transaction.
 *
 * Endpoint: `POST /api/v1/refund` per Quiklie V2 spec.
 *
 * The Quiklie merchant DASHBOARD does not expose a refund button as
 * of 2026-05-17 — this API endpoint is the only way to refund
 * programmatically. Build an admin route (e.g. `/api/admin/orders/refund`)
 * that calls this helper, gated behind your admin auth.
 *
 * Quiklie returns the standard `status` / `statusCode` envelope:
 *   - statusCode 6 = REFUNDED (success)
 *   - statusCode 7 = REFUND_FAILED (gateway accepted the request,
 *                    but the issuing bank rejected — surface as a
 *                    refund failure to the operator)
 *
 * Partial refunds: pass `amountDollars` less than the original
 * capture. Cumulative refunded amount cannot exceed the capture;
 * mirror this check on your side too.
 *
 * @param transactionId — Quiklie's qkpaymentId from the original mint
 *                        (stored as `quikliePaymentId` on the order
 *                        in this kit's order store).
 * @param amountDollars — amount to refund in dollars (e.g. 15.00).
 * @param reason        — optional, capped at 500 chars by Quiklie.
 */
export async function processRefund(params: {
  transactionId: string;
  amountDollars: number;
  currencyCode?: string;
  reason?: string;
}) {
  const body: Record<string, unknown> = {
    transactionId: params.transactionId,
    amount: roundAmount(params.amountDollars),
    currencyCode: (params.currencyCode || "USD").toUpperCase(),
  };
  if (params.reason && params.reason.trim().length > 0) {
    body.reason = params.reason.trim().slice(0, 500);
  }
  return quiklieRequest<QuiklieRefundResponse>(
    "/api/v1/refund",
    "POST",
    body,
  );
}
