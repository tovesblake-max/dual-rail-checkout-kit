// Probe whether your Quiklie merchant's HPP can be embedded in an
// iframe from your site's origin. Mints a test session and inspects
// the X-Frame-Options + frame-ancestors CSP headers on the hosted
// page URL.
//
// Run from project root:
//   node ./scripts/probe-quiklie-hpp-embed.mjs
//
// Or with inline credentials (won't write to disk / shell history if
// you use `read -s`):
//   QUIKLIE_API_KEY=... QUIKLIE_MERCHANT_ID=... node ./scripts/probe-quiklie-hpp-embed.mjs
//
// AMOUNT CONFIGURATION
// ────────────────────
// The probe defaults to $20.00, which clears every Quiklie minimum-
// transaction-amount floor we've seen in the wild (most merchants
// either have no minimum or set it between $5-$15). If your merchant
// has a higher floor, override:
//
//   PROBE_AMOUNT=50 node ./scripts/probe-quiklie-hpp-embed.mjs
//
// IMPORTANT: a too-low amount returns the same statusCode 5 "ERROR"
// envelope as "HPP not provisioned" / "wrong midType," just with a
// different `message`. The probe distinguishes them — but if you see
// it report "ERROR — amount below merchant minimum," bump
// PROBE_AMOUNT above your merchant's floor and re-run.
//
// What it does:
//   1. Reads creds from process.env, then .env.local, then
//      .env.production.local (in that order).
//   2. POSTs a test session to api.quiklie.com/api/v2/process-payment/hpp
//      for $PROBE_AMOUNT (default $20.00).
//   3. Parses the response, extracts `quikleeRedirectUrl`.
//   4. GETs that URL and inspects:
//        - X-Frame-Options
//        - Content-Security-Policy (frame-ancestors directive)
//        - Set-Cookie SameSite attributes (Safari ITP signal)
//   5. Renders a verdict: embeddable from NEXT_PUBLIC_SITE_URL or not.
//
// Side effects:
//   - Creates a real row in your Quiklie merchant dashboard. The
//     session is never funded (no card data is sent) and Quiklie
//     expires it after their TTL. Safe to ignore in the dashboard.
//   - Does NOT charge any card.
//
// Common failure modes (and what they mean):
//   - statusCode 5 "No eligible payment processors available"
//       → HPP is not provisioned on your merchant account. Email
//         Quiklie support and ask them to enable the HPP routing
//         lane for your merchant.
//   - statusCode 5 "No eligible MIDs available for the requested transaction"
//       → HPP is provisioned but the midType you sent doesn't match
//         your merchant's lane. Try the opposite of what you're
//         currently sending (THREE_D vs TWO_D).
//   - 401 / auth error
//       → Wrong QUIKLIE_API_KEY or QUIKLIE_MERCHANT_ID. The merchant
//         ID is a small integer in your Quiklie dashboard, not the
//         long alphanumeric API key.

import { readFileSync } from "node:fs";

function loadEnv(path) {
  try {
    const raw = readFileSync(path, "utf8");
    const out = {};
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)="?([^"\n]*)"?$/);
      if (m) out[m[1]] = m[2].replace(/\\n$/, "");
    }
    return out;
  } catch {
    return {};
  }
}

const localEnv = loadEnv("./.env.local");
const prodEnv = loadEnv("./.env.production.local");

const pickEnv = (key, fallback = "") =>
  process.env[key] || localEnv[key] || prodEnv[key] || fallback;

const QUIKLIE_API_KEY = pickEnv("QUIKLIE_API_KEY");
const QUIKLIE_MERCHANT_ID = pickEnv("QUIKLIE_MERCHANT_ID");
const QUIKLIE_DESCRIPTOR = pickEnv("QUIKLIE_DESCRIPTOR", "DEMO STORE").slice(0, 22);
const SITE_URL = pickEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000")
  .trim()
  .replace(/\/+$/, "");
