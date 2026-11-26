# Message in a bottle: implementation plan

Players pay 🫘5 in the store page to write an anonymous note and throw it out to sea. Some time later it washes up, and the next lucky `/fish` reels in the bottle (in place of a fish) and reads the note to the whole chat. This is the brief for each implementation worker. Read **Context**, **Game rules**, **Rules for every worker**, and **Contracts** in full, then do only your own work package.

## Context

- Repo: a grammY Telegram bot running as one Cloudflare Worker, with per-chat SQLite Durable Objects. Read `docs/store-mini-app-plan.md` first for how the store page (Mini App) works: `public/app/` is the page, `src/webapp/api.ts` its API, and `src/store.ts` the `/store` card.
- Fishing: `src/durable-objects/fishing.ts` (casts, the bucket), `src/fishing.ts` (the `/fish` reply and owner fishing commands), `src/fishing-math.ts`.
- Store: `src/durable-objects/store.ts` (wallets, ledger, gear, the card's activity line), `src/store-math.ts` (`formatBeans`: money is always written `🫘5`).
- Owner-only commands already exist (e.g. `/fishingwindow` in `src/fishing.ts`, checked with `isOwner`). They silently ignore everyone else.

## Game rules

| Rule | Value |
|---|---|
| Price | 🫘5, flat |
| Note | 1–200 characters after trimming, at most 3 lines; plain text |
| Distances | 🏖️ Close to shore: 1–2 days. 🛟 Past the buoys: 3–5 days. 🌊 Out to sea: 1–2 weeks |
| Wash-up time | `thrown_at` + a uniformly random number of seconds within the distance's range, so any hour or minute. Hidden from everyone, writer included |
| Limit | At most 3 of your bottles in the water at once (not yet caught). A 4th gets a rude quip about littering |
| Catching | Each `/fish`, if at least one bottle has washed up (wash-up time passed, not caught, not removed) and wasn't written by the caster, there's a 35% chance the cast reels in the oldest such bottle **in place of** the fish or junk |
| Reading | The note goes into the catcher's normal `/fish` reply, visible to the whole chat. The writer is never shown |
| Anonymity | No history for writers: the page never lists your bottles or says who found them. The author is stored only so you can't catch your own, for the limit, and for the owner's moderation commands |
| Teaser | A successful throw sets the `/store` card's activity line to "🍾 Someone threw a bottle out to sea." |
| Scope | Bottles stay in the chat they were thrown in |
| Feature switches | Throwing needs the store and fishing on (it's in the store page). Catching only needs fishing, so bottles already out there still turn up if the store is switched off |

A bottle catch still uses the caster's cast for the day, counts toward the lake's busyness, and uses up a worm if they had one, like any cast. It never touches the leaderboard or the bucket.

## Rules for every worker

- Touch **only the files your package owns**. If you need a change elsewhere, stop and report it.
- Don't commit, push, deploy, or set secrets or webhooks. Don't read or edit `.dev.vars`. The orchestrator does that.
- Don't run prettier. Make targeted edits matching the surrounding style: 2-space indent, double quotes, explanatory prose comments, about 130-character lines.
- TypeScript is strict with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; relative imports end in `.js`. Before reporting run `npx tsc --noEmit -p .`, `npm run test:webapp`, and `npm run -s sim:fishing`, and fix anything you caused.
- Any module a `scripts/*.mjs` file loads directly under Node (like `src/bottles.ts`) has **no runtime imports**. Type-only imports are fine.
- No emoji in log lines. User-facing text keeps the existing emoji style.
- Finish with a short report: files changed, check results, anything you couldn't do, and any deviation from a contract with the reason.

## Contracts

### `src/bottles.ts` (package K, new, pure)

```ts
export type BottleDistance = "shore" | "buoys" | "sea";

export const BOTTLE_CONFIG = {
  PRICE: 5,
  MAX_CHARS: 200,
  MAX_LINES: 3,
  MAX_IN_WATER: 3, // per author: thrown and not yet caught or removed
  CATCH_CHANCE: 0.35,
} as const;

export const BOTTLE_DISTANCES: Record<BottleDistance, { emoji: string; label: string; hint: string; minHours: number; maxHours: number }>;
// shore: 🏖️ "Close to shore", "washes up in a day or two", 24-48 h
// buoys: 🛟 "Past the buoys", "washes up in 3 to 5 days", 72-120 h
// sea:   🌊 "Out to sea", "washes up in a week or two", 168-336 h

// Trims, normalizes newlines to \n, strips control characters other than \n, and collapses 3+ blank lines.
export function cleanBottleText(raw: string): { ok: true; text: string } | { ok: false; reason: "EMPTY" | "TOO_LONG" | "TOO_MANY_LINES" };

// thrownAtSec + a uniform random number of whole seconds in [minHours, maxHours] hours.
export function washUpTime(distance: BottleDistance, thrownAtSec: number, random?: () => number): number;

// At least 4 rude quips about littering the lake, for the 4th bottle. Plain text. Examples of the tone:
// "🚯 You've already got 3 bottles bobbing around out there. The fish are drafting a lawsuit. Wait till someone finds one."
// "🚯 Three bottles in the lake is littering. Four is a Superfund site."
export const LITTER_LINES: readonly string[];

export function isBottleDistance(value: unknown): value is BottleDistance;
```

### Fishing Durable Object (package K)

- Migration `version < 3` adds:

  ```sql
  CREATE TABLE bottles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id INTEGER NOT NULL,
    author_name TEXT NOT NULL,
    text TEXT NOT NULL,
    distance TEXT NOT NULL,
    thrown_at INTEGER NOT NULL,   -- epoch seconds
    washes_up_at INTEGER NOT NULL, -- epoch seconds
    status TEXT NOT NULL DEFAULT 'drifting', -- 'drifting' | 'caught' | 'removed'
    caught_by INTEGER,
    caught_by_name TEXT,
    caught_at INTEGER
  )
  ```

  plus an index on `(status, washes_up_at)`.
- `throwBottle(input: { authorId: number; authorName: string; text: string; distance: BottleDistance }): Promise<{ ok: true } | { ok: false; reason: "LIMIT" }>`. Synchronous inside: count the author's `drifting` bottles, refuse at `MAX_IN_WATER`, else insert with `washUpTime`.
- `cast()` gains a third outcome. After the already-fished check and the angler/lake bookkeeping (so the cast is used up and counted), and **before** the junk/fish roll: if a `drifting` bottle exists with `washes_up_at <= now` and `author_id != userId`, then with probability `CATCH_CHANCE` claim the oldest one by `washes_up_at` (set `caught`, `caught_by`, `caught_by_name`, `caught_at`) and return it. No `await` between the check and the claim.
- `FishingCastResult` adds `({ ok: true; kind: "bottle"; text: string } & CastReport)`. No catch row is inserted.
- Owner moderation: `listBottles(): Promise<BottleListing>` returns every `drifting` bottle (id, distance, thrownAt, washesUpAt, washed up yet or not, text) and the 5 most recently caught (id, caughtAt, caughtByName, text). Neither list includes the author. `removeBottle(id): Promise<boolean>` sets a `drifting` bottle to `removed`. `bottleAuthor(id): Promise<{ authorName: string; authorId: number } | null>` works for any bottle.

### Store Durable Object (package K)

- `charge(input: { userId; firstName; amount; source: string; label: string }): Promise<{ ok: true; balance: number } | { ok: false; balance: number }>` debits the wallet and writes a ledger row (`reason 'buy'`), or refuses if the balance is short. No `await` between the read and the write.
- `refund(input: { userId; firstName; amount; source: string; label: string }): Promise<number>` credits it back (`reason 'refund'`) and returns the balance.
- `StoreActivity` gains `{ kind: "bottle" }`. The card's activity query also picks up `reason = 'buy' AND source = 'bottle'`, and `src/store.ts` renders it as `<i>🍾 Someone threw a bottle out to sea.</i>`. Never include the name.

### HTTP API (package K implements, package P consumes)

Authentication and the four checks are unchanged (see `docs/store-mini-app-plan.md`).

- `GET /app/api/state` gains:

  ```json
  "bottles": {
    "price": 5, "maxChars": 200, "maxLines": 3, "atLimit": false,
    "distances": [
      { "id": "shore", "emoji": "🏖️", "label": "Close to shore", "hint": "washes up in a day or two" },
      { "id": "buoys", "emoji": "🛟", "label": "Past the buoys", "hint": "washes up in 3 to 5 days" },
      { "id": "sea", "emoji": "🌊", "label": "Out to sea", "hint": "washes up in a week or two" }
    ]
  }
  ```

  `atLimit` is whether this player already has `MAX_IN_WATER` bottles in the water. It's the only per-player bottle fact the page gets; there's no history.
- `POST /app/api/bottle` with body `{ "text": "...", "distance": "shore" | "buoys" | "sea" }` returns `{ "balance": 135 }`. Steps in order:
  1. 400 `BAD_REQUEST` for an unknown distance, or the `cleanBottleText` failure with a plain message ("Write something first.", "That's too long for a bottle (200 characters max).", "Keep it to 3 lines.").
  2. 409 `FISHING_OFF` if fishing is off.
  3. Charge 🫘5 with `source 'bottle'`. If short: 409 `CANT_AFFORD`, "A bottle costs 🫘5. You have 🫘N. Sell some fish."
  4. `throwBottle`. On `LIMIT`: refund, then 409 `LIMIT` with a random `LITTER_LINES` message. If it throws: refund, then rethrow (500).
  5. Refresh the latest card (the teaser) with `ctx.waitUntil`, like a sale does.

### `/fish` reply (package K, `src/fishing.ts`)

A `bottle` result replies (plain text, as a reply to the `/fish` message, with `link_preview_options: { is_disabled: true }`):

```
🍾 You reeled in a bottle! There's a note inside:

"<the note>"
```

No Sell button, and no flavor line or pet begging.

### Owner moderation commands (package K, `src/fishing.ts`)

Owner-only, hidden (not in the command menu), silently ignored for anyone else. Run in the group; **the answer goes to the owner's private chat** (`ownerChatId`), never the group, so notes and authors don't leak. After answering, try to delete the owner's command message from the group, and ignore failure (the bot may not be an admin).

- `/bottles`: lists that chat's bottles in the water (id, distance, thrown and wash-up times in Eastern time, whether it's washed up, the note) and the 5 most recently found (id, who found it, when, the note). No authors.
- `/bottlepull <id>`: removes a bottle still in the water. Replies whether it worked.
- `/bottlewho <id>`: tells the owner who wrote that bottle.

If the owner has never started a private chat with the bot, the DM fails. Log it and do nothing in the group.

## Work packages

Packages K and P share no files and run in parallel.

### K: Backend, `/fish`, moderation, docs, sim

- **Owns:** `src/bottles.ts` (new), `src/durable-objects/fishing.ts`, `src/durable-objects/store.ts`, `src/storage-service.ts`, `src/fishing.ts`, `src/store.ts` (only the bottle teaser in the card's activity line), `src/webapp/api.ts`, `scripts/sim-fishing.mjs`, `README.md`, `RELEASE_NOTES.md`.
- Implement every contract above.
- **Sim:** add a bottle section to `scripts/sim-fishing.mjs`. For a chat like the existing "our chat" rhythm (~3 casts a day at random times), report how long a washed-up bottle takes to be found (median and 90th percentile, in hours), and check the median is within 24 hours. Also check `washUpTime` always lands inside each distance's range.
- **README:** add message in a bottle to the store feature row and the Store Mini App section. Add the three owner commands to the hidden-commands table.
- **RELEASE_NOTES:** a line under the unreleased section.

### P: The page

- **Owns:** `public/app/index.html`, `public/app/app.js`, `public/app/app.css`.
- Add a **🍾 Message in a bottle** section below Worms:
  - A short intro line: "Write a note, throw it out to sea, and someday someone in the chat will reel it in. They won't know it was you."
  - A textarea with `maxlength` = `maxChars` and a live counter (`0/200`). It warns when there are more than `maxLines` lines.
  - Three distance options (emoji, label, hint), one selectable.
  - The price.
- **Bottom button:** when the textarea has text and a distance is picked, it shows "Throw it for 🫘5". Typing in the textarea makes the bottle the current selection, replacing any selected fish or gear, and selecting a fish or gear clears it. If the balance is under the price, the button says "Not enough beans" and is inactive. If `atLimit`, it says "Too many bottles out there" and is inactive.
- **On success:** a success haptic, "🍾 Off it goes. Someone will find it… eventually.", clear the textarea and selection, and fetch state again.
- **On error:** show the API's `message`. The `LIMIT` quip is meant to be read, so show it in full.
- **Mock mode** (`?mock=1`): include `bottles` in the fixture state and fake `POST /app/api/bottle`, including a `LIMIT` response on the 3rd throw in a session so the quip can be reviewed. Add `&bottlelimit=1` to start at the limit.
- Keep the existing rules: `textContent` only, 🫘 as the currency sign, Telegram theme variables, `node --check public/app/app.js` passes.

## Orchestration (not for workers)

1. Launch K and P in parallel. Review both reports and the diff.
2. Run the full checks and the dry-run build, then commit on `store-mini-app` and deploy to dev.
3. Test on the test bot. Bottles normally take at least a day to wash up, so test with a temporary owner-only dev shortcut if needed, or set a bottle's wash-up time in the past through the Durable Object. Then:
   - Throw a bottle. The card teaser appears.
   - A 4th throw gets a quip.
   - A cast reels in a washed-up bottle instead of a fish, and the note shows in the reply.
   - You never reel in your own bottle.
   - `/bottles`, `/bottlepull` and `/bottlewho` answer in the owner's DM only.
