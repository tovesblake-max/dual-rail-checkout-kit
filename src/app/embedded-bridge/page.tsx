"use client";

import { useEffect } from "react";

/**
 * Bridge page for the embedded PsiFi flow.
 *
 * When PsiFi finishes payment, it redirects the IFRAME (not the
 * parent window) to whatever `redirect_url` we set at session-create
 * time. In embedded mode that URL is THIS page.
 *
 * This page runs INSIDE the parent's iframe but on our own origin,
 * so it can postMessage to `window.parent` freely. The parent's
 * `<PsifiEmbeddedFrame>` listens for `psifi-checkout-complete` and
 * navigates the parent page to the post-purchase view.
 *
 * Failsafe: if the parent doesn't catch the message (older browser,
 * unmounted listener, Safari ITP postMessage drop), this page falls
 * back to a top-level navigation after 3 seconds so the customer
 * never gets stuck on a loading spinner.
 *
 * This page is PsiFi-specific. The CardsShield rail uses a top-level
 * redirect from CardsShield's iframe directly to /checkout/callback,
 * so no bridge handoff is needed for that rail.
 */

export default function EmbeddedBridge() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const sessionId =
      params.get("sessionId") || params.get("session_id") || "";
    const orderNumber = params.get("order_number") || "";

    try {
      window.parent.postMessage(
        {
          type: "psifi-checkout-complete",
          sessionId,
          orderNumber,
          ts: Date.now(),
        },
        // Restrict the target origin so this message can't be
        // intercepted by an attacker who frames us inside a
        // different parent.
        window.location.origin,
      );
    } catch {
      /* fall through to failsafe */
    }

    const t = window.setTimeout(() => {
      try {
        const target = `/checkout/callback?${[
          sessionId ? `sessionId=${encodeURIComponent(sessionId)}` : "",
          orderNumber ? `order_number=${encodeURIComponent(orderNumber)}` : "",
          "method=psifi",
        ]
          .filter(Boolean)
          .join("&")}`;
        if (window.top) window.top.location.href = target;
        else window.location.href = target;
      } catch {
        window.location.href = "/checkout/callback?method=psifi";
      }
    }, 3000);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="text-center max-w-sm">
        <div
          className="inline-block w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin"
          aria-hidden="true"
        />
        <p className="mt-4 text-sm text-muted">Finalizing your payment&hellip;</p>
      </div>
    </main>
  );
}