const MIDTYPE = pickEnv("NEXT_PUBLIC_QUIKLIE_HPP_MIDTYPE") === "THREE_D"
  ? "THREE_D"
  : "TWO_D";
// Default $20 — safely above every per-merchant minimum we've seen.
// Override with PROBE_AMOUNT=NN if your merchant's floor is higher.
const PROBE_AMOUNT = (() => {
  const raw = pickEnv("PROBE_AMOUNT", "20");
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`Invalid PROBE_AMOUNT=${raw} — must be a positive number. Using 20.`);
    return 20;
  }
  return n;
})();

if (!QUIKLIE_API_KEY || !QUIKLIE_MERCHANT_ID) {
  console.error("❌ Missing Quiklie credentials.");
  console.error();
  console.error("Set inline:");
  console.error("  QUIKLIE_API_KEY=... QUIKLIE_MERCHANT_ID=... node ./scripts/probe-quiklie-hpp-embed.mjs");
  console.error();
  console.error("Or populate .env.local with QUIKLIE_API_KEY + QUIKLIE_MERCHANT_ID, then re-run.");
  process.exit(1);
}

console.log("─".repeat(72));
console.log("QUIKLIE HPP EMBED PROBE");
console.log("─".repeat(72));
console.log(`Merchant ID:    ${QUIKLIE_MERCHANT_ID}`);
console.log(`midType:        ${MIDTYPE}`);
console.log(`Descriptor:     ${QUIKLIE_DESCRIPTOR}`);
console.log(`Parent origin:  ${SITE_URL}`);
console.log(`Test amount:    $${PROBE_AMOUNT.toFixed(2)} (override via PROBE_AMOUNT env)`);
console.log();

// ── Step 1: mint the test HPP session ─────────────────────────
console.log(`Step 1: minting a $${PROBE_AMOUNT.toFixed(2)} test HPP session…`);

const testOrderRef = `PROBE-${Date.now().toString(36).toUpperCase()}`;
const mintBody = {
  merchantId: QUIKLIE_MERCHANT_ID,
  firstName: "Probe",
  lastName: "Tester",
  email: "probe@example.com",
  phone: "8005551234",
  amount: PROBE_AMOUNT,
  currencyCode: "USD",
  address: "1 Probe Lane",
  zipCode: "10001",
  city: "New York",
  state: "NY",
  country: "US",
  ipAddress: "127.0.0.1",
  callbackUrl: `${SITE_URL}/api/quiklie/notify`,
  redirectUrl: `${SITE_URL}/checkout/callback?order_number=${testOrderRef}&method=quiklie`,
  customerReferenceId: "PROBE-CUST",
  transactionReferenceId: testOrderRef,
  midType: MIDTYPE,
  descriptor: QUIKLIE_DESCRIPTOR,
};

const mintRes = await fetch("https://api.quiklie.com/api/v2/process-payment/hpp", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": QUIKLIE_API_KEY,
    "x-source": "api",
  },
  body: JSON.stringify(mintBody),
});

const mintRaw = await mintRes.text();
let mintData = null;
try {
  mintData = JSON.parse(mintRaw);
} catch {
  /* keep null */
}

if (!mintRes.ok || !mintData) {
  console.error(`❌ Mint failed (HTTP ${mintRes.status}).`);
  console.error(`   Raw response: ${mintRaw.slice(0, 500)}`);
  process.exit(1);
}

