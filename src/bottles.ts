// Message in a bottle: a player pays the store BOTTLE_CONFIG.PRICE to write an anonymous note and throw it out to
// sea from the store page (see webapp/api.ts). It washes up some hidden time later (washUpTime), and from then on
// each /fish by anyone but its writer has a CATCH_CHANCE of reeling it in instead of a fish, and reading it to the
// chat (see Fishing.cast). Pure functions and data, no runtime imports, so scripts/sim-fishing.mjs can load it.
//
// The writer is never shown anywhere. It's stored only so nobody catches their own bottle, for the MAX_IN_WATER
// limit, and for the owner's moderation commands (/bottles, /bottlepull, /bottlewho in fishing.ts).
export type BottleDistance = "shore" | "buoys" | "sea";

export const BOTTLE_CONFIG = {
  PRICE: 5,
  MAX_CHARS: 200,
  MAX_LINES: 3,
  MAX_IN_WATER: 3, // per author: thrown and not yet caught or removed
  CATCH_CHANCE: 0.35,
} as const;

// How far you throw it is how long it drifts. The page shows the hint, never the exact time: the wash-up time is
// hidden from everyone, the writer included.
export const BOTTLE_DISTANCES: Record<BottleDistance, { emoji: string; label: string; hint: string; minHours: number; maxHours: number }> = {
  shore: { emoji: "🏖️", label: "Close to shore", hint: "washes up in a day or two", minHours: 24, maxHours: 48 },
  buoys: { emoji: "🛟", label: "Past the buoys", hint: "washes up in 3 to 5 days", minHours: 72, maxHours: 120 },
  sea: { emoji: "🌊", label: "Out to sea", hint: "washes up in a week or two", minHours: 168, maxHours: 336 },
};

// The note as it'll be stored and read out: trimmed, newlines normalized to \n, control characters other than \n
// stripped, trailing spaces cut from each line, and any run of blank lines collapsed to one. Lengths are UTF-16
// code units, the same count as the page's textarea maxlength.
export function cleanBottleText(
  raw: string
): { ok: true; text: string } | { ok: false; reason: "EMPTY" | "TOO_LONG" | "TOO_MANY_LINES" } {
  const text = raw
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .replace(/[\p{Cc}]/gu, (char) => (char === "\n" ? char : ""))
    .replace(/[^\S\n]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length === 0) {
    return { ok: false, reason: "EMPTY" };
  }
  if (text.length > BOTTLE_CONFIG.MAX_CHARS) {
    return { ok: false, reason: "TOO_LONG" };
  }
  if (text.split("\n").length > BOTTLE_CONFIG.MAX_LINES) {
    return { ok: false, reason: "TOO_MANY_LINES" };
  }
  return { ok: true, text };
}

// When a bottle thrown at thrownAtSec washes up: a uniformly random whole number of seconds into the distance's
// range, both ends included, so it can land on any hour or minute.
export function washUpTime(distance: BottleDistance, thrownAtSec: number, random: () => number = Math.random): number {
  const { minHours, maxHours } = BOTTLE_DISTANCES[distance];
  const spanSec = (maxHours - minHours) * 3600;
  return thrownAtSec + minHours * 3600 + Math.floor(random() * (spanSec + 1));
}

// For a throw that would put a 4th of your bottles in the water. Plain text; the page shows it in full.
export const LITTER_LINES: readonly string[] = [
  "🚯 You've already got 3 bottles bobbing around out there. The fish are drafting a lawsuit. Wait till someone finds one.",
  "🚯 Three bottles in the lake is littering. Four is a Superfund site.",
  "🚯 The lake is not your recycling bin. Three bottles out is plenty. Wait till someone finds one.",
  "🚯 A turtle just got your second bottle stuck on its head. You don't get a fourth.",
  "🚯 The ducks are nesting in your bottles now. Stop. Wait till someone reels one in.",
  "🚯 Three bottles out already. The lake has started a GoFundMe to clean up after you.",
  "🚯 Easy, Exxon. Three bottles in the water is your limit until somebody fishes one out.",
];

export function isBottleDistance(value: unknown): value is BottleDistance {
  return value === "shore" || value === "buoys" || value === "sea";
}
