// Simulates /fish with the real math in src/fishing-math.ts (Node 24+ runs the .ts import directly), prints
// the odds tables, and checks them against the tuning targets. Run after changing FISHING_CONFIG, the tide
// multipliers, the pet's fish food, the store's prices, gear, or bottles: `npm run sim:fishing`. Exits non-zero if a target is missed.
import { FISHING_CONFIG, TIDE_CHART, bestCastDay, castFactors, junkChance, lakeTier, rollCatch, rollWeight, rotatingLine, speciesForWeight, speciesTier, tideFor, tideForecast } from "../src/fishing-math.ts";
import { STORE_CONFIG, fishPriceIndex, fishPricePerLb, fishSalePrice } from "../src/store-math.ts";
import { GEAR_LINES, castGear } from "../src/gear.ts";
import { HIGH_TIDE_LINES, HINT_LINES, JUNK_LINES, LAKE_LINES } from "../src/fishing-lines.ts";
import { PET_CONFIG, foodForFish } from "../src/pet-config.ts";
import { BOTTLE_CONFIG, BOTTLE_DISTANCES, LITTER_LINES, cleanBottleText, washUpTime } from "../src/bottles.ts";

const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(p * (sorted.length - 1))];
};
// Tides come in streaks in the real thing (see tideFor), but the split is the same.
const randomTide = () => {
  const r = Math.random();
  return r < 0.25 ? "low" : r < 0.75 ? "normal" : r < 0.95 ? "high" : "king";
};
const TOP_GEAR = castGear({ rod: GEAR_LINES.rod.tiers.length - 1, boat: GEAR_LINES.boat.tiers.length - 1, worms: 1 }, true);
const cast = (daysWaited, tide, castsToday, gear) => {
  const { quality } = castFactors({ daysWaited, tide, castsToday, gear });
  return Math.random() < junkChance(quality, gear?.junk) ? null : rollCatch(quality, gear?.rolls);
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
  ["4+ days, 3rd cast, top gear", 4, "normal", 2, TOP_GEAR],
  ["4+ days, 8th cast, top gear", 4, "normal", 7, TOP_GEAR],
];
const medians = {};
for (const [label, days, tide, n, gear] of rows) {
  const { quality } = castFactors({ daysWaited: days, tide, castsToday: n, gear });
  const weights = Array.from({ length: 100_000 }, () => rollCatch(quality, gear?.rolls));
  medians[label] = pct(weights, 0.5);
  console.log(
    `  ${label.padEnd(30)} ${quality.toFixed(2)}  ${(junkChance(quality, gear?.junk) * 100).toFixed(0).padStart(3)}%  ${pct(weights, 0.5).toFixed(1).padStart(6)}  ${pct(weights, 0.9).toFixed(1).padStart(8)}  ${pct(weights, 0.99).toFixed(1).padStart(8)}`
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

// The store: species rarity, the daily fish price, and what fish sell for.
const normal = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const window = Array.from({ length: STORE_CONFIG.PRICE_WINDOW_DAYS }, normal);
const indexes = [];
const prices = [];
const moves = [];
for (let day = 0; day < 200_000; day++) {
  window.shift();
  window.push(normal());
  const index = fishPriceIndex(window);
  indexes.push(index);
  const perLb = fishPricePerLb(index);
  if (prices.length > 0) moves.push(Math.abs(perLb / prices[prices.length - 1] - 1));
  prices.push(perLb);
}
console.log(`\nStore: fish price per lb (base ${STORE_CONFIG.FISH_BASE_PER_LB})`);
console.log(`  5% / median / 95%: ${pct(prices, 0.05)} / ${pct(prices, 0.5)} / ${pct(prices, 0.95)}; typical day-to-day move ${(pct(moves, 0.5) * 100).toFixed(0)}%`);

// Fish from the chat-like rhythm above (one cast each, at the median lake position), at a typical price.
const tiers = { common: 0, rare: 0, legendary: 0 };
const bySpecies = {};
const sales = [];
for (let n = 0; n < 1_000_000; n++) {
  const weight = cast([1, 1, 2, 3, 5][n % 5], randomTide(), n % 3);
  if (weight === null) continue;
  const { species } = speciesForWeight(weight);
  const tier = speciesTier(species);
  tiers[tier]++;
  bySpecies[species] = (bySpecies[species] ?? 0) + 1;
  sales.push(fishSalePrice(weight, tier, fishPricePerLb(1)));
}
const fishCount = tiers.common + tiers.rare + tiers.legendary;
const oneIn = (count) => (count ? `1 in ${Math.round(fishCount / count).toLocaleString("en-US")}` : "never");
const meanSale = sales.reduce((a, b) => a + b, 0) / sales.length;
const specials = Object.keys(bySpecies)
  .filter((name) => speciesTier(name) !== "common")
  .sort((a, b) => bySpecies[b] - bySpecies[a]);
console.log(`  rare ${((tiers.rare / fishCount) * 100).toFixed(1)}% of fish; ${specials.map((name) => `${name} ${oneIn(bySpecies[name])}`).join(", ")}`);
const megalodonYears = fishCount / (bySpecies.megalodon ?? 0) / pct(fishPerDay, 0.5) / 365;
console.log(`  our chat lands a megalodon about every ${megalodonYears.toFixed(1)} years`);
console.log(`  a fish sells for (on a typical day): median ${pct(sales, 0.5)}, 1 in 10 ${pct(sales, 0.9)}, 1 in 100 ${pct(sales, 0.99)}, mean ${meanSale.toFixed(1)}`);
console.log(`  our chat earns about ${(meanSale * pct(fishPerDay, 0.5)).toFixed(0)} beans a day if it sells everything`);
console.log(`  biggest sales (1 in 1,000 fish): ${pct(sales, 0.999)} beans`);
for (const [line, { tiers }] of Object.entries(GEAR_LINES)) {
  console.log(`  ${line}: ${tiers.slice(1).map((t) => `${t.name} ${t.price} (~${Math.round(t.price / meanSale)} fish)`).join(", ")}`);
}

// The same chat a year in, if everyone owns the top rod and boat and always has a worm.
const geared365 = [];
for (let run = 0; run < 1000; run++) {
  let record = OLD_RECORD;
  const offsets = rhythms.map((r) => Math.floor(Math.random() * r));
  for (let day = 0; day < 365; day++) {
    const tide = randomTide();
    rhythms
      .filter((r, i) => day >= offsets[i] && (day - offsets[i]) % r === 0)
      .forEach((every, n) => {
        const weight = cast(every, tide, n, TOP_GEAR);
        if (weight !== null) record = Math.max(record, weight);
      });
  }
  geared365.push(record);
}
console.log(`  with everyone on top gear, the chat record after a year: ${pct(geared365, 0.5).toFixed(0)} lb`);

console.log("\nTargets");
check(medians["daily, 1st cast"] >= 8, `a daily caster's typical fish is at least 8 lb (${medians["daily, 1st cast"]})`);
check(medians["daily, low tide, fished out"] >= 3, `the worst possible cast still has a typical fish of 3+ lb (${medians["daily, low tide, fished out"]})`);
check(junkChance(FISHING_CONFIG.Q_FLOOR) <= 0.3, `junk never tops 30% (${(junkChance(FISHING_CONFIG.Q_FLOOR) * 100).toFixed(0)}%)`);
const bestRhythm = Object.entries(yearlyBest).sort((a, b) => b[1] - a[1])[0][0];
check(["3", "4", "5"].includes(bestRhythm), `the best yearly trophy comes from a 3-5 day rhythm (${bestRhythm} days)`);
check(yearlyBest[1] < yearlyBest[4], `casting daily isn't the best trophy strategy (${yearlyBest[1]} vs ${yearlyBest[4]} lb)`);
check(pct(daysToBeat, 0.5) <= 10, `the old ${OLD_RECORD} lb record usually falls within 10 days (day ${pct(daysToBeat, 0.5)})`);
check(pct(record365, 0.5) <= 175, `records don't run away: a year in, the record is at most 175 lb (${pct(record365, 0.5).toFixed(0)})`);
check(pct(geared365, 0.5) <= 1.45 * pct(record365, 0.5), `gear helps but doesn't take over: top-gear records stay within 45% of ungeared (${pct(geared365, 0.5).toFixed(0)} vs ${pct(record365, 0.5).toFixed(0)} lb)`);
check(pct(fishPerDay, 0.5) >= 1.5 * (foodPerDay / meanFood), `the chat catches at least 1.5x the fish the pet needs`);
const rareShare = tiers.rare / fishCount;
check(rareShare >= 0.08 && rareShare <= 0.12, `about 1 fish in 10 is rare (${(rareShare * 100).toFixed(1)}%)`);
check(specials[specials.length - 1] === "megalodon", `the megalodon is the rarest rare-or-legendary fish (${specials[specials.length - 1]})`);
check(megalodonYears <= 3, `our chat still lands a megalodon within 3 years (${megalodonYears.toFixed(1)})`);
const beansPerDay = meanSale * pct(fishPerDay, 0.5);
check(beansPerDay >= 15 && beansPerDay <= 25, `our chat earns about 20 beans a day selling everything (${beansPerDay.toFixed(0)})`);
check(pct(indexes, 0.05) >= 0.3 && pct(indexes, 0.95) <= 3, `fish prices stay between 0.3x and 3x base 90% of the time (${pct(indexes, 0.05).toFixed(2)}x-${pct(indexes, 0.95).toFixed(2)}x)`);
check(pct(moves, 0.5) >= 0.2 && pct(moves, 0.5) <= 0.5, `the market is lively: the typical day-to-day move is 20-50% (${(pct(moves, 0.5) * 100).toFixed(0)}%)`);
check(pct(moves, 0.9) >= 0.75, `about 1 day in 10 is a boom or crash: the 90th-percentile move is 75%+ (${(pct(moves, 0.9) * 100).toFixed(0)}%)`);

// Flavor-line rotation (fishing-lines.ts): over a busy day, the lake line never repeats until the day has
// been through every tier's whole set, and the order changes from day to day.
const allSets = { ...Object.fromEntries(Object.entries(LAKE_LINES).map(([k, v]) => [`lake:${k}`, v])), ...Object.fromEntries(Object.entries(HINT_LINES).map(([k, v]) => [`hint:${k}`, v])), tide: HIGH_TIDE_LINES, junk: JUNK_LINES };
let permutationsOk = true;
let ordersVary = false;
for (const [set, lines] of Object.entries(allSets)) {
  for (let day = 0; day < 50; day++) {
    const picked = lines.map((_, step) => rotatingLine(lines, `-100:day${day}:${set}`, step));
    if (new Set(picked).size !== lines.length) permutationsOk = false;
    if (day > 0 && picked[0] !== rotatingLine(lines, `-100:day0:${set}`, 0)) ordersVary = true;
  }
}
check(permutationsOk, `every line set rotates through all its lines before repeating`);
check(ordersVary, `the rotation order changes from day to day`);
let lakeRepeats = 0;
for (let day = 0; day < 200; day++) {
  const seen = new Set();
  for (let n = 0; n < 9 + LAKE_LINES.fished_out.length; n++) {
    const tier = lakeTier(n);
    const line = rotatingLine(LAKE_LINES[tier], `-100:day${day}:lake:${tier}`, n);
    if (seen.has(line)) lakeRepeats++;
    seen.add(line);
  }
}
check(lakeRepeats === 0, `no lake line repeats within a day, even ${9 + LAKE_LINES.fished_out.length} casts in (${lakeRepeats} repeats)`);

// Message in a bottle (bottles.ts), in the same chat as above: once a bottle washes up, how long it bobs around
// before someone's /fish reels it in. Each angler casts at a random time on their days, and one of them wrote it,
// so their casts can't find it. One bottle at a time; more out at once would each wait a bit longer.
const bottleWaits = [];
for (let run = 0; run < 20_000; run++) {
  const offsets = rhythms.map((r) => Math.floor(Math.random() * r));
  const author = Math.floor(Math.random() * rhythms.length);
  const washUp = 24 * (100 + Math.random() * 30); // hours, any time of day
  let wait = Infinity;
  for (let day = Math.floor(washUp / 24); wait === Infinity && day < washUp / 24 + 365; day++) {
    const casts = rhythms
      .map((every, i) => ({ i, every, at: (day + Math.random()) * 24 }))
      .filter(({ i, every, at }) => i !== author && (day - offsets[i]) % every === 0 && at >= washUp)
      .sort((a, b) => a.at - b.at);
    const catcher = casts.find(() => Math.random() < BOTTLE_CONFIG.CATCH_CHANCE);
    if (catcher) wait = catcher.at - washUp;
  }
  bottleWaits.push(wait);
}
console.log(`\nMessage in a bottle (${(BOTTLE_CONFIG.CATCH_CHANCE * 100).toFixed(0)}% a cast, our chat)`);
console.log(`  a washed-up bottle is found in: median ${pct(bottleWaits, 0.5).toFixed(0)} h, 90% within ${pct(bottleWaits, 0.9).toFixed(0)} h`);
for (const [distance, { minHours, maxHours }] of Object.entries(BOTTLE_DISTANCES)) {
  const total = Array.from({ length: 2000 }, () => (washUpTime(distance, 0) + 3600 * pct(bottleWaits, Math.random())) / 3600);
  console.log(`  ${distance.padEnd(5)} (${minHours}-${maxHours} h out): read about ${(pct(total, 0.5) / 24).toFixed(1)} days after it's thrown`);
}

check(pct(bottleWaits, 0.5) <= 24, `a washed-up bottle is usually found within a day (median ${pct(bottleWaits, 0.5).toFixed(0)} h)`);
let washUpsOk = true;
for (const [distance, { minHours, maxHours }] of Object.entries(BOTTLE_DISTANCES)) {
  const thrownAt = 1_700_000_000;
  const draws = [() => 0, () => 0.999_999_999_999, ...Array.from({ length: 100_000 }, () => Math.random)];
  for (const random of draws) {
    const at = washUpTime(distance, thrownAt, random);
    if (!Number.isInteger(at) || at < thrownAt + minHours * 3600 || at > thrownAt + maxHours * 3600) washUpsOk = false;
  }
}
check(washUpsOk, `washUpTime always lands inside its distance's range, on a whole second`);
const cleaned = (raw) => {
  const result = cleanBottleText(raw);
  return result.ok ? result.text : result.reason;
};
check(
  cleaned("  hi\r\nthere\u0007  ") === "hi\nthere" &&
    cleaned("a\n\n\n\n\nb") === "a\n\nb" &&
    cleaned(" \n\t ") === "EMPTY" &&
    cleaned("x".repeat(BOTTLE_CONFIG.MAX_CHARS)) === "x".repeat(BOTTLE_CONFIG.MAX_CHARS) &&
    cleaned("x".repeat(BOTTLE_CONFIG.MAX_CHARS + 1)) === "TOO_LONG" &&
    cleaned("1\n2\n3") === "1\n2\n3" &&
    cleaned("1\n2\n3\n4") === "TOO_MANY_LINES",
  `cleanBottleText trims, normalizes, and enforces ${BOTTLE_CONFIG.MAX_CHARS} characters and ${BOTTLE_CONFIG.MAX_LINES} lines`
);
check(LITTER_LINES.length >= 4, `at least 4 littering quips (${LITTER_LINES.length})`);

// The tide chart (tideForecast): the first EXACT_DAYS are the real tides, and later days are right about as often as
// PREDICTED_ACCURACY says, missing by one step otherwise. Over 300 chats x 200 viewing days: 60,000 forecasts per day.
const CHART_SECRET = "sim-tide-secret";
const TIDE_ORDER = ["low", "normal", "high", "king"];
const chartHits = TIDE_CHART.PREDICTED_ACCURACY.map(() => 0);
let chartViews = 0;
let exactOk = true;
let missesAdjacent = true;
let stable = true;
let bestOk = true;
for (let chat = 0; chat < 300; chat++) {
  const chatId = -1_000_000_000_000 - chat * 7919;
  for (let today = 20_000; today < 20_200; today++) {
    const forecast = tideForecast(CHART_SECRET, chatId, today);
    chartViews++;
    forecast.forEach((day, i) => {
      const truth = tideFor(CHART_SECRET, chatId, today + i);
      if (day.dayNumber !== today + i) exactOk = false;
      if (i < TIDE_CHART.EXACT_DAYS) {
        if (!day.exact || day.tide !== truth) exactOk = false;
        return;
      }
      if (day.exact) exactOk = false;
      if (day.tide === truth) chartHits[i - TIDE_CHART.EXACT_DAYS]++;
      else if (Math.abs(TIDE_ORDER.indexOf(day.tide) - TIDE_ORDER.indexOf(truth)) !== 1) missesAdjacent = false;
    });
    if (forecast.length !== TIDE_CHART.DAYS) exactOk = false;
    if (chat < 30 && JSON.stringify(tideForecast(CHART_SECRET, chatId, today)) !== JSON.stringify(forecast)) stable = false;
    if (bestCastDay(forecast, 0) === 0) bestOk = false;
  }
}
const noSecret = tideForecast(undefined, -42, 20_000);
const hitRates = chartHits.map((hits) => hits / chartViews);
console.log(`\nTide chart (${chartViews.toLocaleString("en-US")} forecasts)`);
console.log(`  predicted days 4-7 right: ${hitRates.map((rate) => `${(rate * 100).toFixed(1)}%`).join(" / ")}`);
check(
  exactOk && noSecret.every((day) => day.tide === "normal" && day.exact),
  `the chart's first ${TIDE_CHART.EXACT_DAYS} days always equal tideFor (and every day is normal without a secret)`
);
check(
  missesAdjacent && hitRates.every((rate, i) => Math.abs(rate - TIDE_CHART.PREDICTED_ACCURACY[i]) <= 0.03),
  `predicted days are right within 3 points of ${TIDE_CHART.PREDICTED_ACCURACY.map((a) => `${a * 100}%`).join(" / ")}, and miss by one step`
);
check(stable, `the forecast for a day is the same on every call that viewing day`);
check(
  bestOk && bestCastDay([{ dayNumber: 0, tide: "king", exact: true }], 0) === null,
  `bestCastDay never picks today after a cast today`
);

if (failures.length > 0) {
  console.log(`\n${failures.length} target(s) missed.`);
  process.exit(1);
}
