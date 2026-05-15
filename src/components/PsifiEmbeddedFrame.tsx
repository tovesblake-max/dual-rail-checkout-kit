"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Lock } from "lucide-react";

/**
 * Inline PsiFi checkout iframe — no modal chrome.
 *
 * Renders `checkout.psifi.app/?sessionId=…` directly in the page
 * flow as soon as a session is minted. Customer never sees a "click
 * to pay" button: the iframe loads itself the moment shipping is
 * complete, mirroring the auto-load UX we had with CardsShield.
 *
 * Three completion-detection channels, layered for reliability:
 *
 *   1. postMessage from /embedded-bridge — PsiFi redirects the iframe
 *      there on payment completion, and the bridge page posts
 *      `{ type: "psifi-checkout-complete", … }` to the parent.
 *      Fastest path (< 100ms). Origin-validated against our own
 *      window origin since the bridge is same-origin.
 *
 *   2. Polling /api/checkout/result every 2 seconds — independent
 *      of iframe behavior; reads PsiFi's session status authoritatively.
 *      Catches Safari ITP postMessage drops or any other channel #1
 *      failure mode.
 *
 *   3. Iframe onload + same-origin URL inspection — once PsiFi
 *      redirects to /embedded-bridge, the iframe is on our origin so
 *      `contentWindow.location.href` becomes readable. Belt-and-braces.
 *
 * On completion: navigate the parent window to /checkout/callback
 * (unless an `onComplete` override is provided).
 *
 * Iframe permissions:
 *   - `allow="payment"` is REQUIRED for Apple Pay / Google Pay to
 *     work inside the iframe.
 *   - No `sandbox` attribute — sandbox strips capabilities that
 *     wallet payments require.
 *
 * Implementation note: the outer component uses sessionId as a React
 * key on the inner. When the session changes (coupon applied → new
 * session minted), the inner unmounts/remounts. That gives us a
 * clean state reset without any in-effect setState or ref-mutation
 * during render (both of which trip React 19's strict lint rules).
 */

export interface PsifiEmbeddedFrameProps {
  url: string;
  sessionId: string;
  orderNumber?: string;
  /** Optional: override the default /checkout/callback navigation. */
  onComplete?: (info: { sessionId: string; orderNumber?: string }) => void;
  /** Optional: notified when the gateway reports the session failed. */
  onFailed?: () => void;
  /**
   * Maximum iframe height in pixels. The actual height is
   * `min(maxHeight, viewport - 220px)` clamped to a 580px floor so
   * the iframe never exceeds the viewport on short screens but always
   * has enough room for PsiFi's wallet buttons + card form.
   * Defaults to 720.
   */
  maxHeight?: number;
}

const POLL_MS = 2000;
const MIN_HEIGHT = 580;
const VIEWPORT_BUFFER = 220; // page chrome + summary card above

