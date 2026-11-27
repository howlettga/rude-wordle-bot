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

  // While the chat has fishing switched on, feeding means feeding it one of your fish (see pet.ts), and a
  // bigger fish is a bigger meal: FISH_FOOD_AT_MEDIAN * sqrt(weight / FISH_FOOD_MEDIAN_LB), clamped.
  // 2 lb -> 11, 5 -> 18, 10 -> 25, 14 -> 30, 20 -> 36, 40 -> 51, 56+ -> 60. A typical catch averages
  // about 27, so the pet needs roughly 1.2 fish a day across the whole chat.
  FISH_FOOD_AT_MEDIAN: 30,
  FISH_FOOD_MEDIAN_LB: 14,
  FISH_FOOD_MIN: 8,
  FISH_FOOD_MAX: 60,
  // A feed with fishing switched off (no fish needed).
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

  // The hourly check's one warning ("it's dying": food at 0) only posts in this Eastern window (one due
  // overnight waits until morning). Hunger and loneliness aren't posted on their own; the pet begs in
  // people's /fish replies instead, below these levels (see petDesireLine in pet.ts).
  WARN_FROM_HOUR_ET: 9,
  WARN_UNTIL_HOUR_ET: 22,
  HUNGRY_WARNING_AT: 25,
  STARVING_WARNING_AT: 10,
  MISERABLE_WARNING_AT: 15,
} as const;

// The pet fund (store page): the chat pools beans for room for another pet. Every chat starts with one
// slot (how many pets can be alive at once), and each goal reached unlocks one more, up to MAX_PET_SLOTS.
// Anything past a goal carries into the next; once every slot is unlocked the fund closes. Slots are
// never lost — a pet dying just frees its slot for the next /adopt. TOP_DONORS is how many names the
// "the fund hit 🫘100!" message thanks.
export const PET_FUND = {
  SLOT_GOALS: [100, 1000, 2500], // beans to unlock slots 2, 3, 4
  DONATION_OPTIONS: [10, 25, 50, 100],
  TOP_DONORS: 3,
} as const;
export const MAX_PET_SLOTS = 1 + PET_FUND.SLOT_GOALS.length;

export function foodForFish(weight: number): number {
  const { FISH_FOOD_AT_MEDIAN, FISH_FOOD_MEDIAN_LB, FISH_FOOD_MIN, FISH_FOOD_MAX } = PET_CONFIG;
  const food = Math.round(FISH_FOOD_AT_MEDIAN * Math.sqrt(Math.max(0, weight) / FISH_FOOD_MEDIAN_LB));
  return Math.min(FISH_FOOD_MAX, Math.max(FISH_FOOD_MIN, food));
}

// The emoji on the card's feed line ("🌮 Galen fed Gregory."), one picked per feed. Deliberately not pet
// food — an implication, not a statement. 🍆 and 🍑 left out on purpose.
export const PET_FOODS = [
  "🌮", "🌭", "🍕", "🍔", "🍟", "🍣", "🍜", "🍝", "🥗", "🌯", "🥨", "🧀", "🥐", "🍩", "🍪", "🎂", "🍰", "🧁",
  "🍫", "🍿", "🥞", "🧇", "🥓", "🍤", "🥟", "🍙", "🌶️", "🥑", "🍋", "🥦", "🌽", "🥕", "🧄", "🧅", "🥥", "🍍",
  "🍉", "🍦", "🍭", "🥫", "🍱", "🥧", "🧈", "🍳", "🥪", "🍞", "🧃", "☕",
];

// What 🎾 Play can turn into. Playing mostly burns food for mood, so even a pet at 100/100 always has
// something worth doing — and then needs feeding again. weight is relative; food/mood are the changes.
// A bite and learning a trick are posted publicly (see pet.ts). "learned" picks up a new PET_TRICKS
// entry (skipped once it knows them all); "trick" shows off one it already knows (skipped until it
// knows one) — whichever is skipped, the rest share its odds.
export type PlayOutcome = "zoomies" | "fetch" | "bored" | "bit" | "learned" | "trick";
export const PLAY_OUTCOMES: { kind: PlayOutcome; weight: number; food: number; mood: number }[] = [
  { kind: "zoomies", weight: 30, food: -15, mood: 15 },
  { kind: "fetch", weight: 30, food: -10, mood: 10 },
  { kind: "bored", weight: 15, food: 0, mood: -5 },
  { kind: "bit", weight: 10, food: 0, mood: -10 },
  { kind: "learned", weight: 5, food: 0, mood: 20 },
  { kind: "trick", weight: 10, food: -5, mood: 10 },
];

