# Tide chart: execution plan

A 🗺️ Tide chart bought in the store page for 🫘15 shows its owner, privately, for 7 days:
- this week's tides: exact for 3 days, then predicted, king tides included;
- how rested their fishing spot is;
- how busy the lake is today;
- a ★ on the best day to cast.

This is the brief for each implementation worker. Read **Context**, **Game rules**, **Rules for every worker**, and **Contracts** in full, then do only your own work package.

## Context

- Repo: a grammY Telegram bot on one Cloudflare Worker, with per-chat SQLite Durable Objects. For how the store page and its API work, read `docs/store-mini-app-plan.md`. `docs/message-in-a-bottle-plan.md` and `docs/pet-fund-plan.md` are recent features built the same way.
- **Fishing math** (`src/fishing-math.ts`):
  - A cast's quality is `wait × tide × lake`.
  - `waitFactor(daysWaited)` uses `WAIT_FACTOR` = 0.5 / 0.7 / 0.88 / 1.0 for 1 / 2 / 3 / 4+ days since your last cast. A first-ever cast counts as fully rested.
  - `tideFor(secret, chatId, dayNumber)` gives `low | normal | high | king` from the average of the last 4 days' hashed swells (`TIDE_WINDOW_DAYS`).
  - `tideMultiplier(tide)` is 0.6 / 1 / 1.4 / 2.
  - `lakeTier(castsToday)` gives `fresh | calm | busy | crowded | fished_out`.
  - `fishingDay(easternParts(now))` gives the fishing day (it turns over at 5am ET) as a date string and a day number.
  - `seededNormal(key)` turns a hash into a normal deviate.
- **Tides are deterministic** from `TIDE_SECRET`, the chat and the day, so future tides can be computed exactly. Without the secret, every tide is `normal`.
- **Fishing DO** (`src/durable-objects/fishing.ts`): `anglers.last_cast_date` (YYYY-MM-DD fishing date) and `lake_days(date, casts)`.
- **Store DO** (`src/durable-objects/store.ts`): wallets, the ledger, and the `gear` table (`rod`, `boat`, `worms` per user).

## Game rules

| Rule | Value |
|---|---|
| Price | 🫘15 for 7 days, starting now. Buying while one is active adds 7 days to it |
| Where | Store page only, private to the owner. No `/fish` or card changes, no activity line |
| Forecast | Today plus the next 6 fishing days (7 columns) |
| Exact days | Today, tomorrow, and the day after show the true tide, king included |
| Predicted days | Days 4 to 7 show a **forecast** that is right with probability 80% / 70% / 60% / 50%. Otherwise it shows a neighbouring tide (one step up or down, kept within low..king). It's deterministic: seeded by the secret, the chat, the target day, and the viewing day. So the same day looks the same all day, and the forecast for a given day sharpens as it gets closer |
| Your spot | From days since your last cast, as of a cast right now: cast today = **Fished out (cast again tomorrow)**, 1 day = **Overfished**, 2 = **Recovering**, 3 = **Almost rested**, 4+ or never = **Fully rested**. Plus a 4-square meter, and "Fully rested by <weekday>" when it's not yet |
| The lake | Today's busyness label from `lakeTier` (fresh / calm / busy / crowded / fished out) |
| ★ Best day | Among the 7 days, the one with the highest `waitFactor(days rested that day) × tideMultiplier(shown tide)`, using the **shown** forecast so it never reveals more than the chart does. Today is excluded if you've already cast today. Ties go to the earliest day |
| Switches | Needs the store and fishing features on (the page already shows "fishing is off" otherwise) |

## Rules for every worker

- Touch **only the files your package owns**. If you need a change elsewhere, stop and report it.
- Don't commit, push, deploy, set secrets or webhooks, or touch `.dev.vars`, `README.md`, or `RELEASE_NOTES.md` (the orchestrator writes docs).
- Don't run prettier. Match the surrounding style: 2-space indent, double quotes, explanatory prose comments in each file's voice, about 130-character lines.
- TypeScript is strict with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; relative imports end in `.js`. `src/fishing-math.ts` must keep **no runtime imports** (the sim loads it directly under Node).
- No `await` between a Durable Object's read and the write that depends on it.
- Before reporting run `npx tsc --noEmit -p .`, `npm run test:webapp`, `npm run -s sim:fishing`, and `node --check public/app/app.js`, and fix anything you caused.
- Finish with a short report: files changed, check results, and any deviation from a contract with the reason.

## Contracts

### Forecast math in `src/fishing-math.ts` (package K)

```ts
export const TIDE_CHART = {
  DAYS: 7,
  EXACT_DAYS: 3,
  PREDICTED_ACCURACY: [0.8, 0.7, 0.6, 0.5], // days 4, 5, 6, 7
} as const;

export interface TideForecastDay { dayNumber: number; tide: Tide; exact: boolean }

// todayDayNumber is the fishing day. Without a secret, every day is "normal" and exact.
export function tideForecast(secret: string | undefined, chatId: number, todayDayNumber: number): TideForecastDay[];

export type SpotRest = "fished_out" | "overfished" | "recovering" | "almost" | "rested";
// daysSinceLastCast: 0 = cast today, null = never cast.
export function spotRest(daysSinceLastCast: number | null): SpotRest;

// Index into the forecast of the best day to cast (see Game rules), or null if no day qualifies.
export function bestCastDay(forecast: TideForecastDay[], daysSinceLastCast: number | null): number | null;
```

The prediction picks the neighbouring tide deterministically from `seededNormal` on a key like `${secret}:chart:${chatId}:${targetDay}:${viewDay}`. Up or down is decided the same way. Clamp to the ends: low can only miss upward, king only downward.

### Fishing Durable Object (package K)

