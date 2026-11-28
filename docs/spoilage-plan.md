# Fish spoilage and the cooler: execution plan

Fish in a bucket go off: fresh for 2 days, then ripe (worth less every day), then rotten at 6 days. A new 🧊 cooler gear line slows that down, and its top tier stops it. People hold fish to wait for a good market price (the price swings about 37% on a typical day), so coolers are what let them hold longer. Rotten fish sell for 🫘1 and make the pet sick. Spoilage starts on a configured date, so the code can ship early and the owner can warn the chat first.

This is the brief for each implementation worker. Read **Context**, **Game rules**, **Rules for every worker**, and **Contracts** in full, then do only your own work package.

## Context

- **Repo:** a grammY Telegram bot on one Cloudflare Worker, with per-chat SQLite Durable Objects. Background: `docs/store-mini-app-plan.md` (the store page and API) and `docs/tide-chart-plan.md` (the latest store feature, same patterns).
- **Fish** live in the Fishing DO (`src/durable-objects/fishing.ts`): the `catches` table has `caught_at` (SQLite datetime, UTC), `owner_id`, and `status` (`held` / `eaten` / `sold`). `takeFish` / `takeFishById` take a fish out, `returnFish` puts it back, and `bucket()` lists held fish (with `daysHeld`).
- **Prices** live in the Store DO (`src/durable-objects/store.ts`): `fishSalePrice(weight, tier, perLb)` (`src/store-math.ts`), and `quoteFishes` / `sellFish`. Gear (rod, boat, worms, `chart_until`) lives in the Store DO's `gear` table. Its tiers are defined in `src/gear.ts` (`GEAR_LINES`).
- **The pet** (`src/durable-objects/pet.ts`, `src/pet.ts`): feeding takes a fish from the feeder's bucket (`takeFish(..., "eaten")`), then calls `interact` with `feedAmount = foodForFish(weight)` (`src/pet-config.ts`), and refunds the fish if the feed didn't happen. Overfeeding (`kind: "overfed"`) is an existing public outcome to model the sick outcome on.
- **Selling paths:** the store page (`POST /app/api/sell`), the card's Sell a fish (`StoreComposer.sellFromCard`), and the Sell button on `/fish` replies (`StoreComposer.sellCaught`). All of them go through the Store DO's `sellFish`.

## Game rules

| Rule | Value |
|---|---|
| Start date | `SPOILAGE.STARTS_AT` (ISO date, Eastern midnight, e.g. `"2026-12-05"`). Before it, nothing spoils. From it, a fish's age counts from the **later** of its catch and the start date |
| Freshness | By *spoil age* (below): under 2 days **fresh** (full value). 2 to 6 days **ripe**, where value drops linearly from 100% at 2 days to 25% at 6 days. 6 days and up **rotten** |
| Cooler line | 🪣 Bucket (free, spoils at 1×), 🧊 Cooler 🫘25 (½×), ❄️ Ice chest 🫘100 (¼×), 🥶 Deep freezer 🫘300 (never). Bought one tier at a time like rods and boats |
| Spoil age | Real time held, weighted by the cooler tier you had at each moment, **from purchase onward**: a new cooler slows spoilage from then on and never refreshes fish already aging. Computed from the angler's cooler purchase times |
| Selling | Sale price × freshness value (fresh 1, ripe 1→0.25). A rotten fish sells for 🫘1 ("the bait shop takes it") |
| The pet | A fresh fish feeds `foodForFish(weight)`. A ripe one feeds that × its freshness value. A rotten one feeds nothing and **hurts its health**: food −15 and mood −5, a public "🤢" line ("Bluey ate Galen's rotten bass and threw up."), and it still uses the feeder's cooldown |
| Shown to players | In the store page, each bucket row gets a state mark (🟢 fresh / 🟡 ripe / 🤢 rotten). Its quote already reflects its value. No numbers or rates. Before the start date, the page shows "🧊 Fish start spoiling on Fri, Dec 5." and no marks |
| Hints | The existing freshness lines in sale pop-ups and the "been in there a while" bucket note stay. Once spoilage is live, the bucket note shows when any fish is ripe or rotten |
| Leaderboard | Untouched: spoilage only changes what a held fish is worth |

## Rules for every worker

