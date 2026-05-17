/**
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CUSTOMIZE: replace this in-memory store with your DB.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * The kit stores order snapshots in a process-local `Map` keyed by
 * orderNumber. The CardsShield rail needs this because CardsShield's
 * iframe calls our /api/cs/order-detail endpoint to read order
 * details DURING iframe mount, after the mint route already
 * returned. The PsiFi rail needs it for /api/checkout/result to
 * look up orderNumber → sessionId mappings.
 *
 * Production replacement: every `orderStore.put(...)` becomes a
 * `db.insert(orders)`. Every `orderStore.get(...)` becomes a
 * `db.select(...).where(eq(orders.orderNumber, ...))`. The Order
 * shape is intentionally minimal — extend it freely.
 *
 * In-memory storage means orders DON'T survive function cold starts
 * on Vercel. Fine for local dev + small demos. NOT fine for
 * production — you WILL lose orders mid-flight.
 */

export interface StoredOrder {
  orderNumber: string;
  /** The active rail for this order — set at mint time. */
  rail: "cardsshield" | "psifi" | "quiklie";
  /** PsiFi session id (psifi rail only). */
  psifiSessionId?: string;
  /** Quiklie payment id / qkpaymentId (quiklie rail only). The webhook
   *  handler at /api/quiklie/notify uses this to correlate inbound
   *  events back to the local order. */
  quikliePaymentId?: string;
  /** Customer snapshot at mint time. */
  customer: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
  };
  shippingAddress: {
    address1: string;
    address2?: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  };
  totalCents: number;
  /** Cart line items at mint time. */
  lineItems: Array<{
    sku: string;
    name: string;
    priceCents: number;
    quantity: number;
  }>;
  /** Coupon applied at mint time, if any. */
  couponCode?: string;
  /**
   * "unpaid" → freshly minted, awaiting customer payment.
   * "paid"   → webhook (or callback verification) confirmed.
   * "failed" → gateway reported failure / session expired.
   */
  status: "unpaid" | "paid" | "failed";
  createdAt: number;
  updatedAt: number;
}

class InMemoryOrderStore {
  private store = new Map<string, StoredOrder>();

  put(order: StoredOrder): void {
    this.store.set(order.orderNumber, { ...order, updatedAt: Date.now() });
  }

  get(orderNumber: string): StoredOrder | null {
    return this.store.get(orderNumber) ?? null;
  }

  patch(orderNumber: string, patch: Partial<StoredOrder>): StoredOrder | null {
    const existing = this.store.get(orderNumber);
    if (!existing) return null;
    const next: StoredOrder = { ...existing, ...patch, updatedAt: Date.now() };
    this.store.set(orderNumber, next);
    return next;
  }

  /** Look up by PsiFi session id (for webhook handlers). */
  findByPsifiSessionId(sessionId: string): StoredOrder | null {
    for (const order of this.store.values()) {
      if (order.psifiSessionId === sessionId) return order;
    }
    return null;
  }

  /** Look up by Quiklie payment id / qkpaymentId (for webhook handlers). */
  findByQuikliePaymentId(qkpaymentId: string): StoredOrder | null {
    for (const order of this.store.values()) {
      if (order.quikliePaymentId === qkpaymentId) return order;
    }
    return null;
  }
}

// Single process-local instance. On Vercel each function invocation
// may get its own fresh `Map` after a cold start — orders that exist
// in one invocation aren't visible to the next. THIS IS A DEMO LIMITATION.
// In production replace this entire file with a DB-backed adapter.
export const orderStore = new InMemoryOrderStore();

/** Generate an order number. Customize the prefix if you want. */
export function generateOrderNumber(): string {
  const now = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `KIT-${now}${rand}`;
}