`anglerStatus(userId: number): Promise<{ daysSinceLastCast: number | null; castsToday: number }>`. Days are between `last_cast_date` and today's fishing date, and `castsToday` comes from `lake_days` for today. Synchronous inside, read-only.

### Store Durable Object (package K)

- Migration: `ALTER TABLE gear ADD COLUMN chart_until INTEGER` (epoch seconds, NULL = none). Use the next migration version.
- `buyTideChart(input: { userId: number; firstName: string }): Promise<{ ok: true; until: number; balance: number } | { ok: false; reason: "CANT_AFFORD"; balance: number }>`. It charges 🫘15 (ledger `reason 'buy'`, `source 'chart'`, `label 'Tide chart'`) and sets `chart_until = max(now, chart_until) + 7 days`, in one synchronous step. It never shows on the card's activity line.
- `chartUntil(userId): Promise<number | null>`
- The price and length live in `src/gear.ts` as `TIDE_CHART_ITEM = { emoji: "🗺️", price: 15, days: 7 }` (package K owns that addition).

### `src/storage-service.ts` (package K)

Add wrappers `getAnglerStatus(chatId, userId)`, `buyTideChart(chatId, input)`, and `getChartUntil(chatId, userId)`.

### HTTP API (package K implements, package P consumes)

`GET /app/api/state` gains `"tideChart"`. It's `null` when fishing is off. Otherwise:

```json
{
  "price": 15,
  "days": 7,
  "active": true,
  "until": 1764633600,
  "daysLeft": 5,
  "forecast": [
    { "weekday": "Thu", "tide": "high", "exact": true, "best": false },
    { "weekday": "Fri", "tide": "normal", "exact": true, "best": false },
    { "weekday": "Sat", "tide": "normal", "exact": true, "best": false },
    { "weekday": "Sun", "tide": "king", "exact": false, "best": true },
    { "weekday": "Mon", "tide": "high", "exact": false, "best": false },
    { "weekday": "Tue", "tide": "normal", "exact": false, "best": false },
    { "weekday": "Wed", "tide": "low", "exact": false, "best": false }
  ],
  "spot": { "rest": "overfished", "meter": 1, "restedOn": "Sun" },
  "lake": "busy"
}
```

- When the chart isn't active: `"active": false` with only `price` and `days` (no forecast, spot, or lake). That way the details never leave the server unpaid.
- `daysLeft` rounds up.
- `meter` is 0–4 (fished_out 0, overfished 1, recovering 2, almost 3, rested 4).
- `restedOn` is the weekday the spot reaches 4 days rested, or `null` if it already has.
- Weekdays come from each fishing day's date.

`POST /app/api/chart` (empty body) returns `{ "balance": 120, "until": 1764633600, "daysLeft": 7 }`. Errors: 409 `CANT_AFFORD` ("A tide chart costs 🫘15. You have 🫘N. Sell some fish.") and 409 `FISHING_OFF`. It runs after the same four session checks as every other endpoint.

### The page (package P)

- **Owns:** `public/app/index.html`, `public/app/app.js`, `public/app/app.css`.
- **When `tideChart.active`**, add a **🗺️ Tide chart** section directly under the header stats, above the Bucket:
  - **A row of 7 day columns:** weekday, tide icon, short label. Icons: low 🪨, normal 〰️, high 🌊, king 👑.
  - **Predicted days** (`exact: false`) are visibly softer (lighter colour, and a `~` before the label).
  - **The best day** gets a ★ and a highlight.
  - **"Your spot":** the 4-square meter, the label (Fished out / Overfished / Recovering / Almost rested / Fully rested), and "Fully rested by Sun" when `restedOn` is set.
  - **"The lake":** the label, capitalized (Fished out for `fished_out`).
  - **A footer:** "Good for 5 more days".
  - The 7 columns must fit a 375px phone without sideways scrolling.
- **The buy row** goes in the Gear section, after the rods and boats, as a selectable row: "🗺️ Tide chart" with price 🫘15. Sub-line: "This week's tides" when not active, "5 days left · add 7 more" when active.
  - The bottom button says "Buy a tide chart for 🫘15" (or "Add 7 days for 🫘15"), and "Not enough beans" when short.
  - On success: a success haptic, "🗺️ Here's your chart.", then fetch state again.
- **Mock mode:** fixture data for both states, active by default with the example above. `&chart=off` starts not owned. A faked `POST /app/api/chart` switches it on.
- **Rules:** `textContent` only, 🫘 as the currency sign, theme variables, and keep the shop's terse tone.

## Work packages

- **K: Backend.** Owns `src/fishing-math.ts`, `src/gear.ts`, `src/durable-objects/fishing.ts`, `src/durable-objects/store.ts`, `src/storage-service.ts`, `src/webapp/api.ts`, `scripts/sim-fishing.mjs`.
  - Add sim checks:
    - Exact days always equal `tideFor`.
    - Over many chats and days, the predicted days' hit rate is within ±3 points of `PREDICTED_ACCURACY`.
    - The forecast for a given day is stable across calls on the same viewing day.
    - `bestCastDay` never picks today after a cast today.
- **P: The page.** Owns `public/app/*`. Works only from the HTTP API contract.

K and P run in parallel.

## Orchestration (not for workers)

1. Launch K and P. Review both reports and the diff. Run the full checks and the dry-run builds.
2. Write the README (store row, Store Mini App section) and a release-notes line. Commit on `pet-fund`, push, and deploy to dev.
3. Test on the test bot:
   - Buy a chart (the test wallet has beans). The section appears.
   - The first 3 days match what `/fish` replies say about high tides.
   - The spot meter changes after a cast.
   - Buying again extends it to 14 days.
   - Without a chart, `state` carries no forecast.
4. Prod when the user asks.
