// The General Store's prices (see store.ts and the Store DO). Pure functions, no storage and no runtime
// imports, so scripts/sim-fishing.mjs can load this file directly.
//
// Fish sell for weight * today's price per lb * a hidden multiplier for how rare the species is:
//   price per lb = FISH_BASE_PER_LB * index, rounded to 0.01 (the number the /store card shows)
//   index        = exp(PRICE_SIGMA * level), clamped to [PRICE_MIN, PRICE_MAX]
//   level        = the average of the last PRICE_WINDOW_DAYS days' normal deviates, rescaled to N(0, 1)
// So, like the tide, neighboring days share most of their inputs and prices drift rather than jump. Each
// chat's prices come from TIDE_SECRET with their own salt (see Store.fishPriceIndex), and turn over with
// the fishing day at 5am ET. Weight already counts linearly here, while the pet's food from a fish only
// grows with its square root (see foodForFish), so big fish are better sold and small ones better fed.
// At these numbers a typical fish sells for about 5 beans, and a chat landing ~2.6 fish a day earns about
// 20 beans a day if it sells everything (the sim checks this).
import type { FishTier } from "./fishing-math.js";

export const STORE_CONFIG = {
  FISH_BASE_PER_LB: 0.35,
  PRICE_WINDOW_DAYS: 7,
  // At 0.35, 9 days in 10 land between about 0.56x and 1.78x base, and a typical day moves 10-13%.
  PRICE_SIGMA: 0.35,
  PRICE_MIN: 0.5,
  PRICE_MAX: 2,
  // Never printed anywhere: people work it out from what rare fish sell for.
  TIER_MULTIPLIER: { common: 1, rare: 3, legendary: 10 } satisfies Record<FishTier, number>,
  // Even a minnow is worth something.
  MIN_SALE: 1,
} as const;

// normals: one N(0, 1) deviate per day of the window, oldest first.
export function fishPriceIndex(normals: number[]): number {
  const { PRICE_SIGMA, PRICE_MIN, PRICE_MAX } = STORE_CONFIG;
  const level = normals.reduce((sum, n) => sum + n, 0) / Math.sqrt(normals.length);
  return Math.min(PRICE_MAX, Math.max(PRICE_MIN, Math.exp(PRICE_SIGMA * level)));
}

export function fishPricePerLb(index: number): number {
  return Math.round(STORE_CONFIG.FISH_BASE_PER_LB * index * 100) / 100;
}

export function fishSalePrice(weight: number, tier: FishTier, perLb: number): number {
  return Math.max(STORE_CONFIG.MIN_SALE, Math.round(weight * perLb * STORE_CONFIG.TIER_MULTIPLIER[tier]));
}

// The bean is the currency sign, like a dollar sign: "🫘18", "🫘1,204". Everywhere money shows up, so
// people get used to reading it.
export const BEAN = "🫘";

export function formatBeans(amount: number): string {
  return `${BEAN}${amount.toLocaleString("en-US")}`;
}

// A price per lb, to the cent: "🫘0.38".
export function formatBeanPrice(amount: number): string {
  return `${BEAN}${amount.toFixed(2)}`;
}