export function rollPlayOutcome(
  can: { learn: boolean; showOff: boolean },
  random: () => number = Math.random
): (typeof PLAY_OUTCOMES)[number] {
  const options = PLAY_OUTCOMES.filter((o) => (o.kind !== "learned" || can.learn) && (o.kind !== "trick" || can.showOff));
  return weightedPick(options, random);
}

// The one trick that can kill: each time the pet performs it, this is the chance (0-1) it crashes.
export const CAR_TRICK = "drive a car";
export const CAR_CRASH_CHANCE = 0.33;
// A pet that learned to parallel park before it learned to drive botches it every time it tries: a
// collision, a lawsuit, and this much mood instead of the trick's usual change.
export const PARK_TRICK = "parallel park";
export const PARKING_LAWSUIT_MOOD = -90;

// Tricks a pet can learn through Play. name is announced as "Galen taught Gregory a new trick: ___!"
// (capitalized); line is how it's described
// when performed, with {pet}, {person}, and {person's} filled in — {person} becomes "you" in the
// tapper's own pop-up, so never start a sentence with it. Add freely; never rename one a pet may know.
export const PET_TRICKS: { name: string; line: string }[] = [
  { name: "sit", line: "{pet} sat for {person}." },
  { name: "high five", line: "{pet} high-fived {person}." },
  { name: "shake hands", line: "{pet} shook {person's} hand." },
  { name: "roll over", line: "{pet} rolled over for {person}." },
  { name: "play dead", line: "{pet} played dead and {person} panicked." },
  { name: "speak", line: "{pet} said \"hello\" to {person}." },
  { name: "moonwalk", line: "{pet} moonwalked past {person}." },
  { name: "do a backflip", line: "{pet} did a backflip and {person} clapped." },
  { name: "do the worm", line: "{pet} did the worm for {person}." },
  { name: "beatbox", line: "{pet} beatboxed for {person}." },
  { name: "juggle", line: "{pet} juggled three eggs for {person}." },
  { name: "make toast", line: "{pet} made {person} toast. Slightly burnt." },
  { name: "fold laundry", line: "{pet} folded {person's} laundry." },
  { name: PARK_TRICK, line: "{pet} parallel parked {person's} car." },
  { name: "file taxes", line: "{pet} filed {person's} taxes." },
  { name: "apologize", line: "{pet} apologized to {person}. It didn't mean it." },
  // Performing this one can kill the pet (CAR_CRASH_CHANCE); the line is how it goes when it doesn't.
  { name: CAR_TRICK, line: "{pet} drove {person} to the store and back. Nobody died this time." },
];

export type PetRarity = "common" | "rare" | "ultra";

// Rolled at adoption. weight is relative: commons 10 each, rares 2, ultras 0.5 — about 95% / 5% / 1%.
export const PET_SPECIES: { species: string; emoji: string; rarity: PetRarity; weight: number }[] = [
  { species: "dog", emoji: "🐕", rarity: "common", weight: 10 },
  { species: "cat", emoji: "🐈", rarity: "common", weight: 10 },
  { species: "hamster", emoji: "🐹", rarity: "common", weight: 8 },
  { species: "goldfish", emoji: "🐠", rarity: "common", weight: 8 },
  { species: "raccoon", emoji: "🦝", rarity: "common", weight: 6 },
  { species: "goose", emoji: "🪿", rarity: "common", weight: 6 },
  { species: "frog", emoji: "🐸", rarity: "common", weight: 6 },
  { species: "rabbit", emoji: "🐇", rarity: "common", weight: 8 },
  { species: "pig", emoji: "🐖", rarity: "common", weight: 8 },
  { species: "turtle", emoji: "🐢", rarity: "common", weight: 6 },
  { species: "parrot", emoji: "🦜", rarity: "common", weight: 8 },
  { species: "hedgehog", emoji: "🦔", rarity: "common", weight: 6 },
  { species: "sloth", emoji: "🦥", rarity: "rare", weight: 3 },
  { species: "otter", emoji: "🦦", rarity: "rare", weight: 3 },
  { species: "flamingo", emoji: "🦩", rarity: "rare", weight: 3 },
  { species: "dragon", emoji: "🐉", rarity: "ultra", weight: 0.8 },
  { species: "unicorn", emoji: "🦄", rarity: "ultra", weight: 1.0 },
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
