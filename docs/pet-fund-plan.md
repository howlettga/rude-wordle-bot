# Pet fund and multiple pets: implementation plan

The chat pools beans in the store page toward room for another pet. Each goal reached unlocks one more pet slot, so `/adopt` can bring home another pet alongside the ones already there. This is the brief for each implementation worker. Read **Context**, **Game rules**, **Rules for every worker**, and **Contracts** in full, then do only your own work package.

## Context

- Repo: a grammY Telegram bot on one Cloudflare Worker, with per-chat SQLite Durable Objects. Background: `docs/store-mini-app-plan.md` (the store page, its API, the `/store` card) and `docs/message-in-a-bottle-plan.md` (the most recent store feature, which this one mirrors: charge in the Store DO, act in another DO, refund on failure).
- The group pet: `src/durable-objects/pet.ts` (the Pet DO), `src/pet.ts` (the `PetComposer`: `/adopt`, `/pet`, `/graveyard`, card buttons, the hourly check), `src/pet-config.ts` (every tuning number), `src/pet-math.ts` (lazy food/mood meters).
- **Today the pet code assumes exactly one living pet per chat** (`SELECT * FROM pets WHERE died_at IS NULL LIMIT 1` in `settle`, `peek`, and friends; `adopt` refuses when one is alive; `lookup`, `tick`, `kill`, and `revive` return a single pet). Caretakers, cooldowns, and tricks are already stored per `pet_id`, and card buttons already carry the pet's id (`pet:<action>:<petId>`).
- Store: `src/durable-objects/store.ts` (wallets, ledger, `charge`/`refund`, the card's activity line), `src/store.ts` (the card), `src/webapp/api.ts` (the page's API), `public/app/` (the page). Money is beans, always written `🫘50` (`formatBeans`).

## Game rules

| Rule | Value |
|---|---|
| Slots | Every chat starts with 1. Each fund goal reached adds 1, up to 4. A slot is how many pets can be alive at once; when a pet dies its slot is free for the next `/adopt`. Slots are never lost |
| Goals | Slot 2: 🫘100. Slot 3: 🫘1,000. Slot 4: 🫘2,500 (`PET_FUND.SLOT_GOALS`) |
| Donating | In the store page, in preset amounts 🫘10, 🫘25, 🫘50, 🫘100. Final, never refunded. Anything past a goal carries into the next one. Once every slot is unlocked, the fund closes |
| Too much | A donation bigger than what's left across all remaining goals is refused, with the most you can give |
| Activity | Each donation sets the `/store` card's activity line to "🐾 Galen chipped in 🫘50 to the pet fund." |
| Celebration | Reaching a goal posts one message to the chat: "🎉 The pet fund hit 🫘100! There's room for another pet. Use /adopt." then "Thanks to Galen (🫘60), Kyle (🫘30), and Sam (🫘10)." naming at most the **top 3 donors** toward that goal |
| Switches | The fund needs the store and pet features on. With the pet feature off, the page hides the fund and the API refuses donations |
| `/pet` with several pets | One card with a switcher. The summary lists every pet with a "check on" button each; that button turns the card into the pet's full card, which gets a "◀ All pets" button. Always one message |

## Rules for every worker

- Touch **only the files your package owns**. If you need a change elsewhere, stop and report it.
- Don't commit, push, deploy, or set secrets or webhooks. Don't read or edit `.dev.vars`. Don't touch `README.md` or `RELEASE_NOTES.md` (the orchestrator writes docs).
- Don't run prettier. Make targeted edits matching the surrounding style: 2-space indent, double quotes, explanatory prose comments in the file's existing voice, about 130-character lines.
- TypeScript is strict with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; relative imports end in `.js`. Before reporting run `npx tsc --noEmit -p .`, `npm run test:webapp`, and `npm run -s sim:fishing`, and fix anything you caused.
- No `await` between a Durable Object's read and the write that depends on it.
- No emoji in log lines. User-facing text keeps the existing emoji style and the bot's rude voice.
- Finish with a short report: files changed, check results, anything you couldn't do, and any deviation from a contract with the reason.

## Contracts

### `src/pet-config.ts` (package M)

```ts
export const PET_FUND = {
  SLOT_GOALS: [100, 1000, 2500], // beans to unlock slots 2, 3, 4
  DONATION_OPTIONS: [10, 25, 50, 100],
  TOP_DONORS: 3,
} as const;
export const MAX_PET_SLOTS = 1 + PET_FUND.SLOT_GOALS.length;
```

### Pet Durable Object (package M)