- Touch **only the files your package owns**. If you need a change elsewhere, stop and report it.
- Don't commit, push, deploy, set secrets or webhooks, or touch `.dev.vars`, `README.md`, `RELEASE_NOTES.md`, or `TODO.txt`.
- Don't run prettier. Match the surrounding style and comment voice, about 130-character lines.
- TypeScript is strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`); relative imports end in `.js`. Modules the sim loads directly (`src/spoilage.ts`, `src/gear.ts`, `src/store-math.ts`, `src/fishing-math.ts`) keep **no runtime imports**.
- No `await` between a Durable Object's read and the write that depends on it.
- Before reporting run `npx tsc --noEmit -p .`, `npm run test:webapp`, `npm run -s sim:fishing`, and `node --check public/app/app.js`, and fix anything you caused.
- Finish with a short report: files changed, check results, and any deviation from a contract with the reason.

## Contracts

### `src/spoilage.ts` (package S, new, pure)

```ts
export const SPOILAGE = {
  STARTS_AT: "2026-12-05",   // Eastern date; the owner changes this before launch
  FRESH_DAYS: 2,
  ROTTEN_DAYS: 6,
  RIPE_FLOOR: 0.25,          // value at the moment a fish turns rotten
  ROTTEN_SALE: 1,            // beans
} as const;

export type Freshness = "fresh" | "ripe" | "rotten";

// One step in an angler's cooler history: from `at` (epoch seconds) onward, spoilage runs at `rate` (1, 0.5, 0.25, 0).
export interface CoolerSpan { at: number; rate: number }

// The start date as epoch seconds (Eastern midnight); pass in the precomputed value from the caller.
// Spoil age in days: time from max(caughtAt, startsAt) to now, weighted by the cooler rate in effect at each moment.
// history is sorted by `at`; before its first entry the rate is 1. 0 before the start date.
export function spoilAgeDays(caughtAt: number, now: number, startsAt: number, history: CoolerSpan[]): number;

