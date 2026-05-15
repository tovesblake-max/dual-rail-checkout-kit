/**
 * PsiFi gateway client (one of the two rails this kit ships).
 *
 * Surface area: just what's needed to mint + tear down hosted
 * checkout sessions and verify webhooks. PsiFi documentation:
 * https://docs.psifi.app/api-reference
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * DO NOT MODIFY the public functions below unless PsiFi changes
 * their API. The shapes here match the gateway's protocol exactly.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

import { Webhook, WebhookVerificationError } from "svix";

const PSIFI_API_BASE = (
  process.env.PSIFI_API_BASE || "https://api.psifi.app/api/v2"
)
  .trim()
  .replace(/\/+$/, "");
const PSIFI_API_KEY = (process.env.PSIFI_API_KEY || "").trim();
const PSIFI_WEBHOOK_SECRET = (process.env.PSIFI_WEBHOOK_SECRET || "").trim();

export interface PsiFiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface PsiFiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: PsiFiError;
  requestId?: string;
}

export interface PsiFiCheckoutSession {
  id: string;
  url: string;
  status: "active" | "completed" | "expired" | "failed" | string;
  external_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

async function psifiRequest<T>(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<PsiFiResult<T>> {
  if (!PSIFI_API_KEY) {
    return {
      ok: false,
      status: 0,
      error: {
        code: "no_api_key",
        message:
          "PSIFI_API_KEY is not set. Add it to .env.local (see .env.example).",
      },
    };
  }
  const url = `${PSIFI_API_BASE}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": PSIFI_API_KEY,
    ...extraHeaders,
  };
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const requestId = res.headers.get("x-request-id") || undefined;
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // PsiFi always returns JSON for both success + error. A
      // non-JSON body is a CDN / proxy failure, not the gateway.
    }
    if (!res.ok) {
      const err = (json as { error?: PsiFiError } | null)?.error;
      return {
        ok: false,
        status: res.status,
        error: err || {
          code: "gateway_error",
          message: `PsiFi returned ${res.status}`,
        },
        requestId,
      };
    }
    return { ok: true, status: res.status, data: json as T, requestId };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: {
        code: "network_error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ── Checkout sessions ───────────────────────────────────────────

export interface CreateCheckoutSessionInput {
  orderNumber: string;
  totalDollars: number;
  /**
   * Either a single contextual product or an array of line items.
   * If neither the demo product id nor `products` is supplied, PsiFi
   * receives just the total amount and shows it as a generic line.
   */
  products?: { productId: string; quantity: number }[];
  customer?: {
    email?: string;
    name?: string;
    phone?: string;
  };
  /** Where to send the customer after payment completes. In embedded
   *  mode this points at /embedded-bridge so the postMessage
   *  handshake fires; in classic mode this is /checkout/callback. */
  redirectUrl: string;
  /** Optional Svix-Portal endpoint to receive transaction.updated
   *  events. Omit to suppress webhook delivery for this session. */
  webhookUrl?: string;
  /** Session lifetime in seconds. PsiFi rejects sessions older than
   *  this; we recommend 1800 (30 min) for retail checkout. */
  expiresInSeconds?: number;
  metadata?: Record<string, unknown>;
}

export async function createCheckoutSession(
  input: CreateCheckoutSessionInput,
): Promise<PsiFiResult<PsiFiCheckoutSession>> {
  const body: Record<string, unknown> = {
    external_id: input.orderNumber,
    amount: Math.round(input.totalDollars * 100), // cents
    currency: "USD",
    redirect_url: input.redirectUrl,
    expires_in: input.expiresInSeconds ?? 1800,
    // Merchant absorbs the PsiFi platform fee so the customer sees
    // sticker price. Flip to false to surcharge the customer.
    merchant_pays_fees: true,
  };
  if (input.products && input.products.length > 0) {
    body.line_items = input.products.map((p) => ({
      product_id: p.productId,
      quantity: p.quantity,
    }));
  }
  if (input.customer) {
    body.customer = {
      email: input.customer.email,
      name: input.customer.name,
      phone: input.customer.phone,
    };
  }
  if (input.webhookUrl) {
    body.webhook_url = input.webhookUrl;
  }
  if (input.metadata) {
    body.metadata = input.metadata;
  }
  return psifiRequest<PsiFiCheckoutSession>(
    "/checkout-sessions",
    "POST",
    body,
    { "Idempotency-Key": input.orderNumber },
  );
}

export async function getCheckoutSession(
  sessionId: string,
): Promise<PsiFiResult<PsiFiCheckoutSession>> {
  return psifiRequest<PsiFiCheckoutSession>(
    `/checkout-sessions/${encodeURIComponent(sessionId)}`,
    "GET",
  );
}

/**
 * Force-expire a session. Used by the auto-fire client to clean up
 * stale sessions when the customer applies a coupon or edits their
 * address — the route fires this off the response critical path via
 * Next.js `after()`.
 */
export async function expireCheckoutSession(
  sessionId: string,
): Promise<PsiFiResult<PsiFiCheckoutSession>> {
  return psifiRequest<PsiFiCheckoutSession>(
    `/checkout-sessions/${encodeURIComponent(sessionId)}/expire`,
    "POST",
  );
}

// ── Webhook signature verification ──────────────────────────────

/**
 * PsiFi uses Svix for webhook delivery. The merchant secret format
 * is either `whsec_<base64>` (Svix standard) or `ep_<rawstring>`
 * (Svix endpoint-secret prefix). For the latter, the suffix is a
 * raw string, NOT base64-encoded, so we pass `{ format: "raw" }`
 * to the Webhook constructor.
 *
 * Fails closed: if `PSIFI_WEBHOOK_SECRET` is unset, every webhook
 * is rejected. A forged `transaction.updated` event could flip an
 * order to completed and trigger fulfillment — signature
 * verification is load-bearing. Never disable in production.
 */
export function verifyWebhookSignature(
  rawBody: string,
  headers: {
    id: string | null;
    timestamp: string | null;
    signature: string | null;
  },
):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: string } {
  if (!PSIFI_WEBHOOK_SECRET) {
    return {
      ok: false,
      reason:
        "PSIFI_WEBHOOK_SECRET unset — refusing to accept webhook",
    };
  }
  if (!headers.id || !headers.timestamp || !headers.signature) {
    return {
      ok: false,
      reason: "missing svix-{id,timestamp,signature} header",
    };
  }
  try {
    const stripped = PSIFI_WEBHOOK_SECRET.startsWith("ep_")
      ? PSIFI_WEBHOOK_SECRET.slice(3)
      : PSIFI_WEBHOOK_SECRET;
    const useRaw = !PSIFI_WEBHOOK_SECRET.startsWith("whsec_");
    const wh = new Webhook(stripped, useRaw ? { format: "raw" } : undefined);
    const payload = wh.verify(rawBody, {
      "svix-id": headers.id,
      "svix-timestamp": headers.timestamp,
      "svix-signature": headers.signature,
    }) as Record<string, unknown>;
    return { ok: true, payload };
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return { ok: false, reason: err.message };
    }
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
