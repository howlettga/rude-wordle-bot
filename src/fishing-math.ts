// The /fish roll (see fishing.ts and the Fishing DO). Pure functions, no storage, so the odds can be
// checked statistically in isolation (scripts/sim-fishing.mjs).
//
// Every cast has a quality q, a plain multiplier on the typical fish, built from three things:
//   wait  - how long since this angler last cast (WAIT_FACTOR): casting every day is a mild penalty, and
//           anything from 4 days on is full strength. Waiting longer gains nothing more.
//   tide  - the chat's hidden tide today (see tideFor).
//   lake  - how many casts the whole chat has already made today (lakeFactor): the first few are a bonus,
//           and it turns into a penalty around the 5th, so the lake is a shared resource.
// q = max(Q_FLOOR, wait * tide * lake). The weight is log-normal with median MEDIAN_LB * q and spread
// SIGMA, so q = 0.5 means a half-size typical fish; the species is picked from that final weight. Lower q
// also means more junk (junkChance).
//
// Reference odds per cast, as tuned here (normal tide):
//   daily, 1st cast of the day:  q 0.68, 16% junk, median  9.5 lb, 1 in 10 beats 25 lb
//   4+ days, 3rd cast:           q 1.15,  5% junk, median 16 lb,   1 in 10 beats 42 lb
//   4+ days, 8th cast:           q 0.65, 17% junk, median  9.1 lb, 1 in 10 beats 24 lb
//   4+ days, 1st cast, king tide: q 2.70,  5% junk, median 38 lb,   1 in 100 beats 216 lb
// Over a year, the best trophy odds come from casting every 3-5 days; casting daily lands the most fish
// (handy for feeding the pet), just smaller ones.
export const FISHING_CONFIG = {
  // The fishing day (one cast each, the lake count, the tide) turns over at this Eastern hour, not midnight.
  DAY_STARTS_HOUR_ET: 5,

  MEDIAN_LB: 14,
  SIGMA: 0.75,
  MIN_LB: 0.3,

  // By days since the angler's last cast: 1, 2, 3, 4+.
  WAIT_FACTOR: [0.5, 0.7, 0.88, 1.0],
  // A first-ever cast counts as this many days waited: full strength.
  FIRST_CAST_WAIT_DAYS: 7,

  // lake = max(LAKE_FLOOR, LAKE_START - LAKE_STEP * castsAlreadyToday): 1.35, 1.25, 1.15, 1.05, 0.95, ...
  // 0.65 on the 8th cast, LAKE_FLOOR from the 11th.
  LAKE_START: 1.35,
  LAKE_STEP: 0.1,
  LAKE_FLOOR: 0.4,

  // However bad wait, tide, and lake stack up, a cast is never worse than this.
  Q_FLOOR: 0.3,

  // junk = JUNK_BASE + JUNK_SLOPE * (1 - q), between JUNK_BASE and JUNK_MAX: 5% at q >= 1, 30% at worst.
  JUNK_BASE: 0.05,
  JUNK_SLOPE: 0.35,
  JUNK_MAX: 0.3,

  // A catch under this many pounds (or junk) can get a hint about what dragged it down (see hintFor)...
  POOR_CATCH_LB: 6,
  // ...naming the worst factor below this, unless the lake was even worse (its line already says so).
  HINT_BELOW_FACTOR: 0.75,
} as const;

export interface CastFactors {
  wait: number;
  tide: number;
  lake: number;
  quality: number;
}

// What an angler's gear does to a cast (see gear.ts for where the numbers come from). rolls is how many times the
// fish's weight is rolled, keeping the biggest (the rod; see rollCatch). lakeRelief is the share of today's earlier
// casts the lake doesn't count against you (the boat: you fish away from the crowd, but never better than an
// empty lake). junk multiplies the junk chance (worms). NO_GEAR changes nothing.
export interface CastGear {
  rolls: number;
  lakeRelief: number;
  junk: number;
}
export const NO_GEAR: CastGear = { rolls: 1, lakeRelief: 0, junk: 1 };

export function waitFactor(daysWaited: number): number {
  const table = FISHING_CONFIG.WAIT_FACTOR;
  const index = Math.min(table.length, Math.max(1, Math.floor(daysWaited))) - 1;
  return table[index]!;
}

