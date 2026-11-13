// The /fish roll (see fishing.ts and the Fishing DO). Pure functions, no storage, so the odds can be
// checked statistically in isolation.
//
// Every roll is a log-normal weight: median MEDIAN_LB, spread SIGMA — mostly small fish, with a long
// tail of rare monsters. A cast keeps the best of several rolls, and waiting between casts earns more
// of them (rollsForWait). The odds are identical for everyone; the only lever anyone has is how long
// they wait, capped at MAX_WAIT_DAYS.
//
// Reference odds per cast, as tuned here:
//   1 day waited  (1 roll):    typical 4.0 lb,  1 in 10 beats 14.4 lb, >100 lb is 1 in 1,554
//   7+ days waited (10 rolls): typical 17.9 lb, 1 in 10 beats 40.2 lb, >100 lb is 1 in 156
// Over a year, casting weekly earns ~43% more rolls than casting daily (521 vs 365) — a slight edge for
// patience, not a dominant one. Waiting past MAX_WAIT_DAYS only loses rolls.

const MEDIAN_LB = 4;
const SIGMA = 1.0;
export const MAX_WAIT_DAYS = 7;

// days + (days - 1) / 2, capped: 1 day -> 1 roll, 3 -> 4, 7 -> 10. Rolls per day waited rises steadily
// up to the cap (1.0, 1.25, 1.33, ... 1.43), so every extra day of waiting is worth slightly more than
// the last — a flat days -> days mapping would make waiting exactly neutral, and a lumpier one can make
// some shorter cadence beat a full week. Fractional rolls are fine: see rollWeight.
export function rollsForWait(daysWaited: number): number {
  const days = Math.min(MAX_WAIT_DAYS, Math.max(1, daysWaited));
  return days + (days - 1) / 2;
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
