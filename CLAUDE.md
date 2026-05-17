# CLAUDE.md

You're Claude Code (or a Claude-based agent) integrating this kit. Read [AGENTS.md](./AGENTS.md) first — it's the canonical integration guide.

## TL;DR

This is a Next.js 15 drop-in module for payment checkout with two hot-swappable gateways (CardsShield/CardsShield + PsiFi). One env var (`NEXT_PUBLIC_PRIMARY_CARD_RAIL`) picks which one renders. Both stay wired 24/7 for outage failover.

## Quick orientation

- The "switch" lives in `src/lib/checkout-config.ts`. Import `CARD_RAIL` from it; don't read the env var directly.
- The two iframe components in `src/components/` are protocol-correct and should NOT be modified.
- The five places marked `// CUSTOMIZE:` in the source are where the user wires in their catalog, DB, fulfillment side effects, etc.
- The demo `src/app/page.tsx` is meant to be replaced by the host's real checkout UI; the auto-fire pattern inside is what gets copied.

## Common tasks

| Task | Where to start |
| --- | --- |
| Drop the kit into an existing Next.js site | [INTEGRATION.md](./INTEGRATION.md) |
| Understand how the auto-fire pattern works | [docs/architecture.md](./docs/architecture.md) |
| Flip rails | [docs/payment-rail-switch.md](./docs/payment-rail-switch.md) |
| Wire a real catalog / DB / webhook fulfillment | [docs/customization.md](./docs/customization.md) |
| Anti-patterns to avoid | [AGENTS.md](./AGENTS.md#anti-patterns-dont-do-these) |

## When the user asks vague questions

- "Make checkout work" → ask which gateway they have credentials for. If both, default to `cardsshield` (lower rate, lower chargeback risk).
- "Make it look nicer" → Tailwind theme tokens in `src/app/globals.css` are the right surface. Component chrome is OK to restyle; iframe behavior is not.
- "Add Stripe / Authorize.net" → genuine extension work. Loop in the human; explain that adding a third rail isn't a copy-paste and the auto-fire fingerprint pattern needs to be re-validated for the new gateway.

## When the user says "this isn't working"

1. Check the build logs for the env validator error. Typos fail the build with a clear message.
2. Check the browser console for CSP errors. The iframe is silently blocked if `frame-src` doesn't include the right domains.
3. Check the gateway portal for webhook delivery failures.
4. Check the order-store. If using the in-memory default in production, that's the bug — replace with a DB.

Don't disable signature verification, don't add silent fallbacks to the env validator, don't trust client-supplied prices in mint routes. Those rules exist because they bit the original author in production.
