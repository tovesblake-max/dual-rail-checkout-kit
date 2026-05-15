"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Lock } from "lucide-react";

/**
 * Inline CardsShield / KingsGate PayPal iframe — no modal chrome.
 *
 * Mirrors `PsifiEmbeddedFrame`'s UX / API contract (loading shimmer,
 * responsive height cap, key-forced remount on new session) but
 * adapted for KingsGate's protocol:
 *
 *   1. Server returns an HTML blob (form + scripts) rather than a
 *      URL. We `dangerouslySetInnerHTML` it into a host div.
 *
 *   2. innerHTML doesn't execute <script> tags per the HTML5 spec.
 *      We walk the injected scripts and recreate each as a live
 *      Element so the browser runs them. Same pattern Stripe
 *      Checkout / Braintree HPP use.
 *
 *   3. Heartbeat: every 100ms we send `cs-platformValidationStatus`
 *      (+ the `mecom-paypal*` analog the live iframe actually uses)
 *      to the KingsGate iframe so it knows our shipping form is
 *      valid. We only mount this component AFTER server-side
 *      address validation has passed, so the value is always `true`.
 *
 *   4. Listener: when the customer clicks the PayPal button inside
 *      the iframe, KingsGate posts `cs-feedbackPlatformValidationStatus`
 *      (or the `mecom-paypal*` analog). We respond with
 *      `cs-platformOrderInfo` containing the shipping payload in
 *      KingsGate's exact field shape (per Integration Guide v2.4).
 *
 *   5. Resize handler: the iframe posts `mecom-paypalBodyResizeContainer`
 *      when its internal SDK grows / shrinks (3DS panels, etc.). We
 *      apply the requested height, clamped to 192px minimum so the
 *      PayPal button row never clips.
 *
 *   6. Completion: KingsGate redirects the PARENT WINDOW (not the
 *      iframe) to /checkout/callback?order_number=… after payment.
 *      No iframe-internal completion postMessage to listen for. The
 *      browser just navigates away.
 *
 *   7. Boot timeout: if 15s pass with no postMessage from any
 *      CardsShield origin, we surface a "payment unavailable" error.
 *      Catches the case where KingsGate's CDN drops the script bundle.
 *
 * Origin whitelist for inbound postMessages: cardsshield.com,
 * thekingsgateway.com, paymentshields.com, keysidecommerce.com.
 * KingsGate's brand surfaces have multiplied; the live iframe
 * actually loads its body content from keysidecommerce.com while
 * gateway egresses from paymentshields.com.
 */

// Element ID KingsGate's hosted iframe uses (per Integration Guide
// v2.4 § "Embed Container"). Hardcoded because changing it requires
// a KingsGate-side rebuild — same ID is in the gated CheckoutClient.
const CS_IFRAME_ID = "mecom_paypal_payment_form";

// 192px is KingsGate's documented minimum for the PayPal button row.
// Anything smaller clips the button.
const MIN_IFRAME_HEIGHT = 192;
const MAX_IFRAME_HEIGHT = 720;
const BOOT_TIMEOUT_MS = 15000;
const HEARTBEAT_MS = 100;

export interface CardsShieldEmbeddedFrameProps {
  paymentFormHtml: string;
  /** SWB order number — surfaced as "Ref" caption below the iframe. */
  orderNumber: string;
  /** Customer info required for the `cs-platformOrderInfo` response.
   *  KingsGate's field shape is exact (per Integration Guide v2.4
   *  § JS Logic Step 2.2). */
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
  };
  /** Called when no postMessage has arrived after 15s — the iframe
   *  is probably dead. Parent should surface a retry UI. */
  onTimeout?: () => void;
}

