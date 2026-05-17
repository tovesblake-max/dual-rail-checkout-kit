"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Lock,
  ShieldCheck,
  Tag,
  X,
  Info,
  RotateCw,
} from "lucide-react";
import PsifiEmbeddedFrame from "@/components/PsifiEmbeddedFrame";
import CardsShieldEmbeddedFrame from "@/components/CardsShieldEmbeddedFrame";
import { CARD_RAIL, ACTIVE_RAIL_LABEL } from "@/lib/checkout-config";
import { DEMO_ITEM, findCoupon, type Coupon } from "@/lib/catalog";

/**
 * Tri-rail auto-fire checkout demo.
 *
 * UX contract:
 *   - Customer fills name / email / phone / shipping address.
 *   - The moment all fields validate, the active rail's iframe is
 *     minted in the background and renders inline. No "Pay" button.
 *   - Applying/removing a coupon or editing the address invalidates
 *     the current session and mints a fresh one.
 *   - All mints are debounced 800ms.
 *   - Which iframe renders is picked by `CARD_RAIL` (env-driven).
 *
 * The fingerprint-debounced auto-fire pattern + 3-channel completion
 * detection works identically for both rails. The only difference is
 * which endpoint we POST to + which iframe component renders.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CUSTOMIZE: replace this demo page with your real product / cart
 * UI. The rail-fork logic in the auto-fire useEffect below is the
 * piece you want to copy into your checkout component.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

// Debounce — sweet spot between "feels instant" and "doesn't fire
// a request per keystroke."
const MINT_DEBOUNCE_MS = 800;

interface ShippingAddress {
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

interface CustomerInfo {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

/**
 * Discriminated union covering all three rails' session shapes:
 *   - psifi:        returns a session id + hosted URL → inline iframe
 *   - cardsshield:  returns an HTML blob that has to be injected +
 *                   script-rehydrated client-side → inline iframe
 *   - quiklie:      returns a hosted URL → full-page redirect (HPP
 *                   doesn't embed reliably; explicit Pay button)
 */
type RailSession =
  | {
      rail: "psifi";
      url: string;
      sessionId: string;
      orderNumber: string;
      fingerprint: string;
    }
  | {
      rail: "cardsshield";
      paymentFormHtml: string;
      orderNumber: string;
      fingerprint: string;
    }
  | {
      rail: "quiklie";
      url: string;
      orderNumber: string;
      fingerprint: string;
    };

const emptyAddress: ShippingAddress = {
  address1: "",
  address2: "",
  city: "",
  state: "",
  zip: "",
  country: "US",
};

const emptyCustomer: CustomerInfo = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
};

const inputCls =
  "w-full px-3 py-2 bg-accent border border-border rounded-md text-sm text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-primary";

/** Cross-browser idempotency-key fallback. */
function newIdempotencyKey(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return (
    Math.random().toString(36).slice(2, 14) +
    "-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 6)
  );
}

