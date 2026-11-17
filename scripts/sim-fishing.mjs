// Simulates /fish with the real math in src/fishing-math.ts (Node 24+ runs the .ts import directly), prints
// the odds tables, and checks them against the tuning targets. Run after changing FISHING_CONFIG, the tide
// multipliers, or the pet's fish food: `npm run sim:fishing`. Exits non-zero if a target is missed.
import { FISHING_CONFIG, castFactors, junkChance, rollWeight } from "../src/fishing-math.ts";
import { PET_CONFIG, foodForFish } from "../src/pet-config.ts";

const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(p * (sorted.length - 1))];
};
// Tides come in streaks in the real thing (see tideFor), but the split is the same.
const randomTide = () => {
  const r = Math.random();
  return r < 0.25 ? "low" : r < 0.75 ? "normal" : r < 0.95 ? "high" : "king";
};
const cast = (daysWaited, tide, castsToday) => {
  const { quality } = castFactors({ daysWaited, tide, castsToday });
  return Math.random() < junkChance(quality) ? null : rollWeight(quality);
};

const failures = [];
const check = (ok, label) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
};

console.log("Per cast                         q     junk  median   1 in 10  1 in 100");
const rows = [
  ["daily, 1st cast", 1, "normal", 0],
  ["daily, 3rd cast", 1, "normal", 2],
  ["2 days, 3rd cast", 2, "normal", 2],
  ["4+ days, 3rd cast", 4, "normal", 2],
  ["4+ days, 1st cast", 4, "normal", 0],
  ["4+ days, 8th cast", 4, "normal", 7],
  ["4+ days, 8th cast, low tide", 4, "low", 7],
  ["daily, low tide, fished out", 1, "low", 12],
  ["4+ days, 1st cast, king tide", 4, "king", 0],
];
const medians = {};
for (const [label, days, tide, n] of rows) {
  const { quality } = castFactors({ daysWaited: days, tide, castsToday: n });
  const weights = Array.from({ length: 100_000 }, () => rollWeight(quality));
  medians[label] = pct(weights, 0.5);
  console.log(
    `  ${label.padEnd(30)} ${quality.toFixed(2)}  ${(junkChance(quality) * 100).toFixed(0).padStart(3)}%  ${pct(weights, 0.5).toFixed(1).padStart(6)}  ${pct(weights, 0.9).toFixed(1).padStart(8)}  ${pct(weights, 0.99).toFixed(1).padStart(8)}`
  );
}

// One angler on a fixed rhythm for a year, in a lake where ~5 others cast a day, in random order.
console.log("\nOne angler for a year (5 others a day)   fish   typical best of year");
const yearlyBest = {};
for (const every of [1, 2, 3, 4, 5, 7, 14]) {
  const bests = [];
  const counts = [];
  for (let run = 0; run < 2000; run++) {
    let best = 0;
    let count = 0;
    for (let day = 0; day < 365; day += every) {
      const weight = cast(day === 0 ? FISHING_CONFIG.FIRST_CAST_WAIT_DAYS : every, randomTide(), Math.floor(Math.random() * 6));
      if (weight !== null) {
        count++;
        best = Math.max(best, weight);
      }
    }
    bests.push(best);
    counts.push(count);
  }
  yearlyBest[every] = pct(bests, 0.5);
  console.log(`  every ${String(every).padStart(2)} days                          ${String(pct(counts, 0.5)).padStart(4)}   ${pct(bests, 0.5).toFixed(1)} lb`);
}

// A chat like ours: five anglers casting every 1, 1, 2, 3, and 5 days (~3 casts a day), against the
// leaderboard as it stood when this math shipped (best: 37 lb).
const OLD_RECORD = 37;
const rhythms = [1, 1, 2, 3, 5];
const daysToBeat = [];
const record30 = [];
const record365 = [];
const fishPerDay = [];
const foods = [];
for (let run = 0; run < 2000; run++) {
  let record = OLD_RECORD;
  let beatOn = null;
  let fish = 0;
  const offsets = rhythms.map((r) => Math.floor(Math.random() * r));
  for (let day = 0; day < 365; day++) {
    const tide = randomTide();
    const casters = rhythms
      .filter((r, i) => day >= offsets[i] && (day - offsets[i]) % r === 0)
      .sort(() => Math.random() - 0.5);
    casters.forEach((every, n) => {
      const weight = cast(every, tide, n);
      if (weight === null) return;
      fish++;
      if (run < 200) foods.push(foodForFish(weight));
      if (weight > record) {
        record = weight;
        beatOn ??= day + 1;
      }
    });
    if (day === 29) record30.push(record);
  }
  daysToBeat.push(beatOn ?? 999);
  record365.push(record);
  fishPerDay.push(fish / 365);
}
const meanFood = foods.reduce((a, b) => a + b, 0) / foods.length;
const foodPerDay = (100 / PET_CONFIG.HOURS_TO_STARVE) * 24;
console.log(`\nOur chat (~3 casts a day)`);
console.log(`  the ${OLD_RECORD} lb record falls on day ${pct(daysToBeat, 0.5)} (90% of chats by day ${pct(daysToBeat, 0.9)})`);
console.log(`  chat record after 30 days: ${pct(record30, 0.5).toFixed(0)} lb, after a year: ${pct(record365, 0.5).toFixed(0)} lb`);
console.log(`  ${pct(fishPerDay, 0.5).toFixed(2)} fish a day; a fish averages ${meanFood.toFixed(1)} food, the pet burns ${foodPerDay.toFixed(1)} a day`);
console.log(`  -> the pet needs ${(foodPerDay / meanFood).toFixed(2)} fish a day`);

console.log("\nTargets");
check(medians["daily, 1st cast"] >= 8, `a daily caster's typical fish is at least 8 lb (${medians["daily, 1st cast"]})`);
check(medians["daily, low tide, fished out"] >= 3, `the worst possible cast still has a typical fish of 3+ lb (${medians["daily, low tide, fished out"]})`);
check(junkChance(FISHING_CONFIG.Q_FLOOR) <= 0.3, `junk never tops 30% (${(junkChance(FISHING_CONFIG.Q_FLOOR) * 100).toFixed(0)}%)`);
const bestRhythm = Object.entries(yearlyBest).sort((a, b) => b[1] - a[1])[0][0];
check(["3", "4", "5"].includes(bestRhythm), `the best yearly trophy comes from a 3-5 day rhythm (${bestRhythm} days)`);
check(yearlyBest[1] < yearlyBest[4], `casting daily isn't the best trophy strategy (${yearlyBest[1]} vs ${yearlyBest[4]} lb)`);
check(pct(daysToBeat, 0.5) <= 10, `the old ${OLD_RECORD} lb record usually falls within 10 days (day ${pct(daysToBeat, 0.5)})`);
check(pct(record365, 0.5) <= 175, `records don't run away: a year in, the record is at most 175 lb (${pct(record365, 0.5).toFixed(0)})`);
check(pct(fishPerDay, 0.5) >= 1.5 * (foodPerDay / meanFood), `the chat catches at least 1.5x the fish the pet needs`);

if (failures.length > 0) {
  console.log(`\n${failures.length} target(s) missed.`);
  process.exit(1);
}