export function freshnessOf(ageDays: number): { state: Freshness; value: number }; // value 1 → RIPE_FLOOR, 0 when rotten
```

The start date's Eastern-midnight epoch is computed by callers with `easternToUtc` from `src/eastern-time.ts`, because `spoilage.ts` has no runtime imports. Package S adds a small helper for that in the Store DO.

### Gear: the cooler line (package S, `src/gear.ts`)

- `GearLine` becomes `"rod" | "boat" | "cooler"`. `GEAR_LINES.cooler` has emoji 🧊, pitch "keeps your catch fresh longer", and tiers:
  - Bucket: 0 beans, effect 1
  - Cooler: 🫘25, effect 0.5
  - Ice chest: 🫘100, effect 0.25
  - Deep freezer: 🫘300, effect 0
- The cooler tier's `effect` is its spoil **rate**.
- `AnglerGear` gains `cooler: number`, and `STARTER_GEAR` gains `cooler: 0`.
- Check every place that switches on `GearLine` or lists lines (the legacy card's gear buttons and pop-ups in `src/store.ts`, `buyGear` / `tapGear`, the API's gear list), so the cooler is buyable in the page. The card only gets new layouts through the page.

### Store Durable Object (package S)

- **Migration:** `gear.cooler INTEGER NOT NULL DEFAULT 0`, plus a `cooler_history (user_id, tier, at)` table, appended to on every cooler purchase. Use the next migration version.
- **Freshness everywhere it prices:** `quoteFishes` and `sellFish` take each fish's `caughtAt` (epoch seconds) and the owner's id, build the owner's `CoolerSpan[]` from `cooler_history` (rate 1 before their first purchase), and apply `freshnessOf(spoilAgeDays(...))`. Rotten fish are priced at `ROTTEN_SALE`.
- **New:** `freshness(userId, caughtAt[]): Promise<{ state: Freshness; value: number }[]>` for the pet's feeding path and the API.
- **Before `STARTS_AT`:** everything is fresh at value 1.

### Fishing Durable Object (package S)

`HeldFish` and `BucketFish` gain `caughtAt: number` (epoch seconds, parsed from `caught_at`, which is UTC). `takeFish`, `takeFishById`, and `bucket` return it.

### `src/storage-service.ts` (package S)

Update the wrappers to the new signatures, and add `getFishFreshness(chatId, userId, caughtAt[])`.

### HTTP API (package S implements, package P consumes)

- `state.bucket[]` items gain `"fresh": "fresh" | "ripe" | "rotten"`, and `quote` already reflects it.
- `state` gains `"spoilage": { "live": boolean, "startsOn": "Fri, Dec 5" | null }`. `startsOn` is set only before the start date.
- The cooler line appears in `state.gear` like rod and boat (its `pitch` included).
- `POST /app/api/buy` accepts `"cooler"`.

### Store card and `/fish` reply (package S, `src/store.ts`)

- The card's random sell, and the `/fish` reply's Sell, use the freshness-adjusted price from `sellFish`.
- When the fish sold was rotten, the pop-up uses a rotten line, picked from a small set in the bot's voice, e.g. "🤢 The shopkeeper gags and gives you 🫘1 for it."
- The legacy card's gear pop-ups handle the cooler line, even though new cards don't show gear buttons.

### The pet (package T)

- `interact` input gains `rotten?: boolean`. A rotten feed is a new `PetAction` `"sick"`: food −15 and mood −5 (both in `PET_CONFIG` as `ROTTEN_FOOD_PENALTY` and `ROTTEN_MOOD_PENALTY`). It counts as a feed for cooldowns and `last_fed_*`, the same way `overfed` does, and the result is `"OK"` with `kind "sick"`.
- **`PetComposer` feeding** (`src/pet.ts`), after taking the fish:
  1. Call `getFishFreshness` for its `caughtAt`.
  2. Rotten: call `interact` with `rotten: true`. Otherwise call it with `feedAmount = round(foodForFish(weight) × value)`, at least 1.
  3. If `getFishFreshness` throws, treat the fish as fresh, so a store problem never blocks feeding.
- **The sick outcome posts publicly**, like overfeeding: a few lines, e.g. "🤢 Bluey ate Galen's rotten bass and threw up." It also gets its card line and its pop-up.
- **Overfed versus sick:** if the pet is already full (overfed) and the fish is also rotten, overfed wins.

### The page (package P)

- **Owns:** `public/app/*`.
- **Bucket rows:** a small state mark before the weight (🟢 / 🟡 / 🤢), only when `spoilage.live`. A rotten fish's row is dimmed but still selectable; its quote is 🫘1.
- **Before launch:** when `spoilage.startsOn` is set, show one quiet line under the bucket: "🧊 Fish start spoiling on Fri, Dec 5." Hide the "been in there a while" note until spoilage is live. After that, show the note when any fish is ripe or rotten.
- **The cooler:** appears in Gear automatically from `state.gear`. Check its row reads well ("🧊 Bucket · Upgrade to Cooler: keeps your catch fresh longer · 🫘25"). Top tier: "Top of the line".
- **Mock mode:** fixture fish in all three states with `spoilage.live` true; `&spoilage=soon` for the pre-launch notice; the cooler in the fixture gear.
- **Rules:** `textContent` only, 🫘 as the currency sign, theme variables, and fits 375px.

## Work packages

- **S: Spoilage, cooler, pricing, API.** Owns `src/spoilage.ts` (new), `src/gear.ts`, `src/durable-objects/store.ts`, `src/durable-objects/fishing.ts`, `src/storage-service.ts`, `src/store.ts`, `src/webapp/api.ts`, `scripts/sim-fishing.mjs`.
  - Add sim checks:
    - `spoilAgeDays` honours the start date.
    - A cooler bought mid-hold only slows aging from then on.
    - The Deep freezer stops it.
    - A fish sold within 2 days is never discounted.
    - Typical chat income (selling within 2 days) is unchanged.
- **P: The page.** Owns `public/app/*`.
- **T: The pet.** Owns `src/durable-objects/pet.ts`, `src/pet.ts`, `src/pet-config.ts`. Starts after S, because it uses `getFishFreshness` and `caughtAt`.

Order: S and P in parallel, then T.

## Orchestration (not for workers)

1. **Build:** launch S and P, review them, then launch T and review it. Run the full checks and dry-run builds.
2. **Docs:** write the README (store row, the Store Mini App section, the pet row) and release notes. Commit on the `spoilage` branch (off latest `main`; never push to `main` directly) and deploy to dev.
3. **Test on dev:** temporarily set `STARTS_AT` in the past there (dev only, or use a backdated test). Then check:
   - Bucket marks.
   - Prices dropping for ripe fish.
   - A rotten fish selling for 🫘1 with the rotten line.
   - Feeding a rotten fish making the pet sick, with the public line.
   - A cooler bought mid-way slowing aging from then on.
   - The pre-launch notice when `STARTS_AT` is in the future.
4. **Prod, only when the user asks:** set `STARTS_AT` to the announced date, deploy, and the owner warns the chat.