// castsToday: casts anyone in the chat made today before this one.
export function lakeFactor(castsToday: number): number {
  const { LAKE_START, LAKE_STEP, LAKE_FLOOR } = FISHING_CONFIG;
  return Math.max(LAKE_FLOOR, LAKE_START - LAKE_STEP * Math.max(0, castsToday));
}

export function castFactors(input: { daysWaited: number; tide: Tide; castsToday: number; gear?: CastGear }): CastFactors {
  const gear = input.gear ?? NO_GEAR;
  const wait = waitFactor(input.daysWaited);
  const tide = tideMultiplier(input.tide);
  const lake = lakeFactor(input.castsToday * (1 - gear.lakeRelief));
  return { wait, tide, lake, quality: Math.max(FISHING_CONFIG.Q_FLOOR, wait * tide * lake) };
}

// junkMultiplier: worms (see CastGear.junk) scale the final chance down.
export function junkChance(quality: number, junkMultiplier = 1): number {
  const { JUNK_BASE, JUNK_SLOPE, JUNK_MAX } = FISHING_CONFIG;
  return junkMultiplier * Math.min(JUNK_MAX, Math.max(JUNK_BASE, JUNK_BASE + JUNK_SLOPE * (1 - quality)));
}

// The catch's weight with a rod's extra rolls (CastGear.rolls): rolls the weight that many times and keeps the
// biggest. A fractional count is a chance of one more roll: 1.5 is a second roll half the time. Keeping the best
// of N lifts every catch a lot (the best of 2 is about 1.5x a single roll's typical fish, the best of 3 about
// 1.85x) while lifting trophies only somewhat (a 1-in-100 fish about 1.15x and 1.3x), since the top of the curve
// is already rare.
export function rollCatch(quality: number, rolls = 1, random: () => number = Math.random): number {
  const whole = Math.max(1, Math.floor(rolls));
  const count = whole + (random() < rolls - whole ? 1 : 0);
  let best = 0;
  for (let i = 0; i < count; i++) {
    best = Math.max(best, rollWeight(quality, random));
  }
  return best;
}

// Log-normal around MEDIAN_LB * quality. Rounded to 0.1 lb, never below MIN_LB.
export function rollWeight(quality: number, random: () => number = Math.random): number {
  const { MEDIAN_LB, SIGMA, MIN_LB } = FISHING_CONFIG;
  const u = Math.min(1 - 1e-12, Math.max(1e-12, random()));
  const weight = MEDIAN_LB * quality * Math.exp(SIGMA * inverseNormalCdf(u));
  return Math.max(MIN_LB, Math.round(weight * 10) / 10);
}

// How busy the lake is today, for the catch reply's flavor line. Keyed off lakeFactor rather than the raw
// count, so retuning LAKE_START / LAKE_STEP keeps the words in step with the odds.
export type LakeTier = "fresh" | "calm" | "busy" | "crowded" | "fished_out";
const LAKE_TIERS: { tier: LakeTier; atLeast: number }[] = [
  { tier: "fresh", atLeast: 1.3 }, // nobody's cast yet (at the defaults)
  { tier: "calm", atLeast: 1.1 }, // 1-2 casts before this one
  { tier: "busy", atLeast: 0.8 }, // 3-5
  { tier: "crowded", atLeast: 0.55 }, // 6-8
  { tier: "fished_out", atLeast: -Infinity }, // 9+
];

export function lakeTier(castsToday: number): LakeTier {
  const factor = lakeFactor(castsToday);
  return LAKE_TIERS.find((t) => factor >= t.atLeast)!.tier;
}

// What to blame a poor catch on: the angler's own spot (they cast too recently) or a low tide —
// whichever dragged harder. Nothing when neither was much of a drag, or when the lake was the worst
// factor, since the lake line already covers that.
export type CatchHint = "spot" | "low_tide";