- **Migration `version < 6`:** a single-row `pet_fund` table (`id INTEGER PRIMARY KEY CHECK (id = 1)`, `slots INTEGER NOT NULL DEFAULT 1`, `raised INTEGER NOT NULL DEFAULT 0`, which counts toward the next goal), and `fund_donations` (`id`, `user_id`, `first_name`, `amount`, `slot` (the slot that amount went toward), `at` epoch seconds).
- **Multiple living pets.** `settle` becomes per-pet. Every method that settled "the" pet settles every living pet and collects all the eulogies.
- **New and changed types:**

```ts
export interface PetFundStatus {
  slots: number;        // unlocked
  maxSlots: number;     // MAX_PET_SLOTS
  livingPets: number;
  raised: number;       // toward the next goal
  goal: number | null;  // the next goal, or null once every slot is unlocked
}

export interface PetFundUnlock { slot: number; goal: number; topDonors: { firstName: string; amount: number }[] }

export type PetFundDonateResult =
  | { ok: true; fund: PetFundStatus; unlocked: PetFundUnlock[] }   // usually 0 or 1 unlocks; can be more
  | { ok: false; reason: "MAXED" }                                 // every slot already unlocked
  | { ok: false; reason: "TOO_MUCH"; max: number };                // more than is left across all goals

export type PetLookup = { pets: PetStatus[]; eulogies: PetEulogy[] };   // living pets, oldest first

export type PetAdoptResult =
  | { ok: true; pet: PetStatus; eulogies: PetEulogy[] }
  | { ok: false; type: "FULL"; pets: PetStatus[]; fund: PetFundStatus };

export type PetTickResult = { pets: PetStatus[]; eulogies: PetEulogy[]; warnings: { petId: number; warning: PetWarning }[] };
```

- **Method contracts:**
  - `lookup(): Promise<PetLookup>`
  - `adopt(input)`: refuses with `FULL` when living pets ≥ slots. Its existing input is unchanged.
  - `interact(input)`: unchanged signature. It settles only that pet, and its `GONE` and `STALE` meanings stay the same.
  - `tick(awake): Promise<PetTickResult>`
  - `peek(): Promise<PetPeek | null>`: the **neediest** living pet (lowest food, then lowest mood).
  - `freeze()`: freezes all pets.
  - `graveyard(limit)`: unchanged.
  - `kill(name?: string): Promise<{ eulogy: PetEulogy } | { needsName: true; pets: string[] } | { notFound: true }>`. With one living pet, the name is optional. With several, it needs a case-insensitive name match.
  - `revive(): Promise<PetStatus | null>`: brings back the most recently dead pet only if a slot is free.
  - `fundStatus(): Promise<PetFundStatus>`
  - `donateToFund(input: { userId: number; firstName: string; amount: number }): Promise<PetFundDonateResult>`. It records donations split across slots when one crosses a goal, and computes each unlock's top donors (by total given toward that slot, at most `TOP_DONORS`).

### `src/storage-service.ts` (package M)

Update the pet wrappers to the new types, and add `getPetFund(chatId)` and `donateToPetFund(chatId, input)`.

### `/pet` card and the composer (package M, `src/pet.ts`)

- **`/pet`:**
  - With 0 pets: as now.
  - With 1 pet: that pet's card, as now (no switcher).
  - With 2 or more: the **summary card**. A title, then one line per pet (emoji, name, species, food %, mood %), and one button row per pet: `🔍 Check on <name>` with callback `pet:view:<id>`.
- **Switching:**
  - Tapping a "check on" button edits the message into that pet's full card. Its buttons are the existing keyboard plus a last row `◀ All pets` (`pet:all`) whenever there are 2 or more living pets.
  - `pet:all` edits it back to the summary.
  - Feed / Pet / Play keep editing the message into that pet's card, keeping the `◀ All pets` row.
  - A stale `view` for a pet that has since died gets a pop-up and shows the summary.
- **`/adopt` when full:** if the store feature is on, "No room for another pet. Chip in to the pet fund in /store." Otherwise "One pet at a time." Don't enter the naming conversation.
- **Eulogies:** posted one by one wherever a lookup returns them.
- **Hourly check:** posts each pet's warning with that pet's card keyboard.
- **Owner commands:** `/petkill [name]` and `/petrevive` follow the new DO contracts, with plain replies for `needsName` and `notFound`.
- **Begging in `/fish` replies:** unchanged code, now using the neediest pet.

### Store side (package F)

