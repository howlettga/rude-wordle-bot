// The General Store's prices (see store.ts and the Store DO). Pure functions, no storage and no runtime
// imports, so scripts/sim-fishing.mjs can load this file directly.
//
// A fish sells for (a flat dock fee + weight * today's price per lb) * a hidden multiplier for how rare the species is,
// tripled if it's today's species of the day:
//   price per lb = FISH_BASE_PER_LB * index, rounded to 0.01 (the only number the /store card shows)
//   dock fee     = FISH_DOCK_FEE * index (it swings with the market too, but it's never shown: small fish just pay
//                  better than their weight suggests)
//   index        = exp(PRICE_SIGMA * level), clamped to [PRICE_MIN, PRICE_MAX]
//   level        = the average of the last PRICE_WINDOW_DAYS days' normal deviates, rescaled to N(0, 1)
// The window is short on purpose, so the market is lively: each day shares only half its input with the day before,
// a typical day moves about a third, and about 1 day in 10 the price doubles or halves (a boom or a crash). Each
// chat's prices come from TIDE_SECRET with their own salt (see Store.fishPriceIndex), and turn over with
// the fishing day at 5am ET. Weight already counts linearly here, while the pet's food from a fish only
// grows with its square root (see foodForFish), so big fish are better sold and small ones better fed.
// At these numbers a typical fish sells for about 30 beans, and a player earns about 25 beans a day if they sell
// everything they catch (the sim checks this; it's about half that for someone who feeds the pet). Swingier prices
// average a little higher than the typical day (a log-normal's mean grows with its spread).
import type { FishTier } from "./fishing-math.js";

export const STORE_CONFIG = {
  FISH_BASE_PER_LB: 1.75,
  FISH_DOCK_FEE: 5,
  // Each chat's store wants one species a day (see DEMAND_SPECIES and Store.demandOn), shown on the card as "Buying
  // salmon today", and pays this times as much for it. The multiplier itself is never shown.
  DEMAND_MULTIPLIER: 3,
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
  // About 1 fishing day in SALE_EVERY_DAYS (per chat, at random, seeded like the tide so it's the same all day), the
  // store has a sale: everything you buy (rods, boats, worms, the tide chart, bottles) is SALE_DISCOUNT off, rounded
  // down. Selling fish and pet fund donations aren't affected.
  SALE_EVERY_DAYS: 10,
  SALE_DISCOUNT: 0.25,
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

// inDemand: the fish is today's species of the day. The dock fee scales with the day's market the same way the per-lb
// price does (perLb / FISH_BASE_PER_LB is the day's index).
export function fishSalePrice(weight: number, tier: FishTier, perLb: number, inDemand = false): number {
  const { FISH_BASE_PER_LB, FISH_DOCK_FEE, TIER_MULTIPLIER, DEMAND_MULTIPLIER, MIN_SALE } = STORE_CONFIG;
  const dockFee = FISH_DOCK_FEE * (perLb / FISH_BASE_PER_LB);
  const demand = inDemand ? DEMAND_MULTIPLIER : 1;
  return Math.max(MIN_SALE, Math.round((dockFee + weight * perLb) * TIER_MULTIPLIER[tier] * demand));
}

// The sale discount as a whole percent ("25% off"), for the card and the page.
export const SALE_PERCENT = Math.round(STORE_CONFIG.SALE_DISCOUNT * 100);

// Whether a day is a sale day, from a seeded uniform value for that chat and day (see Store.saleOn).
export function isSaleDay(uniform: number): boolean {
  return uniform < 1 / STORE_CONFIG.SALE_EVERY_DAYS;
}

// What something costs today: SALE_DISCOUNT off on a sale day, rounded down, never below 🫘1.
export function salePrice(price: number, onSale: boolean): number {
  return onSale ? Math.max(1, Math.floor(price * (1 - STORE_CONFIG.SALE_DISCOUNT))) : price;
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
