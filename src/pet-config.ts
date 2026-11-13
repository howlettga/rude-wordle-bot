// Every pet tuning knob in one place. Change a number here and deploy — nothing else needs touching.
// Meters (food, mood) run 0-100 and are computed lazily from timestamps (see pet-math.ts), so changing a
// rate also applies to the time since the pet was last updated.
//
// Tuned short for v1 (launched over Thanksgiving, when people are around). For a calmer long-term pace,
// lengthen HOURS_TO_STARVE / HOURS_TO_MISERABLE and FEED_COOLDOWN_HOURS / PET_COOLDOWN_HOURS together.
export const PET_CONFIG = {
  // Full food -> empty, at a steady rate. 72h means the chat needs to feed it ~2-3 times a day.
  HOURS_TO_STARVE: 72,
  // Full mood -> 0, at a steady rate while fed...
  HOURS_TO_MISERABLE: 96,
  // ...and this many times faster while food is below HUNGRY_BELOW.
  HUNGRY_MOOD_DECAY_MULTIPLIER: 2,
  HUNGRY_BELOW: 25,

  FEED_AMOUNT: 35,
  // Feeding at or above this much food makes it throw up instead: no food gained, some mood lost.
  OVERFED_AT: 90,
  OVERFED_MOOD_PENALTY: 10,
  PET_AMOUNT: 20,

  // Per person, per action — so one person can't carry the pet alone or mash the buttons.
  FEED_COOLDOWN_HOURS: 3,
  PET_COOLDOWN_HOURS: 3,
  PLAY_COOLDOWN_HOURS: 3,

  // How long a meter can sit at 0 before it's over.
  STARVE_AFTER_EMPTY_HOURS: 24,
  RUN_AWAY_AFTER_MISERABLE_HOURS: 48,

  // Hourly-check warnings only post in this Eastern window (a warning due overnight waits until morning).
  WARN_FROM_HOUR_ET: 9,
  WARN_UNTIL_HOUR_ET: 22,
  HUNGRY_WARNING_AT: 25,
  STARVING_WARNING_AT: 10,
  MISERABLE_WARNING_AT: 15,
} as const;

// The emoji on the card's feed line ("🌮 Galen fed Gregory."), one picked per feed. Deliberately not pet
// food — an implication, not a statement. 🍆 and 🍑 left out on purpose.
export const PET_FOODS = [
  "🌮", "🌭", "🍕", "🍔", "🍟", "🍣", "🍜", "🍝", "🥗", "🌯", "🥨", "🧀", "🥐", "🍩", "🍪", "🎂", "🍰", "🧁",
  "🍫", "🍿", "🥞", "🧇", "🥓", "🍤", "🥟", "🍙", "🌶️", "🥑", "🍋", "🥦", "🌽", "🥕", "🧄", "🧅", "🥥", "🍍",
  "🍉", "🍦", "🍭", "🥫", "🍱", "🥧", "🧈", "🍳", "🥪", "🍞", "🧃", "☕",
];

// What 🎾 Play can turn into. Playing mostly burns food for mood, so even a pet at 100/100 always has
// something worth doing — and then needs feeding again. weight is relative; food/mood are the changes.
// A bite is posted publicly (see pet.ts), like overfeeding.
export type PlayOutcome = "zoomies" | "fetch" | "bored" | "bit";
export const PLAY_OUTCOMES: { kind: PlayOutcome; weight: number; food: number; mood: number }[] = [
  { kind: "zoomies", weight: 35, food: -15, mood: 15 },
  { kind: "fetch", weight: 35, food: -10, mood: 10 },
  { kind: "bored", weight: 17, food: 0, mood: 0 },
  { kind: "bit", weight: 13, food: 0, mood: -10 },
];

export function rollPlayOutcome(random: () => number = Math.random): (typeof PLAY_OUTCOMES)[number] {
  return weightedPick(PLAY_OUTCOMES, random);
}

export type PetRarity = "common" | "rare" | "ultra";

// Rolled at adoption. weight is relative: commons 10 each, rares 2, ultras 0.5 — about 95% / 5% / 1%.
export const PET_SPECIES: { species: string; emoji: string; rarity: PetRarity; weight: number }[] = [
  { species: "dog", emoji: "🐕", rarity: "common", weight: 10 },
  { species: "cat", emoji: "🐈", rarity: "common", weight: 10 },
  { species: "hamster", emoji: "🐹", rarity: "common", weight: 10 },
  { species: "goldfish", emoji: "🐠", rarity: "common", weight: 10 },
  { species: "raccoon", emoji: "🦝", rarity: "common", weight: 10 },
  { species: "goose", emoji: "🪿", rarity: "common", weight: 10 },
  { species: "frog", emoji: "🐸", rarity: "common", weight: 10 },
  { species: "rabbit", emoji: "🐇", rarity: "common", weight: 10 },
  { species: "pig", emoji: "🐖", rarity: "common", weight: 10 },
  { species: "turtle", emoji: "🐢", rarity: "common", weight: 10 },
  { species: "parrot", emoji: "🦜", rarity: "common", weight: 10 },
  { species: "hedgehog", emoji: "🦔", rarity: "common", weight: 10 },
  { species: "sloth", emoji: "🦥", rarity: "rare", weight: 2 },
  { species: "otter", emoji: "🦦", rarity: "rare", weight: 2 },
  { species: "flamingo", emoji: "🦩", rarity: "rare", weight: 2 },
  { species: "dragon", emoji: "🐉", rarity: "ultra", weight: 0.5 },
  { species: "unicorn", emoji: "🦄", rarity: "ultra", weight: 0.5 },
];

export function rollSpecies(random: () => number = Math.random): (typeof PET_SPECIES)[number] {
  return weightedPick(PET_SPECIES, random);
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