export default function DemoCheckoutPage() {
  const [customer, setCustomer] = useState<CustomerInfo>(emptyCustomer);
  const [address, setAddress] = useState<ShippingAddress>(emptyAddress);

  // Coupon
  const [couponInput, setCouponInput] = useState("");
  const [couponError, setCouponError] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState<Coupon | null>(null);

  // Session state (auto-fire)
  const [session, setSession] = useState<RailSession | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);

  // Demo catalog totals (display-only; server is authoritative)
  const item = DEMO_ITEM;
  const subtotal = item.priceCents * item.quantity;
  const couponDiscount = appliedCoupon?.discountCents ?? 0;
  const total = Math.max(0, subtotal - couponDiscount);
  const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  // ── Fingerprint ────────────────────────────────────────────────
  // Stable hash of every input that affects the payment session.
  // Null until the form actually validates.
  const fingerprint = useMemo<string | null>(() => {
    if (!customer.firstName.trim() || !customer.lastName.trim()) return null;
    if (!customer.email.trim() || !customer.email.includes("@")) return null;
    if (
      !customer.phone.trim() ||
      customer.phone.replace(/\D/g, "").length < 7
    )
      return null;
    if (
      !address.address1.trim() ||
      !address.city.trim() ||
      !address.state.trim() ||
      address.state.trim().length !== 2 ||
      !address.zip.trim() ||
      address.zip.trim().length < 5
    ) {
      return null;
    }
    return JSON.stringify({
      c: {
        f: customer.firstName.trim(),
        l: customer.lastName.trim(),
        e: customer.email.trim().toLowerCase(),
        p: customer.phone.replace(/\D/g, ""),
      },
      a: {
        a1: address.address1.trim(),
        a2: address.address2.trim(),
        c: address.city.trim(),
        s: address.state.trim().toUpperCase(),
        z: address.zip.trim(),
        co: address.country,
      },
      items: `${item.sku}x${item.quantity}@${item.priceCents}`,
      coupon: appliedCoupon?.code || null,
    });
  }, [customer, address, appliedCoupon, item]);

  // ── Auto-fire mint ─────────────────────────────────────────────
  // Forks on CARD_RAIL. Both branches share the debounce + abort
  // pattern; they differ only in endpoint + response shape.
  const mintAbortRef = useRef<AbortController | null>(null);
  const previousSessionIdRef = useRef<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (!fingerprint) return;
    if (session && session.fingerprint === fingerprint) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      if (cancelled) return;

      if (mintAbortRef.current) mintAbortRef.current.abort();
      const ac = new AbortController();
      mintAbortRef.current = ac;

      setMintError(null);

      const key = newIdempotencyKey();
      const supersedes = previousSessionIdRef.current;

      const itemsToSend = [
        {
          sku: item.sku,
          name: item.name,
          priceCents: item.priceCents,
          quantity: item.quantity,
        },
      ];

      try {
        if (CARD_RAIL === "psifi") {
          const res = await fetch("/api/checkout/express-psifi", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              items: itemsToSend,
              customer,
              shippingAddress: address,
              couponCode: appliedCoupon?.code || undefined,
              idempotencyKey: key,
              embedded: true,
              previousSessionId: supersedes ?? undefined,
            }),
            signal: ac.signal,
          });
          const data = await res.json();
          if (cancelled || ac.signal.aborted) return;

          if (!res.ok) {
            setMintError(
              data?.error || "Couldn't load secure checkout. Please try again.",
            );
            setSession(null);
            return;
          }
          if (data?.status === "redirect" && data.url && data.sessionId) {
            previousSessionIdRef.current = data.sessionId;
            setSession({
              rail: "psifi",
              url: data.url,
              sessionId: data.sessionId,
              orderNumber: data.orderNumber,
              fingerprint,
            });
            return;
          }
          setMintError("Unexpected response from payment gateway.");
          setSession(null);
        } else if (CARD_RAIL === "quiklie") {
          const res = await fetch("/api/checkout/express-quiklie-hpp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              items: itemsToSend,
              customer,
              shippingAddress: address,
              couponCode: appliedCoupon?.code || undefined,
              idempotencyKey: key,
            }),
            signal: ac.signal,
          });
          const data = await res.json();
          if (cancelled || ac.signal.aborted) return;

          if (!res.ok) {
            setMintError(
              data?.error || "Couldn't load secure checkout. Please try again.",
            );
            setSession(null);
            return;
          }
          if (data?.status === "redirect" && data.url && data.orderNumber) {
            previousSessionIdRef.current = data.sessionId || data.orderNumber;
            setSession({
              rail: "quiklie",
              url: data.url,
              orderNumber: data.orderNumber,
              fingerprint,
            });
            return;
          }
          setMintError("Unexpected response from payment gateway.");
          setSession(null);
        } else {
          const res = await fetch("/api/checkout/express", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": key,
            },
            body: JSON.stringify({
              items: itemsToSend,
              customer,
              shippingAddress: address,
              couponCode: appliedCoupon?.code || undefined,
              idempotencyKey: key,
            }),
            signal: ac.signal,
          });
          const data = await res.json();
          if (cancelled || ac.signal.aborted) return;

          if (!res.ok) {
            setMintError(
              data?.error || "Couldn't load secure checkout. Please try again.",
            );
            setSession(null);
            return;
          }
          if (data?.paymentFormHtml && data.orderNumber) {
            previousSessionIdRef.current = data.orderNumber;
            setSession({
              rail: "cardsshield",
              paymentFormHtml: data.paymentFormHtml,
              orderNumber: data.orderNumber,
              fingerprint,
            });
            return;
          }
          setMintError("Unexpected response from payment gateway.");
          setSession(null);
        }
      } catch (err) {
        if (cancelled || ac.signal.aborted) return;
        if ((err as Error).name === "AbortError") return;
        setMintError("Network error. Check your connection and try again.");
        setSession(null);
      }
    }, MINT_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint, retryNonce]);

  const handleApplyCoupon = () => {
    setCouponError("");
    const found = findCoupon(couponInput);
    if (!found) {
      setCouponError("Invalid code. Try DEMO10.");
      return;
    }
    setAppliedCoupon(found);
    setCouponInput("");
  };

  type IframeStatus = "idle" | "minting" | "ready" | "error";
  const iframeStatus: IframeStatus = mintError
    ? "error"
    : session && session.fingerprint === fingerprint
      ? "ready"
      : fingerprint
        ? "minting"
        : "idle";

  return (
    <main className="max-w-5xl mx-auto px-4 py-8 md:py-12">
      <header className="mb-6">
        <h1 className="text-2xl md:text-3xl font-semibold text-foreground mb-1">
          Tri-rail checkout demo
        </h1>
        <p className="text-sm text-muted">
          Fill in the form. The {ACTIVE_RAIL_LABEL} iframe loads itself
          the moment your shipping address is valid. Try coupon code{" "}
          <span className="font-mono text-foreground">DEMO10</span>.
        </p>
        <p className="text-[11px] text-muted mt-2">
          Active rail: <span className="font-mono text-foreground">{CARD_RAIL}</span> —
          flip via{" "}
          <span className="font-mono text-foreground">NEXT_PUBLIC_PRIMARY_CARD_RAIL</span>{" "}
          env var + redeploy.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        <div className="space-y-5">
          <form
            onSubmit={(e) => e.preventDefault()}
            className="space-y-5"
          >
            <div className="bg-card rounded-xl border border-border p-5">
              <h2 className="font-semibold text-foreground mb-3">
                Your information
              </h2>
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="text"
                  placeholder="First name"
                  value={customer.firstName}
                  onChange={(e) =>
                    setCustomer({ ...customer, firstName: e.target.value })
                  }
                  autoComplete="given-name"
                  required
                  className={inputCls}
                />
                <input
                  type="text"
                  placeholder="Last name"
                  value={customer.lastName}
                  onChange={(e) =>
                    setCustomer({ ...customer, lastName: e.target.value })
                  }
                  autoComplete="family-name"
                  required
                  className={inputCls}
                />
              </div>
              <input
                type="email"
                placeholder="Email"
                value={customer.email}
                onChange={(e) =>
                  setCustomer({ ...customer, email: e.target.value })
                }
                autoComplete="email"
                required
                className={`${inputCls} mt-3`}
              />
              <input
                type="tel"
                placeholder="Phone"
                value={customer.phone}
                onChange={(e) =>
                  setCustomer({ ...customer, phone: e.target.value })
                }
                autoComplete="tel"
                required
                className={`${inputCls} mt-3`}
              />
            </div>

            <div className="bg-card rounded-xl border border-border p-5">
              <h2 className="font-semibold text-foreground mb-3">
                Shipping address
              </h2>
              <input
                type="text"
                placeholder="Address line 1"
                value={address.address1}
                onChange={(e) =>
                  setAddress({ ...address, address1: e.target.value })
                }
                autoComplete="address-line1"
                required
                className={inputCls}
              />
              <input
                type="text"
                placeholder="Apt / suite (optional)"
                value={address.address2}
                onChange={(e) =>
                  setAddress({ ...address, address2: e.target.value })
                }
                autoComplete="address-line2"
                className={`${inputCls} mt-3`}
              />
              <div className="grid grid-cols-2 gap-3 mt-3">
                <input
                  type="text"
                  placeholder="City"
                  value={address.city}
                  onChange={(e) =>
                    setAddress({ ...address, city: e.target.value })
                  }
                  autoComplete="address-level2"
                  required
                  className={inputCls}
                />
                <input
                  type="text"
                  placeholder="State (CA)"
                  value={address.state}
                  onChange={(e) =>
                    setAddress({
                      ...address,
                      state: e.target.value.toUpperCase(),
                    })
                  }
                  autoComplete="address-level1"
                  maxLength={2}
                  required
                  className={inputCls}
                />
              </div>
              <input
                type="text"
                placeholder="ZIP"
                value={address.zip}
                onChange={(e) =>
                  setAddress({ ...address, zip: e.target.value })
                }
                autoComplete="postal-code"
                required
                className={`${inputCls} mt-3 max-w-[180px]`}
              />
            </div>

            <div className="bg-card rounded-xl border border-border p-5">
              <h2 className="font-semibold text-foreground mb-3 flex items-center gap-2">
                <Tag className="w-4 h-4 text-muted" strokeWidth={1.5} aria-hidden="true" />
                Promo code
              </h2>
              {appliedCoupon ? (
                <div className="flex items-center justify-between bg-primary/5 border border-primary/30 rounded-md px-3 py-2">
                  <div className="flex flex-col min-w-0">
                    <span className="text-sm font-mono font-medium text-foreground truncate">
                      {appliedCoupon.code}
                    </span>
                    <span className="text-[11px] text-muted truncate">
                      {fmt(appliedCoupon.discountCents)} off applied
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setAppliedCoupon(null);
                      setCouponError("");
                    }}
                    aria-label="Remove promo code"
                    className="ml-3 inline-flex items-center justify-center w-7 h-7 rounded-full hover:bg-accent text-muted hover:text-foreground transition-colors"
                  >
                    <X className="w-4 h-4" strokeWidth={1.5} aria-hidden="true" />
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Enter code (try DEMO10)"
                    value={couponInput}
                    onChange={(e) =>
                      setCouponInput(e.target.value.toUpperCase())
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleApplyCoupon();
                      }
                    }}
                    className={`${inputCls} font-mono`}
                  />
                  <button
                    type="button"
                    onClick={handleApplyCoupon}
                    disabled={!couponInput.trim()}
                    className="px-4 py-2 rounded-md bg-accent text-foreground text-sm font-medium hover:bg-accent/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                  >
                    Apply
                  </button>
                </div>
              )}
              {couponError && (
                <p className="mt-2 text-xs text-destructive">{couponError}</p>
              )}
            </div>

            {/* Payment section — rail-aware */}
            <div className="bg-card rounded-xl border border-border p-5">
              <h2 className="font-semibold text-foreground mb-3 flex items-center gap-2">
                <Lock className="w-4 h-4 text-muted" strokeWidth={1.75} aria-hidden="true" />
                Payment
              </h2>

              {iframeStatus === "idle" && (
                <div className="bg-accent border border-border rounded-lg p-6 text-center">
                  <Info className="w-5 h-5 text-muted mx-auto mb-2" strokeWidth={1.75} aria-hidden="true" />
                  <p className="text-sm text-foreground font-medium mb-1">
                    Complete your details above
                  </p>
                  <p className="text-xs text-muted">
                    Secure checkout will load automatically once your shipping address is filled in.
                  </p>
                </div>
              )}

              {iframeStatus === "minting" && (
                <div
                  className="bg-accent border border-border rounded-lg p-6 flex flex-col items-center"
                  role="status"
                  aria-live="polite"
                >
                  <Loader2 className="w-6 h-6 text-primary animate-spin mb-3" strokeWidth={1.5} aria-hidden="true" />
                  <p className="text-sm text-foreground font-medium">
                    Preparing secure checkout&hellip;
                  </p>
                  <p className="text-xs text-muted mt-1">
                    One moment while we set up your payment.
                  </p>
                </div>
              )}

              {iframeStatus === "error" && (
                <div
                  role="alert"
                  className="bg-destructive/5 border border-destructive/20 rounded-lg p-4"
                >
                  <p className="text-sm text-destructive font-medium mb-2">
                    {mintError}
                  </p>
                  <div className="flex items-center gap-3 mt-3">
                    <button
                      type="button"
                      onClick={() => {
                        setMintError(null);
                        setRetryNonce((n) => n + 1);
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary-light transition-colors"
                    >
                      <RotateCw className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden="true" />
                      Try again
                    </button>
                    <span className="text-[11px] text-muted">
                      Or edit any field above to retry automatically.
                    </span>
                  </div>
                </div>
              )}

              {iframeStatus === "ready" && session?.rail === "psifi" && (
                <PsifiEmbeddedFrame
                  url={session.url}
                  sessionId={session.sessionId}
                  orderNumber={session.orderNumber}
                  onFailed={() => {
                    setSession(null);
                    setMintError(
                      "Payment failed. Please edit your details or click 'Try again' to retry.",
                    );
                  }}
                />
              )}

              {iframeStatus === "ready" && session?.rail === "cardsshield" && (
                <CardsShieldEmbeddedFrame
                  paymentFormHtml={session.paymentFormHtml}
                  orderNumber={session.orderNumber}
                  customer={customer}
                  shippingAddress={address}
                  onTimeout={() => {
                    setSession(null);
                    setMintError(
                      "The payment form didn't load. Click 'Try again' to retry.",
                    );
                  }}
                />
              )}

              {iframeStatus === "ready" && session?.rail === "quiklie" && (
                <div className="bg-accent border border-border rounded-lg p-6">
                  <p className="text-sm text-foreground font-medium mb-1">
                    Ready to pay {fmt(total)}
                  </p>
                  <p className="text-xs text-muted mb-4">
                    You&apos;ll be redirected to Quiklie&apos;s secure payment page to enter your card details. You&apos;ll return here once payment completes.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      window.location.href = session.url;
                    }}
                    className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary-light transition-colors"
                  >
                    <Lock className="w-4 h-4" strokeWidth={1.5} aria-hidden="true" />
                    Pay {fmt(total)} &rarr;
                  </button>
                  <p className="text-[10px] text-muted mt-2 text-center font-mono">
                    Ref {session.orderNumber}
                  </p>
                </div>
              )}

              <p className="text-[11px] text-muted mt-3 inline-flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden="true" />
                Secure payment · Card details never touch our servers
              </p>
            </div>
          </form>
        </div>

        {/* Right column: order summary */}
        <aside className="bg-card rounded-xl border border-border p-5 h-fit lg:sticky lg:top-6">
          <h2 className="font-semibold text-foreground mb-3">Order summary</h2>
          <div className="flex justify-between text-sm">
            <span className="text-foreground">{item.name}</span>
            <span className="text-foreground tabular-nums">
              {fmt(item.priceCents)}
            </span>
          </div>
          <div className="border-t border-border mt-4 pt-3 space-y-1.5 text-sm">
            <div className="flex justify-between text-muted">
              <span>Subtotal</span>
              <span className="tabular-nums">{fmt(subtotal)}</span>
            </div>
            {appliedCoupon && (
              <div className="flex justify-between text-primary">
                <span>Promo · {appliedCoupon.code}</span>
                <span className="tabular-nums">-{fmt(couponDiscount)}</span>
              </div>
            )}
            <div className="flex justify-between text-foreground font-semibold pt-2 border-t border-border mt-2">
              <span>Total</span>
              <span className="tabular-nums">{fmt(total)}</span>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