if (!mintData.quikleeRedirectUrl) {
  console.error("❌ No quikleeRedirectUrl in response.");
  console.error(`   Status code: ${mintData.statusCode} (${mintData.status})`);
  console.error(`   Message:     ${mintData.message || "(none)"}`);
  console.error();
  if (Number(mintData.statusCode) === 5) {
    const msg = (mintData.message || "").toLowerCase();
    // Amount-floor rejection — Quiklie's wording varies but typically
    // contains "minimum", "amount", or "below". Many merchants have a
    // per-account minimum (often $5-$15). The probe defaults to $20
    // to clear most floors; if your merchant requires more, bump
    // PROBE_AMOUNT.
    if (msg.includes("minimum") || msg.includes("below") || msg.includes("amount")) {
      console.error(`DIAGNOSIS: Amount $${PROBE_AMOUNT.toFixed(2)} is below your merchant's minimum.`);
      console.error(`           Re-run with a higher amount:`);
      console.error(`           PROBE_AMOUNT=50 node ./scripts/probe-quiklie-hpp-embed.mjs`);
    } else if (msg.includes("processor")) {
      console.error("DIAGNOSIS: HPP is not provisioned on merchant " + QUIKLIE_MERCHANT_ID + ".");
      console.error("           Email Quiklie support and ask them to enable HPP routing.");
    } else if (msg.includes("mid")) {
      console.error(`DIAGNOSIS: HPP is enabled but your account uses a different midType lane.`);
      console.error(`           You sent midType=${MIDTYPE}. Try the opposite:`);
      console.error(`           NEXT_PUBLIC_QUIKLIE_HPP_MIDTYPE=${MIDTYPE === "TWO_D" ? "THREE_D" : "TWO_D"} node ./scripts/probe-quiklie-hpp-embed.mjs`);
    } else {
      console.error("DIAGNOSIS: statusCode 5 — Quiklie's routing layer rejected.");
      console.error("           Contact Quiklie support with this output.");
      console.error(`           (Also worth bumping PROBE_AMOUNT above $${PROBE_AMOUNT.toFixed(2)} in case it's an amount-floor issue with an unfamiliar message format.)`);
    }
  }
  process.exit(1);
}

const hppUrl = mintData.quikleeRedirectUrl;
console.log(`✓ Session minted. qkpaymentId=${mintData.qkpaymentId}`);
console.log(`  HPP URL: ${hppUrl}`);
console.log();

// ── Step 2: probe the HPP URL's iframe-block headers ──────────
console.log("Step 2: probing iframe-block headers on the HPP URL…");

const probeRes = await fetch(hppUrl, {
  method: "GET",
  redirect: "manual",
  headers: { "User-Agent": "Mozilla/5.0 (dual-rail-kit-embed-probe)" },
});

const headers = Object.fromEntries(probeRes.headers.entries());
const xfo = headers["x-frame-options"];
const csp = headers["content-security-policy"];
const setCookie = probeRes.headers.getSetCookie?.() ?? [];

console.log(`✓ HEAD response status: ${probeRes.status}${probeRes.status >= 300 && probeRes.status < 400 ? ` (Location: ${headers.location})` : ""}`);
console.log();
console.log(`X-Frame-Options:             ${xfo ?? "(not set)"}`);
const frameAncestors = csp
  ?.split(";")
  .map((s) => s.trim())
  .find((s) => s.startsWith("frame-ancestors"));
console.log(`CSP frame-ancestors:         ${frameAncestors ?? "(not set)"}`);
console.log(`Full CSP:                    ${csp ? csp.slice(0, 300) + (csp.length > 300 ? "…" : "") : "(not set)"}`);
console.log();
console.log("Cookies set by HPP:");
if (setCookie.length === 0) {
  console.log("  (none)");
} else {
  for (const c of setCookie) {
    const name = c.split("=")[0];
    const sameSite = c.match(/SameSite=(\w+)/i)?.[1] ?? "Lax (default)";
    const secure = /Secure/i.test(c) ? "Secure" : "NOT Secure";
    console.log(`  ${name}: SameSite=${sameSite}, ${secure}`);
  }
}
console.log();

// ── Step 3: verdict ───────────────────────────────────────────
console.log("─".repeat(72));
console.log("VERDICT");
console.log("─".repeat(72));

let embeddable = true;
const reasons = [];

