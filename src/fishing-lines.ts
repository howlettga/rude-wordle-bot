// Every flavor line a /fish reply can carry. They're meant to hint at the hidden mechanics (see
// fishing-math.ts) without ever naming them: how busy the shared lake is, that you cast too recently, what
// the tide is doing. Add or cut freely; each set just needs at least one line.
//
// Rotation (see rotatingLine): every chat gets its own shuffled order of each set every day, and the day's
// casts walk through it one by one, so a line doesn't repeat within a day until its set runs out, and
// mornings don't always open the same way. Nothing is stored for it.
import type { CatchHint, LakeTier } from "./fishing-math.js";

// One on every cast, by how many casts the chat has already made today (see lakeTier).
export const LAKE_LINES: Record<LakeTier, string[]> = {
  fresh: [
    "The water's so still it's a little unsettling.",
    "No footprints on the dock. Just yours.",
    "The fish haven't had their coffee yet.",
    "Untouched water. Nobody's ruined it yet.",
    "A heron nods at you. Professional courtesy.",
    "Not even the regulars are up.",
    "The lake doesn't know your name yet.",
    "You're the first one here. The lake seems almost happy to see you.",
  ],
  calm: [
    "Someone left a thermos on the dock. Still warm.",
    "There's a fresh hook in the dock post. Not yours.",
    "You hear a cooler lid shut somewhere across the water.",
    "Somebody's lawn chair is still warm.",
    "A boat wake rocks the dock. Polite company.",
    "The fish have seen a lure or two today. They're still curious.",
    "Fresh bait wrapper on the dock. You're not first.",
    "A ripple or two. Somebody beat you here.",
  ],
  busy: [
    "The dock is starting to smell like other people's sandwiches.",
    "Somebody's speaker is playing Margaritaville. The fish have opinions.",
    "There's a line forming at the bait shop.",
    "The fish are holding a meeting about you people.",
    "Too many hooks in the water. The fish are reading the reviews.",
    "The guy next to you won't stop talking about crypto.",
    "A fish surfaces, looks around at all of you, and leaves.",
    "The parking lot is full.",
  ],
  crowded: [
    "You cast and hooked someone else's line.",
    "There's a guy in waders standing exactly where you wanted to be.",
    "The fish have unionized.",
    "You can hear the fish laughing.",
    "Every fish in here already has a lip piercing from earlier today.",
    "The lake has the energy of a Costco on a Saturday.",
    "Someone's dog is swimming through your spot.",
    "You could walk across this lake on the fishing lines.",
  ],
  fished_out: [
    "The lake is mostly hooks now.",
    "A single minnow is hiding behind a rock, refusing to make eye contact.",
    "You're pretty sure that splash was a tear.",
    "The fish have filed a restraining order against the entire chat.",
    "The lake has gone to its happy place. You're not invited.",
    "There's nothing left in here but trauma and one boot.",
    "Even the seaweed looks tired.",
    "Come back tomorrow. The lake needs to sleep this off.",
  ],
};

// On a poor catch, what dragged it down (see hintFor). "spot" is the angler casting too often; the lake
// lines above are everyone's.
export const HINT_LINES: Record<CatchHint, string[]> = {
  spot: [
    "The fish here remember your face.",
    "That spot is still recovering from your last visit.",
    "The fish here have a group chat now. You're the main topic.",
    "Someone left a note in the water: \"not you again.\"",
    "The one that got away last time told everyone.",
    "Your spot needs some space. It's not you. It's definitely you.",
    "Your usual fish called in sick.",
    "You're loving this spot to death.",
  ],
  low_tide: [
    "The water's lower than your standards.",
    "You can see the bottom. The bottom can see you.",
    "The dock is a lot taller than usual today.",
    "Half the lake went somewhere. The fish went with it.",
    "The moon is not on your side today.",
    "Barnacles you've never seen before are out sunbathing.",
    "The water pulled back like it's avoiding you.",
    "The fish are deep today, and they're not coming up for you.",
  ],
};

// High (or king) tide. The 🌊 is the one consistent tell; king tides read the same, so they stay a surprise.
export const HIGH_TIDE_LINES = [
  "🌊 The water's up to the second step on the dock.",
  "🌊 The moon owes you one today.",
  "🌊 The lake is feeling generous. Don't make it weird.",
  "🌊 The tide came in like it had somewhere to be.",
  "🌊 The dock is wet in places it's never been wet.",
  "🌊 Big water today.",
];

// Under "You reeled in ___!" when the catch is junk.
export const JUNK_LINES = [
  "Worthless.",
  "Nobody wants this. Not even the lake.",
  "The lake thanks you for taking that off its hands.",
  "One fish's trash is still trash.",
  "Do not show this to the pet.",
  "You've been robbed, somehow.",
];
