/**
 * The Switch — single source of truth for which card rail is active.
 *
 * Both rails (CardsShield/KingsGate iframe + PsiFi auto-fire iframe)
 * stay wired in the codebase 24/7. Flipping the
 * `NEXT_PUBLIC_PRIMARY_CARD_RAIL` env var + redeploying is the
 * entire switch procedure. No code changes.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * USAGE NOTES (for AI coding agents):
 *
 *   1. The constants below are read once at module-evaluation time.
 *      NEXT_PUBLIC_* vars are inlined at BUILD time by Next.js. So
 *      changing the env value WITHOUT a redeploy has zero effect.
 *      The runbook in `docs/payment-rail-switch.md` covers this.
 *
 *   2. The validator THROWS on invalid values. A typo like `psify`
 *      or `cardshield` will hard-fail the build rather than
 *      silently fall back to a default. This is intentional — a
 *      silent fallback during an outage means the operator thinks
 *      they fixed something and didn't.
 *
 *   3. The host site can `import { CARD_RAIL } from "@/lib/checkout-config"`
 *      anywhere it needs to branch behavior — analytics events,
 *      copy variants, admin dashboards, etc. Don't read the env
 *      var directly; always import this constant so the validator
 *      runs first.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

const VALID_RAILS = ["cardsshield", "psifi", "quiklie"] as const;
export type CardRail = (typeof VALID_RAILS)[number];

const RAW = (process.env.NEXT_PUBLIC_PRIMARY_CARD_RAIL ?? "cardsshield")
  .trim()
  .toLowerCase();

if (!VALID_RAILS.includes(RAW as CardRail)) {
  throw new Error(
    `[checkout-config] NEXT_PUBLIC_PRIMARY_CARD_RAIL has invalid value "${RAW}". ` +
      `Must be one of: ${VALID_RAILS.join(", ")}.`,
  );
}

export const CARD_RAIL: CardRail = RAW as CardRail;

/**
 * Helper for analytics + display copy. Equivalent to
 * `CARD_RAIL === "cardsshield" ? "KingsGate" : "PsiFi"`.
 */
export const ACTIVE_RAIL_LABEL: string =
  CARD_RAIL === "cardsshield"
    ? "KingsGate"
    : CARD_RAIL === "quiklie"
      ? "Quiklie"
      : "PsiFi";