export function hintFor(factors: CastFactors): CatchHint | null {
  const causes: { hint: CatchHint; factor: number }[] = [
    { hint: "spot", factor: factors.wait },
    { hint: "low_tide", factor: factors.tide },
  ];
  const worst = causes.filter((c) => c.factor < FISHING_CONFIG.HINT_BELOW_FACTOR).sort((a, b) => a.factor - b.factor)[0];
  if (!worst || factors.lake < worst.factor) {
    return null;
  }
  return worst.hint;
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

// Junk instead of a fish: no weight, never on the leaderboard or in anyone's bucket, and it still uses
// up the day's cast.
export function rollTrash(quality: number, junkMultiplier = 1, random: () => number = Math.random): { item: string; emoji: string } | null {
  if (random() >= junkChance(quality, junkMultiplier)) {
    return null;
  }
  const [item, emoji] = TRASH[Math.floor(random() * TRASH.length)]!;
  return { item, emoji };
}

// Tides: each chat's water has a hidden tide that multiplies everyone's cast quality that day (see
// castFactors — so a king tide the day after your last cast is still only a decent cast). It comes in
// streaks, like real weather, without following any real-world cycle anyone could plan around:
//   1. Every chat/day gets a "swell": a standard normal value derived from a hash of the secret, the chat,
//      and the day. Unpredictable without the secret (TIDE_SECRET), and the same every time it's computed.
//   2. A day's tide is the average of the last TIDE_WINDOW_DAYS swells (scaled back to N(0, 1)), so
//      neighboring days share most of their inputs and drift together.
//   3. That average maps onto fixed tiers at N(0, 1) quantiles, so over time the split is exactly
//      25% low / 50% normal / 20% high / 5% king.
// With a 4-day window, high-or-better stretches last ~2.8 days on average and come around every ~8 days;
// a high day is followed by another 64% of the time. The multipliers average about 1
// (.25 * .6 + .5 * 1 + .2 * 1.4 + .05 * 2 = 1.03), so tides add swing without shifting long-run odds.
// Nothing is stored and nothing is scheduled — a day's tide is just TIDE_WINDOW_DAYS hashes.
export type Tide = "low" | "normal" | "high" | "king";

const TIDE_WINDOW_DAYS = 4;
const TIDE_TIERS: { tide: Tide; below: number; multiplier: number }[] = [
  { tide: "low", below: -0.6745, multiplier: 0.6 }, // N(0, 1) 25th percentile
  { tide: "normal", below: 0.6745, multiplier: 1 }, // 75th
  { tide: "high", below: 1.6449, multiplier: 1.4 }, // 95th
  { tide: "king", below: Infinity, multiplier: 2.0 },
];

// dayNumber: whole days since the Unix epoch, for the fishing day (so the tide turns at
// DAY_STARTS_HOUR_ET, along with the daily cast limit).
export function tideFor(secret: string, chatId: number, dayNumber: number): Tide {
  let sum = 0;
  for (let day = dayNumber - TIDE_WINDOW_DAYS + 1; day <= dayNumber; day++) {
    sum += seededNormal(`${secret}:${chatId}:${day}`);
  }
  const level = sum / Math.sqrt(TIDE_WINDOW_DAYS);
  return TIDE_TIERS.find((tier) => level < tier.below)!.tide;
}

export function tideMultiplier(tide: Tide): number {
  return TIDE_TIERS.find((tier) => tier.tide === tide)!.multiplier;
}

// A line from `lines` for the step-th use under `key` (e.g. chat + date + which set). Each key gets its own
// fixed shuffle, and consecutive steps walk through it, so nothing repeats until the whole set has been
// used, and a different key (tomorrow) gets a different order. Deterministic: no state to store.
export function rotatingLine(lines: readonly string[], key: string, step: number): string {
  let seed = cyrb53(key) % 2 ** 32;
  const next = () => {
    // mulberry32
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const order = lines.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const index = ((step % lines.length) + lines.length) % lines.length;
  return lines[order[index]!]!;
}

// cyrb53 (bryc, public domain): a fast, well-mixed 53-bit string hash. Not cryptographic, but with a
// long random secret in the input there's no practical way to predict tides from the ones already seen.
function cyrb53(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// Species are picked by weight, so the name tells you how good the catch was (a marlin is always huge).
// Within a band, weight is each species' relative odds: the commons split most catches, and each band has
// one rare species (about 1 in 10). A species can show up in more than one band: the goldfish's own band
// (under 1 lb) is so seldom caught that it also turns up among 1-5 lb fish, and the legendary megalodon
// (a young one, below 300 lb) can surface from 40 lb up, so a chat sees one every year or two. The sim
// (scripts/sim-fishing.mjs) checks that it stays the rarest of the rare and legendary fish. The catch reply never says which
// is which; the only giveaway is what the store pays (see STORE_CONFIG.TIER_MULTIPLIER). Names are stored
// with every catch and keyed on for prices, so never rename one; add new ones freely.
export type FishTier = "common" | "rare" | "legendary";
type SpeciesEntry = { name: string; emoji: string; tier: FishTier; weight: number };
const common = (name: string, emoji: string): SpeciesEntry => ({ name, emoji, tier: "common", weight: 30 });
const rare = (name: string, emoji: string, weight = 10): SpeciesEntry => ({ name, emoji, tier: "rare", weight });
const megalodon = (weight: number): SpeciesEntry => ({ name: "megalodon", emoji: "🦈", tier: "legendary", weight });

const SPECIES_BANDS: { maxLb: number; species: SpeciesEntry[] }[] = [
  { maxLb: 1, species: [common("minnow", "🐟"), common("sunfish", "🐠"), common("perch", "🐟"), rare("goldfish", "🐠")] },
  {
    maxLb: 5,
    species: [common("trout", "🐟"), common("bass", "🐟"), common("walleye", "🐟"), rare("blobfish", "🫠"), rare("goldfish", "🐠", 3)],
  },
  { maxLb: 15, species: [common("salmon", "🐟"), common("catfish", "🐟"), common("carp", "🐟"), rare("koi", "🎏")] },
  { maxLb: 40, species: [common("pike", "🐟"), common("striped bass", "🐟"), common("mahi-mahi", "🐠"), rare("electric eel", "⚡")] },
  {
    maxLb: 100,
    species: [common("muskie", "🐟"), common("halibut", "🐟"), common("tarpon", "🐡"), rare("alligator gar", "🐊"), megalodon(0.6)],
  },
  {
    maxLb: 300,
    species: [common("tuna", "🐟"), common("swordfish", "🗡️"), common("sturgeon", "🐟"), rare("coelacanth", "🦴", 15), megalodon(3)],
  },
  {
    maxLb: Infinity,
    species: [
      { name: "marlin", emoji: "🐟", tier: "common", weight: 48.5 },
      { name: "great white shark", emoji: "🦈", tier: "common", weight: 48.5 },
      megalodon(20),
    ],
  },
];

export function speciesForWeight(weight: number, random: () => number = Math.random): { species: string; emoji: string } {
  const band = SPECIES_BANDS.find((b) => weight < b.maxLb)!;
  const picked = weightedPick(band.species, random);
  return { species: picked.name, emoji: picked.emoji };
}

// Unknown names (none today) count as common.
export function speciesTier(species: string): FishTier {
  for (const band of SPECIES_BANDS) {
    const entry = band.species.find((s) => s.name === species);
    if (entry) {
      return entry.tier;
    }
  }
  return "common";
}

function weightedPick<T extends { weight: number }>(options: T[], random: () => number): T {
  const total = options.reduce((sum, option) => sum + option.weight, 0);
  let roll = random() * total;
  for (const option of options) {
    roll -= option.weight;
    if (roll < 0) {
      return option;
    }
  }
  return options[options.length - 1]!;
}

// The fishing day as "YYYY-MM-DD" (compares correctly as a plain string) and as whole days since the
// epoch: the Eastern calendar date (pass easternParts(now)), except before DAY_STARTS_HOUR_ET it's still
// the day before. Done on the wall clock rather than by subtracting hours, so DST days don't turn over an
// hour off. The store's prices turn over with it.
export function fishingDay(eastern: { year: number; month: number; day: number; hour: number }): { date: string; dayNumber: number } {
  const dayNumber =
    Date.UTC(eastern.year, eastern.month - 1, eastern.day) / 86_400_000 - (eastern.hour < FISHING_CONFIG.DAY_STARTS_HOUR_ET ? 1 : 0);
  return { date: new Date(dayNumber * 86_400_000).toISOString().slice(0, 10), dayNumber };
}

// Normal deviates from a secret, for the tide and the store's prices: hash -> uniform -> N(0, 1).
export function seededNormal(key: string): number {
  return inverseNormalCdf((cyrb53(key) + 0.5) / 2 ** 53);
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
