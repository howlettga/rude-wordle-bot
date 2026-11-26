// What the General Store sells (see store.ts and the Store DO), and what each piece does to a cast (see
// CastGear in fishing-math.ts). Pure data, no runtime imports, so scripts/sim-fishing.mjs can load it.
//
// Two upgrade lines, bought one tier at a time and kept forever, plus worms, which are used up:
//   🎣 Rod  - bigger fish: a small boost to cast quality on every cast. Kept small on purpose, so the
//             leaderboard stays about fishing, not shopping (the sim checks records don't run away).
//   🚣 Boat - fish away from the crowd: the lake counts only part of today's earlier casts against you.
//             It never makes the lake better than empty, so early casters aren't beaten, only matched.
//   🪱 Worms - one per cast, used automatically on your next /fish: half the junk. Cheap, so one tap buys
//             one (rods and boats take a confirming second tap).
// Tier 0 is what everyone starts with, free. Prices are in beans, set by how many fish they take to earn
// (an average fish sells for about 7.6 beans; the sim prints this). Rods: tier 1 about 5 fish, tier 2
// about 45, tier 3 about 200. Boats cost more (about 8 / 80 / 330), since a boat is the bigger help: late
// in a busy day, a yacht turns a fished-out lake back into a good one. With one cast a day, and some fish
// going to the pet, a top tier takes most of a year or more. Tier names are stored as ledger labels, but tiers are stored by number, so names can change
// freely; never reorder them.
export type GearLine = "rod" | "boat";

export interface GearTier {
  name: string;
  price: number;
  effect: number; // rod: quality multiplier; boat: lake relief (0-1)
}

export const GEAR_LINES: Record<GearLine, { emoji: string; pitch: string; tiers: GearTier[] }> = {
  rod: {
    emoji: "🎣",
    pitch: "bigger fish on every cast",
    tiers: [
      { name: "Basic rod", price: 0, effect: 1 },
      { name: "Fiberglass rod", price: 40, effect: 1.05 },
      { name: "Carbon rod", price: 350, effect: 1.1 },
      { name: "Legendary rod", price: 1500, effect: 1.2 },
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
  price: 2,
  maxHeld: 5,
  junkMultiplier: 0.5,
} as const;

export interface AnglerGear {
  rod: number; // tier index into GEAR_LINES.rod.tiers
  boat: number;
  worms: number;
}

export const STARTER_GEAR: AnglerGear = { rod: 0, boat: 0, worms: 0 };

// What this gear does to a cast. useWorm: whether this cast gets one of the angler's worms.
export function castGear(gear: AnglerGear, useWorm: boolean): { quality: number; lakeRelief: number; junk: number } {
  return {
    quality: GEAR_LINES.rod.tiers[gear.rod]?.effect ?? 1,
    lakeRelief: GEAR_LINES.boat.tiers[gear.boat]?.effect ?? 0,
    junk: useWorm ? WORMS.junkMultiplier : 1,
  };
}
