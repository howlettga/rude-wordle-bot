// The General Store's prices (see store.ts and the Store DO). Pure functions, no storage and no runtime
// imports, so scripts/sim-fishing.mjs can load this file directly.
//
// Fish sell for weight * today's price per lb * a hidden multiplier for how rare the species is:
//   price per lb = FISH_BASE_PER_LB * index, rounded to 0.01 (the number the /store card shows)
//   index        = exp(PRICE_SIGMA * level), clamped to [PRICE_MIN, PRICE_MAX]
//   level        = the average of the last PRICE_WINDOW_DAYS days' normal deviates, rescaled to N(0, 1)
// The window is short on purpose, so the market is lively: each day shares only half its input with the day before,
// a typical day moves about a third, and about 1 day in 10 the price doubles or halves (a boom or a crash). Each
// chat's prices come from TIDE_SECRET with their own salt (see Store.fishPriceIndex), and turn over with
// the fishing day at 5am ET. Weight already counts linearly here, while the pet's food from a fish only
// grows with its square root (see foodForFish), so big fish are better sold and small ones better fed.
// At these numbers a typical fish sells for about 5 beans, and a chat landing ~2.6 fish a day earns about
// 20 beans a day at a typical day's price if it sells everything (the sim checks this). Swingier prices average a
// little higher than the typical day (a log-normal's mean grows with its spread), so the long-run average is about
// 23.
import type { FishTier } from "./fishing-math.js";

export const STORE_CONFIG = {
  FISH_BASE_PER_LB: 0.35,
  PRICE_WINDOW_DAYS: 2,
  // With a 2-day window, 9 days in 10 land between about 0.37x and 2.7x base, a typical day moves about 37%, and
  // about 1 day in 10 moves 100% or more.
  PRICE_SIGMA: 0.6,
  PRICE_MIN: 0.3,
  PRICE_MAX: 3,
  // Never printed anywhere: people work it out from what rare fish sell for.
  TIER_MULTIPLIER: { common: 1, rare: 3, legendary: 10 } satisfies Record<FishTier, number>,
  // Even a minnow is worth something.
  MIN_SALE: 1,
  // The /store card's Sell a fish pulls a random fish from your bucket; taking the gamble pays this much extra
  // (rounded up, so it's always at least 🫘1). Picking a specific fish in the store page, or selling a catch from
  // its /fish reply, pays the plain price. A secret: never shown or mentioned to players anywhere.
  RANDOM_SELL_BONUS: 0.1,
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

// The extra beans a bonus adds to a sale, rounded up (see RANDOM_SELL_BONUS): 10% of 🫘18 is 🫘2, of 🫘3 is 🫘1.
export function saleBonus(amount: number, bonus: number): number {
  return bonus > 0 ? Math.ceil(amount * bonus) : 0;
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
