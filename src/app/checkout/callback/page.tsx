"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";

/**
 * Post-purchase landing page (rail-agnostic).
 *
 * The iframe component (or, in CardsShield's case, CardsShield's
 * top-level redirect) navigates the parent here once payment
 * completes. This is where production code:
 *   - Renders the order receipt
 *   - Fires conversion pixels / analytics
 *   - Offers next-step CTAs (account creation, social share, etc.)
 *
 * For the demo we just poll our own /api/checkout/result one more
 * time to confirm the order is actually paid. The iframe channels
 * usually beat the user here, but a fast Apple Pay tap can race.
 */

type Status = "checking" | "paid" | "pending" | "failed";

export default function CheckoutCallback() {
  const [status, setStatus] = useState<Status>("checking");
  const [sessionId, setSessionId] = useState("");
  const [orderNumber, setOrderNumber] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const sid = params.get("sessionId") || params.get("session_id") || "";
    const on = params.get("order_number") || "";
    setSessionId(sid);
    setOrderNumber(on);

    let cancelled = false;
    let attempts = 0;

    async function check() {
      if (cancelled) return;
      attempts += 1;
      try {
        const r = await fetch("/api/checkout/result", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sid, orderNumber: on }),
        });
        const j = await r.json();
        if (cancelled) return;
        if (j.status === "completed") {
          setStatus("paid");
          return;
        }
        if (j.status === "failed") {
          setStatus("failed");
          return;
        }
      } catch {
        // Keep retrying.
      }
      if (attempts > 10) {
        setStatus("pending");
        return;
      }
      setTimeout(check, 2000);
    }
    if (sid || on) {
      check();
    } else {
      setStatus("pending");
    }
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="max-w-md mx-auto px-4 py-16 text-center">
      {status === "checking" && (
        <>
          <Loader2 className="w-10 h-10 text-primary animate-spin mx-auto mb-4" strokeWidth={1.5} aria-hidden="true" />
          <h1 className="text-xl font-semibold text-foreground mb-1">
            Confirming your payment&hellip;
          </h1>
          <p className="text-sm text-muted">One moment.</p>
        </>
      )}
      {status === "paid" && (
        <>
          <CheckCircle2 className="w-10 h-10 text-success mx-auto mb-4" strokeWidth={1.5} aria-hidden="true" />
          <h1 className="text-xl font-semibold text-foreground mb-1">
            Payment received
          </h1>
          {orderNumber && (
            <p className="text-sm text-muted">
              Order <span className="font-mono">{orderNumber}</span>
            </p>
          )}
          <p className="text-xs text-muted mt-6">
            (Demo: this is where the receipt + conversion pixels go.)
          </p>
        </>
      )}
      {status === "pending" && (
        <>
          <Loader2 className="w-10 h-10 text-muted mx-auto mb-4" strokeWidth={1.5} aria-hidden="true" />
          <h1 className="text-xl font-semibold text-foreground mb-1">
            We&apos;re still confirming your payment
          </h1>
          <p className="text-sm text-muted">
            This usually completes within a few seconds. Refresh if you don&apos;t see confirmation soon.
          </p>
          {sessionId && (
            <p className="text-xs text-muted mt-4 font-mono">
              session {sessionId.slice(0, 12)}&hellip;
            </p>
          )}
        </>
      )}
      {status === "failed" && (
        <>
          <XCircle className="w-10 h-10 text-destructive mx-auto mb-4" strokeWidth={1.5} aria-hidden="true" />
          <h1 className="text-xl font-semibold text-foreground mb-1">
            Payment didn&apos;t go through
          </h1>
          <p className="text-sm text-muted">
            No charge was made. You can try again from the checkout page.
          </p>
        </>
      )}
    </main>
  );
}
