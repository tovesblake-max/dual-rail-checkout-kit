import type { NextConfig } from "next";

/**
 * The CSP allowlists below are MANDATORY for either iframe to load.
 * If you bake this kit into an existing Next.js app with its own
 * `next.config.ts`, MERGE these directives into your existing CSP —
 * don't replace yours wholesale.
 *
 * What each domain is for:
 *   - *.psifi.app            — PsiFi hosted checkout iframe + API egress
 *   - *.cardsshield.com      — Legacy KingsGate domain (still serves some assets)
 *   - *.thekingsgateway.com  — KingsGate docs + portal
 *   - *.paymentshields.com   — KingsGate gateway API egress
 *   - *.keysidecommerce.com  — Where the live KingsGate iframe body content
 *                              actually loads from (yes, four domains for
 *                              one rail; KingsGate's brand surfaces have
 *                              multiplied over time)
 *   - *.paypal.com           — PayPal SDK loaded inside the KingsGate iframe
 */
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.cardsshield.com https://*.thekingsgateway.com https://*.paymentshields.com https://*.keysidecommerce.com",
              "style-src 'self' 'unsafe-inline'",
              "font-src 'self' data:",
              "img-src 'self' data: blob: https:",
              "connect-src 'self' https://*.psifi.app https://*.cardsshield.com https://*.thekingsgateway.com https://*.paymentshields.com https://*.keysidecommerce.com",
              "frame-src 'self' https://*.psifi.app https://*.cardsshield.com https://*.thekingsgateway.com https://*.paymentshields.com https://*.keysidecommerce.com https://*.paypal.com",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
