// What the General Store sells (see store.ts and the Store DO), and what each piece does to a cast (see
// CastGear in fishing-math.ts). Pure data, no runtime imports, so scripts/sim-fishing.mjs can load it.
//
// Two upgrade lines, bought one tier at a time and kept forever, plus worms, which are used up:
//   🎣 Rod  - bigger fish: each catch's weight is rolled more than once and the biggest kept (see rollCatch).
//             Fiberglass rolls twice half the time, Carbon twice, Legendary three times. That's a big lift to
//             everyday catches (a Legendary rod's typical fish is about 1.85x) and a smaller one to trophies, so
//             the leaderboard stays about fishing more than shopping (the sim checks records don't run away).
//   🚣 Boat - fish away from the crowd: the lake counts only part of today's earlier casts against you.
//             It never makes the lake better than empty, so early casters aren't beaten, only matched.
//   🪱 Worms - one per cast, used automatically on your next /fish: half the junk. Cheap, so one tap buys
//             one (rods and boats take a confirming second tap).
// Tier 0 is what everyone starts with, free. Prices are in beans, set by how long they take a player to earn: about
// 25 beans a day selling everything they catch (the sim prints this). Rods: Fiberglass in about 2 days, Carbon about 2
// weeks, Legendary about 2 months. Boats cost more (Rowboat about 2 days, Bass boat about 3 weeks, Yacht about 3
// months), since a boat is the bigger help: late in a busy day, a yacht turns a fished-out lake back into a good one.
// Feeding the pet some of your fish stretches all of these. Tier names are stored as ledger labels, but tiers are
// stored by number, so names can change freely; never reorder them.
export type GearLine = "rod" | "boat";

export interface GearTier {
  name: string;
  price: number;
  effect: number; // rod: weight rolls per catch, keeping the biggest (see rollCatch); boat: lake relief (0-1)
}

export const GEAR_LINES: Record<GearLine, { emoji: string; pitch: string; tiers: GearTier[] }> = {
  rod: {
    emoji: "🎣",
    pitch: "bigger fish on every cast",
    tiers: [
      { name: "Basic rod", price: 0, effect: 1 },
      { name: "Fiberglass rod", price: 40, effect: 1.5 },
      { name: "Carbon rod", price: 350, effect: 2 },
      { name: "Legendary rod", price: 1500, effect: 3 },
    ],
  },
  boat: {
    emoji: "🚣",
    pitch: "fish away from the crowd when the lake's busy",
    tiers: [
      { name: "Inner tube", price: 0, effect: 0 },
      { name: "Rowboat", price: 60, effect: 0.25 },
      { name: "Bass boat", price: 600, effect: 0.5 },
      { name: "Yacht", price: 2500, effect: 0.75 },
    ],
  },
};

export const WORMS = {
  emoji: "🪱",
  price: 5,
  maxHeld: 5,
  junkMultiplier: 0.5,
} as const;

// 🗺️ Tide chart, bought on the store page only: this week's tides (see tideForecast in fishing-math.ts), how rested
// the owner's spot is, and how busy the lake is, for days from purchase. Buying while one is active adds days to it.
// Private to its owner, so it never shows on the card's activity line.
export const TIDE_CHART_ITEM = {
  emoji: "🗺️",
  price: 40,
  days: 7,
} as const;

export interface AnglerGear {
  rod: number; // tier index into GEAR_LINES.rod.tiers
  boat: number;
  worms: number;
}

export const STARTER_GEAR: AnglerGear = { rod: 0, boat: 0, worms: 0 };

// What this gear does to a cast. useWorm: whether this cast gets one of the angler's worms.
export function castGear(gear: AnglerGear, useWorm: boolean): { rolls: number; lakeRelief: number; junk: number } {
  return {
    rolls: GEAR_LINES.rod.tiers[gear.rod]?.effect ?? 1,
    lakeRelief: GEAR_LINES.boat.tiers[gear.boat]?.effect ?? 0,
    junk: useWorm ? WORMS.junkMultiplier : 1,
  };
}