- `src/durable-objects/store.ts`: `StoreActivity` gains `{ kind: "fund"; firstName: string; amount: number }`. The card's activity query also picks up `reason = 'buy' AND source = 'fund'` (refunded charges are excluded, the same as bottles).
- `src/store.ts`: renders that activity as `<i>🐾 Galen chipped in 🫘50 to the pet fund.</i>`.
- **HTTP API (`src/webapp/api.ts`):**
  - `GET /app/api/state` gains `"petFund"`. It's `null` when the pet feature is off. Otherwise:

    ```json
    { "raised": 40, "goal": 100, "slots": 1, "maxSlots": 4, "livingPets": 1, "options": [10, 25, 50, 100] }
    ```

    `goal` is `null` once every slot is unlocked.
  - `POST /app/api/fund` with body `{ "amount": 25 }` returns `{ "balance": 115, "fund": <the petFund object>, "unlocked": 0 }`. Steps in order:
    1. 400 `BAD_REQUEST` unless `amount` is one of the options.
    2. 409 `PET_OFF` if the pet feature is off.
    3. Charge with `source 'fund'` and `label 'pet fund'`. If short: 409 `CANT_AFFORD`.
    4. `donateToPetFund`. On `MAXED` or `TOO_MUCH`: refund, then 409 with that code and a plain message ("Every pet slot is already unlocked." / "The fund only needs 🫘N more."). If it throws: refund and rethrow.
    5. Refresh the latest store card through `ctx.waitUntil`.
    6. For each unlock, post the celebration message to the chat with `new Api(env.BOT_TOKEN)`, through `ctx.waitUntil`, plain text, into the latest store card's thread if there is one. Name at most the top 3 donors ("Thanks to Galen (🫘60)." / "… and Kyle (🫘30)." / "…, Kyle (🫘30), and Sam (🫘10)."). Log and ignore send failures.

### The page (package P)

- **Owns:** `public/app/index.html`, `public/app/app.js`, `public/app/app.css`.
- **Section:** a new **🐾 Pet fund** section after Worms and before Message in a bottle. It's hidden when `state.petFund` is `null`.
  - A progress bar and `🫘40 / 🫘100 toward room for another pet`.
  - A small line: `Pet slots: 1 of 4`.
  - Preset amount chips from `options`, one selectable.
  - When `goal` is `null`: just "Every pet slot is unlocked." with no chips.
- **Bottom button:**
  - When an amount is picked: "Chip in 🫘25".
  - Inactive with "Not enough beans" when the balance is short.
  - Picking an amount clears any other selection (fish, gear, worm, bottle), and vice versa. Follow how the bottle section already does this.
- **On success:**
  - A success haptic and "🐾 Thanks for chipping in.", or "🎉 You unlocked room for another pet! Use /adopt." when `unlocked > 0`.
  - Clear the selection and fetch state again.
- **On error:** show the API's message.
- **Mock mode:**
  - Add `petFund` to the fixture (raised 🫘40 of 🫘100).
  - A faked `POST /app/api/fund` that moves the progress bar and returns `unlocked: 1` when a goal is crossed.
  - `&fund=full` shows the maxed state, and `&fund=off` makes `petFund` null.
- **Rules:** `textContent` only, 🫘 as the currency sign, theme variables, and `node --check public/app/app.js` passes.

## Work packages

- **M: Multiple pets and the fund's storage.** Owns `src/durable-objects/pet.ts`, `src/pet.ts`, `src/pet-config.ts`, `src/storage-service.ts`, and `src/main.ts` (only if the hourly-check call needs adjusting). Also `src/fishing.ts` (only if the begging call needs adjusting).
- **P: The page.** Owns `public/app/*`. Works only from the HTTP API contract.
- **F: Store side and API.** Owns `src/durable-objects/store.ts`, `src/store.ts`, `src/webapp/api.ts`. Starts **after M**, because it calls M's storage wrappers.

Order: M and P in parallel, then F.

## Orchestration (not for workers)

1. Review M and P. Launch F. Review F.
2. Write the README (pet and store feature rows, Store Mini App section) and release notes. Run the full checks and dry-run builds. Commit on `pet-fund`, then deploy to dev.
3. Test on the test bot:
   - Donate to cross 🫘100. The celebration posts with top donors.
   - `/adopt` a second pet. `/pet` shows the summary, and switching works both ways.
   - Feeding from a pet's card keeps the `◀ All pets` row.
   - A third `/adopt` is refused with the fund nudge.
   - The hourly check handles two pets.
   - `/petkill` asks for a name.
