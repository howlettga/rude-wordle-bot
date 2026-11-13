// The /fish roll (see fishing.ts and the Fishing DO). Pure functions, no storage, so the odds can be
// checked statistically in isolation.
//
// Every roll is a log-normal weight: median MEDIAN_LB, spread SIGMA — mostly small fish, with a long
// tail of rare monsters. A cast keeps the best of several rolls, and waiting between casts earns more
// of them (rollsForWait). The odds are identical for everyone; the only lever anyone has is how long
// they wait, capped at MAX_WAIT_DAYS.
//
// Built so people fish when they happen to remember, not on a schedule — and so spamming /fish is
// pointless. Reference odds per cast, as tuned here:
//   1 day waited:   60% junk, typical 0.5 lb
//   7 days waited:  12% junk, typical 12.8 lb, 1 in 10 beats 31.3 lb
//   14 days waited:  6% junk, typical 20.5 lb, 1 in 10 beats 44.5 lb
//   30+ days waited: 5% junk, typical 29.5 lb, 1 in 10 beats 59.2 lb, >100 lb is 2%
// Casting on any fixed schedule for a year, after junk: every 14/21/30 days lands within 7% of each other
// on total rolls (323/341/346 — typical best of the year 69.6/70.8/71.1 lb), so there's no rhythm worth
// optimizing; weekly gets 70% of that, daily 8%, and waiting past a month only loses rolls.

const MEDIAN_LB = 4;
const SIGMA = 1.0;
export const MAX_WAIT_DAYS = 30;
// A first-ever cast counts as this many days waited — a medium start, the same as someone who fishes weekly.
export const FIRST_CAST_WAIT_DAYS = 7;
// Junk caught within this many days of the last cast gets the "overfished waters" line (see fishing.ts),
// so people can work out that they're casting too often without the math ever being shown.
export const OVERFISHED_WITHIN_DAYS = 3;

// days * (1 - e^(-days/5)), capped at MAX_WAIT_DAYS: 1 day -> 0.18 rolls, 7 -> 5.3, 14 -> 13.2,
// 30 -> 29.9. Rolls per day waited starts tiny and climbs over the first two weeks (0.18, 0.45 at 3 days,
// 0.75 at 7, 0.94 at 14), then flattens out (0.99 at 21, 1.00 at 30) — so short waits are clearly worse,
// but nothing between ~2 and 4 weeks is meaningfully better than anything else. Fewer than 1 roll is
// fine (see rollWeight): it just means smaller than a single normal roll.
export function rollsForWait(daysWaited: number): number {
  const days = Math.min(MAX_WAIT_DAYS, Math.max(1, daysWaited));
  return days * (1 - Math.exp(-days / 5));
}

// The best of `rolls` independent weights, sampled directly rather than rolling each one: if one roll's
// CDF is F, the best of r rolls has CDF F^r, so F(best) = U^(1/r) for a uniform U. That also makes
// fractional r well-defined. Rounded to 0.1 lb, never below 0.1.
export function rollWeight(rolls: number, random: () => number = Math.random): number {
  const u = Math.pow(random(), 1 / rolls);
  if (u <= 0) {
    return 0.1;
  }
  const weight = MEDIAN_LB * Math.exp(SIGMA * inverseNormalCdf(u));
  return Math.max(0.1, Math.round(weight * 10) / 10);
}

// Any cast can reel in junk instead of a fish: no weight, never on the leaderboard, and it still uses up
// the day's cast and the waiting bonus. 5% + 55% * e^(-(days - 1)/3): 60% the day after a cast, 33% at 3
// days, 12% at 7, settling to the base 5% after about two weeks — overfished waters are mostly junk.
function trashChance(daysWaited: number): number {
  const days = Math.min(MAX_WAIT_DAYS, Math.max(1, daysWaited));
  return 0.05 + 0.55 * Math.exp(-(days - 1) / 3);
}

const TRASH: [item: string, emoji: string][] = [
  ["an old boot", "🥾"],
  ["a soggy sock", "🧦"],
  ["a bald tire", "🛞"],
  ["someone's dentures", "🦷"],
  ["a single AirPod", "🎧"],
  ["a shopping cart", "🛒"],
  ["one Croc", "🐊"],
  ["a parking ticket with your name on it", "🎫"],
  ["a Live Laugh Love sign", "🪧"],
  ["a dead vape", "💨"],
  ["an unopened can of Natty Light", "🍺"],
  ["a Blockbuster membership card", "📼"],
  ["a rubber duck", "🦆"],
  ["a clump of seaweed", "🌿"],
  ["a traffic cone", "🚧"],
];

export function rollTrash(daysWaited: number, random: () => number = Math.random): { item: string; emoji: string } | null {
  if (random() >= trashChance(daysWaited)) {
    return null;
  }
  const [item, emoji] = TRASH[Math.floor(random() * TRASH.length)]!;
  return { item, emoji };
}

// Species are picked by weight, so the name tells you how good the catch was (a marlin is always huge).
const SPECIES_BANDS: { maxLb: number; species: [name: string, emoji: string][] }[] = [
  { maxLb: 1, species: [["minnow", "🐟"], ["sunfish", "🐠"], ["perch", "🐟"]] },
  { maxLb: 5, species: [["trout", "🐟"], ["bass", "🐟"], ["walleye", "🐟"]] },
  { maxLb: 15, species: [["salmon", "🐟"], ["catfish", "🐟"], ["carp", "🐟"]] },
  { maxLb: 40, species: [["pike", "🐟"], ["striped bass", "🐟"], ["mahi-mahi", "🐠"]] },
  { maxLb: 100, species: [["muskie", "🐟"], ["halibut", "🐟"], ["tarpon", "🐡"]] },
  { maxLb: 300, species: [["tuna", "🐟"], ["swordfish", "🗡️"], ["sturgeon", "🐟"]] },
  { maxLb: Infinity, species: [["marlin", "🐟"], ["great white shark", "🦈"]] },
];

export function speciesForWeight(weight: number, random: () => number = Math.random): { species: string; emoji: string } {
  const band = SPECIES_BANDS.find((b) => weight < b.maxLb)!;
  const [species, emoji] = band.species[Math.floor(random() * band.species.length)]!;
  return { species, emoji };
}

// Acklam's rational approximation of the standard normal inverse CDF (relative error < 1.2e-9), for
// p in (0, 1).
function inverseNormalCdf(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;

  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}