if (xfo) {
  const xfoLower = xfo.toLowerCase();
  if (xfoLower === "deny") {
    embeddable = false;
    reasons.push("X-Frame-Options: DENY — Quiklie explicitly refuses ALL iframing.");
  } else if (xfoLower === "sameorigin") {
    embeddable = false;
    reasons.push("X-Frame-Options: SAMEORIGIN — Quiklie only allows their own domain to embed.");
  } else if (xfoLower.startsWith("allow-from")) {
    const allowed = xfo.slice(11).trim();
    if (allowed.includes(new URL(SITE_URL).host)) {
      reasons.push(`X-Frame-Options: ALLOW-FROM whitelists us (${allowed}).`);
    } else {
      embeddable = false;
      reasons.push(`X-Frame-Options: ALLOW-FROM only allows ${allowed} — not us.`);
    }
  } else {
    reasons.push(`X-Frame-Options: ${xfo} — unusual value, manual review needed.`);
  }
} else {
  reasons.push("X-Frame-Options: not set — header alone doesn't block embedding.");
}

if (frameAncestors) {
  const fa = frameAncestors.replace("frame-ancestors", "").trim();
  if (fa === "'none'") {
    embeddable = false;
    reasons.push("CSP frame-ancestors: 'none' — explicit DENY-all (overrides X-Frame-Options).");
  } else if (fa === "'self'") {
    embeddable = false;
    reasons.push("CSP frame-ancestors: 'self' — only Quiklie's own domain can embed.");
  } else if (fa.includes(new URL(SITE_URL).host)) {
    reasons.push(`CSP frame-ancestors: whitelists us (${fa}).`);
  } else if (fa === "*" || fa.includes("https:")) {
    reasons.push(`CSP frame-ancestors: ${fa} — permissive, we should be allowed.`);
  } else {
    embeddable = false;
    reasons.push(`CSP frame-ancestors: ${fa} — restrictive, our origin not allowed.`);
  }
} else if (!xfo) {
  reasons.push("CSP frame-ancestors: not set — combined with absent X-Frame-Options, full permissive (embeddable from any origin).");
}

const itpRisk = setCookie.some((c) => {
  const sameSite = c.match(/SameSite=(\w+)/i)?.[1]?.toLowerCase();
  return !sameSite || sameSite === "lax" || sameSite === "strict";
});
if (itpRisk && setCookie.length > 0) {
  reasons.push(
    "⚠ Safari ITP risk: Quiklie sets cookies without SameSite=None. Safari will partition these in iframe context and may break the session.",
  );
}

console.log();
if (embeddable) {
  console.log("✓ EMBEDDABLE — Quiklie's headers permit iframing from your origin.");
} else {
  console.log("✗ NOT EMBEDDABLE — Quiklie's headers block iframing from your origin.");
}
console.log();
console.log("Reasoning:");
for (const r of reasons) {
  console.log(`  • ${r}`);
}
console.log();
if (embeddable) {
  console.log("Next steps to upgrade Quiklie from redirect → embedded iframe UX:");
  console.log("  1. Build a <QuiklieHppFrame> component (mirror <PsifiEmbeddedFrame>).");
  console.log("  2. In src/app/page.tsx, replace the 'Pay button → window.location.href'");
  console.log("     branch with the new iframe component.");
  console.log("  3. The kit's CSP already allows *.quiklie.com in frame-src.");
  console.log("  4. A/B test 10% of Quiklie traffic for 2 weeks; compare approval");
  console.log("     rate AND completion rate (iframe context can lower approval by 1-3%).");
} else {
  console.log("Next steps:");
  console.log("  1. Stick with full-page redirect (the kit's default Quiklie behavior).");
  console.log("  2. Optionally: email Quiklie support to ask if they can whitelist your");
  console.log("     origin in their X-Frame-Options / frame-ancestors.");
}
console.log();