function CardsShieldEmbeddedFrameInner({
  paymentFormHtml,
  orderNumber,
  customer,
  shippingAddress,
  onTimeout,
}: CardsShieldEmbeddedFrameProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [iframeReady, setIframeReady] = useState(false);
  const [iframeHeight, setIframeHeight] = useState(MIN_IFRAME_HEIGHT);
  const [bootTimedOut, setBootTimedOut] = useState(false);

  // Snapshot props in refs so the message listener (which we mount
  // once per paymentFormHtml change) reads fresh values without
  // forcing the effect to re-run on every prop change. We update
  // the refs in their own effects (not during render) to keep
  // React 19's strict lint rules happy.
  const customerRef = useRef(customer);
  const addressRef = useRef(shippingAddress);
  useEffect(() => {
    customerRef.current = customer;
  }, [customer]);
  useEffect(() => {
    addressRef.current = shippingAddress;
  }, [shippingAddress]);

  // ── Re-execute inert <script> tags after innerHTML injection ──
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const inertScripts = Array.from(host.querySelectorAll("script"));
    for (const inert of inertScripts) {
      const live = document.createElement("script");
      // Preserve attributes (src, type, integrity, async, defer, etc.)
      for (const attr of Array.from(inert.attributes)) {
        live.setAttribute(attr.name, attr.value);
      }
      // Inline content — for `<script>code</script>`, copy the text body.
      live.text = inert.text;
      inert.replaceWith(live);
    }
  }, [paymentFormHtml]);

  // ── Boot timeout ──
  // No reset needed at the top of this effect: the outer wrapper
  // uses `key={orderNumber}` to force remount on every new mint, so
  // the `useState(false)` initializer already reruns fresh.
  useEffect(() => {
    const t = window.setTimeout(() => {
      // State-based check so this only fires if we STILL haven't
      // seen any inbound CS postMessage by the deadline.
      setIframeReady((ready) => {
        if (!ready) {
          setBootTimedOut(true);
          if (onTimeout) onTimeout();
        }
        return ready;
      });
    }, BOOT_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, [onTimeout]);

  // ── Heartbeat + postMessage listener ──
  useEffect(() => {
    let cancelled = false;
    let intervalId: number | null = null;

    const sendValidationStatus = () => {
      if (cancelled) return;
      const iframe = document.getElementById(CS_IFRAME_ID) as HTMLIFrameElement | null;
      if (!iframe?.contentWindow) return;
      // Send both event-name families. The integration guide
      // documents the `cs-platformValidationStatus` shape; the live
      // iframe (verified forensics) uses the `mecom-paypal*`
      // namespace. Sending both is harmless — iframe ignores
      // unknown names.
      iframe.contentWindow.postMessage(
        { name: "cs-platformValidationStatus", value: true },
        "*",
      );
      iframe.contentWindow.postMessage(
        { name: "mecom-paypalPlatformValidationStatus", value: true },
        "*",
      );
    };

    // Kick off immediately + every 100ms thereafter.
    sendValidationStatus();
    intervalId = window.setInterval(sendValidationStatus, HEARTBEAT_MS);

    const onMessage = (event: MessageEvent) => {
      const d = event.data;
      const origin = event.origin || "?";

      // Origin substring whitelist. KingsGate's brand surfaces have
      // multiplied — production iframe content actually loads from
      // keysidecommerce.com, gateway API egresses from
      // paymentshields.com, legacy domain is cardsshield.com, docs/
      // portal live on thekingsgateway.com. Without ALL of these,
      // the spinner sits forever because the iframe sends
      // postMessages from an origin we don't recognize.
      const fromCS =
        origin.includes("cardsshield") ||
        origin.includes("kingsgate") ||
        origin.includes("paymentshields") ||
        origin.includes("keysidecommerce");

      if (fromCS) {
        setIframeReady(true);
      }

      if (!d || typeof d !== "object" || !("name" in d)) return;
      const name = (d as { name?: unknown }).name;
      if (typeof name !== "string") return;

      // ── Resize handler ──
      if (
        name === "mecom-paypalBodyResizeContainer" &&
        typeof (d as { value?: unknown }).value === "number"
      ) {
        const requested = (d as { value: number }).value;
        const applied = Math.min(
          MAX_IFRAME_HEIGHT,
          Math.max(MIN_IFRAME_HEIGHT, requested),
        );
        setIframeHeight(applied);
        return;
      }

      // ── Feedback handler — respond with cs-platformOrderInfo ──
      if (
        name === "cs-feedbackValidationStatus" ||
        name === "cs-feedbackPlatformValidationStatus" ||
        name === "mecom-paypalFeedbackValidationStatus" ||
        name === "mecom-paypalPlatformValidationStatus"
      ) {
        const value = (d as { value?: unknown }).value;
        if (!value) return;
        const iframe = document.getElementById(CS_IFRAME_ID) as HTMLIFrameElement | null;
        if (!iframe?.contentWindow) return;
        const c = customerRef.current;
        const a = addressRef.current;
        const phone = (c.phone || "")
          .replace(/\D/g, "")
          .replace(/^1(\d{10})$/, "$1");
        iframe.contentWindow.postMessage(
          {
            name: "cs-platformOrderInfo",
            value: {
              last_name: c.lastName,
              first_name: c.firstName,
              email: c.email,
              address: {
                city: a.city,
                country: "US",
                line1: a.address1,
                line2: a.address2 || "",
                postal_code: a.zip,
                state: a.state,
              },
              phone,
            },
          },
          "*",
        );
      }
    };

    window.addEventListener("message", onMessage);

    return () => {
      cancelled = true;
      if (intervalId !== null) window.clearInterval(intervalId);
      window.removeEventListener("message", onMessage);
    };
  }, [paymentFormHtml]);

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-accent/20">
        <div className="flex items-center gap-2">
          <div
            className="w-1.5 h-1.5 rounded-full bg-success"
            aria-hidden="true"
          />
          <span className="text-xs font-medium text-foreground">
            Secure payment
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted">
          <Lock className="w-3 h-3" strokeWidth={1.75} aria-hidden="true" />
          PCI-DSS Level 1
        </div>
      </div>

      <div
        className="relative bg-accent/30"
        style={{ minHeight: `${iframeHeight}px` }}
        aria-busy={!iframeReady && !bootTimedOut}
      >
        {!iframeReady && !bootTimedOut && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-10"
            aria-hidden="true"
          >
            <Loader2
              className="w-6 h-6 animate-spin text-primary"
              strokeWidth={1.5}
            />
            <p className="mt-3 text-xs text-muted">
              Loading secure checkout&hellip;
            </p>
          </div>
        )}
        {bootTimedOut && (
          <div
            role="alert"
            className="absolute inset-0 flex flex-col items-center justify-center px-4 text-center"
          >
            <p className="text-sm text-destructive font-medium mb-1">
              Payment form didn&apos;t load
            </p>
            <p className="text-xs text-muted max-w-xs">
              The secure payment provider isn&apos;t responding. Refresh the
              page to retry, or contact support if the problem persists.
            </p>
          </div>
        )}
        <div
          ref={hostRef}
          className={`transition-opacity duration-200 ${
            iframeReady ? "opacity-100" : "opacity-0"
          }`}
          // dangerouslySetInnerHTML is unavoidable here — KingsGate
          // returns an HTML blob with form + scripts that we have to
          // inject into the DOM. Server-side validation ensures the
          // response came from our authenticated KingsGate API call,
          // so the content is trusted. innerHTML doesn't execute
          // scripts on its own — the effect above re-executes them.
          dangerouslySetInnerHTML={{ __html: paymentFormHtml }}
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

export default function CardsShieldEmbeddedFrame(
  props: CardsShieldEmbeddedFrameProps,
) {
  // `key={orderNumber}` forces a fresh mount when a new session is
  // minted (e.g. coupon applied → ExpressCheckoutClient re-mints).
  // Mirrors the PsifiEmbeddedFrame remount pattern.
  return (
    <CardsShieldEmbeddedFrameInner key={props.orderNumber} {...props} />
  );
}