function PsifiEmbeddedFrameInner({
  url,
  sessionId,
  orderNumber,
  onComplete,
  onFailed,
  maxHeight = 720,
}: PsifiEmbeddedFrameProps) {
  const [iframeReady, setIframeReady] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const completedRef = useRef(false);

  const handleComplete = useCallback(
    (info: { sessionId: string; orderNumber?: string }) => {
      if (completedRef.current) return;
      completedRef.current = true;
      if (onComplete) {
        onComplete(info);
        return;
      }
      const qs = new URLSearchParams();
      qs.set("sessionId", info.sessionId);
      if (info.orderNumber) qs.set("order_number", info.orderNumber);
      qs.set("method", "psifi");
      window.location.href = `/checkout/callback?${qs.toString()}`;
    },
    [onComplete],
  );

  // ── Channel 1: postMessage from /embedded-bridge ──
  // Origin-validated: the bridge page lives on our own domain (it's
  // the iframe's `redirect_url` target), so a legitimate completion
  // message ALWAYS originates from our own window origin. Anything
  // else is either PsiFi's chrome chatter (height adjustment, etc.)
  // or a malicious third-party trying to forge completion.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const expectedOrigin = window.location.origin;
    function onMessage(event: MessageEvent) {
      if (event.origin !== expectedOrigin) return;
      if (!event.data || typeof event.data !== "object") return;
      const d = event.data as { type?: string; sessionId?: string; orderNumber?: string };
      if (d.type !== "psifi-checkout-complete") return;
      if (d.sessionId && d.sessionId !== sessionId) return;
      handleComplete({
        sessionId: d.sessionId || sessionId,
        orderNumber: d.orderNumber || orderNumber,
      });
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [sessionId, orderNumber, handleComplete]);

  // ── Channel 2: poll /api/checkout/result ──
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      if (cancelled || completedRef.current) return;
      try {
        const params = new URLSearchParams({ sessionId });
        if (orderNumber) params.set("orderNumber", orderNumber);
        const r = await fetch(`/api/checkout/result?${params.toString()}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderNumber }),
        });
        const j = await r.json();
        if (cancelled) return;
        if (j.status === "completed") {
          handleComplete({ sessionId, orderNumber });
          return;
        }
        if (j.status === "failed") {
          completedRef.current = true;
          if (onFailed) onFailed();
          return;
        }
      } catch {
        // Transient — retry next tick.
      }
      timer = setTimeout(poll, POLL_MS);
    }

    timer = setTimeout(poll, POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, orderNumber, handleComplete, onFailed]);

  // ── Channel 3: iframe onload + same-origin URL inspection ──
  const onIframeLoad = useCallback(() => {
    setIframeReady(true);
    try {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      const href = win.location.href;
      if (href.includes("/embedded-bridge")) {
        const u = new URL(href);
        const sid =
          u.searchParams.get("sessionId") ||
          u.searchParams.get("session_id") ||
          sessionId;
        const on =
          u.searchParams.get("order_number") || orderNumber || undefined;
        handleComplete({ sessionId: sid, orderNumber: on });
      }
    } catch {
      // Cross-origin — expected while on PsiFi's page.
    }
  }, [sessionId, orderNumber, handleComplete]);

  // Responsive height — capped to viewport so the iframe never
  // overflows below the fold on a phone but always has enough room
  // for the wallet buttons + card form.
  const heightStyle = `min(${maxHeight}px, max(${MIN_HEIGHT}px, calc(100vh - ${VIEWPORT_BUFFER}px)))`;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-accent/20">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-success" aria-hidden="true" />
          <span className="text-xs font-medium text-foreground">Secure payment</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted">
          <Lock className="w-3 h-3" strokeWidth={1.75} aria-hidden="true" />
          PCI-DSS Level 1
        </div>
      </div>

      <div
        className="relative bg-accent/30"
        style={{ height: heightStyle }}
        aria-busy={!iframeReady}
      >
        {!iframeReady && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-10"
            aria-hidden="true"
          >
            <Loader2 className="w-6 h-6 animate-spin text-primary" strokeWidth={1.5} />
            <p className="mt-3 text-xs text-muted">Loading secure checkout&hellip;</p>
          </div>
        )}
        <iframe
          ref={iframeRef}
          src={url}
          onLoad={onIframeLoad}
          title="Secure payment"
          allow="payment; publickey-credentials-get; clipboard-write"
          className={`w-full h-full border-0 block transition-opacity duration-200 ${
            iframeReady ? "opacity-100" : "opacity-0"
          }`}
        />
      </div>

      <div className="px-4 py-2 border-t border-border text-center">
        <p className="text-[10px] text-muted">
          Card details never touch our servers
          {orderNumber && (
            <>
              <span className="mx-1.5">·</span>
              Ref <span className="font-mono">{orderNumber}</span>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

export default function PsifiEmbeddedFrame(props: PsifiEmbeddedFrameProps) {
  // `key={sessionId}` forces a fresh mount when the session changes —
  // resets iframeReady + completedRef without any in-render setState
  // or in-effect ref mutation (both of which React 19 flags).
  return <PsifiEmbeddedFrameInner key={props.sessionId} {...props} />;
}
