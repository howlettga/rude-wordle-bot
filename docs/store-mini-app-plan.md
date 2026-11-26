# Store Mini App: implementation plan

An in-Telegram page for the General Store, opened from the `/store` card, where a player sees their whole bucket, sells any fish, and buys gear, without posting anything in the group. Plus a separate `dev` deployment so the page can be tested away from prod.

This file is the brief for each implementation worker. Read **Context**, **Telegram facts**, **Rules for every worker**, and **Contracts** in full, then do only your own work package.

## Context

- Repo: a grammY Telegram bot running as one Cloudflare Worker (`src/main.ts`), with per-chat Durable Objects for state. Webhook updates arrive as `POST /`.
- The store already exists: `src/store.ts` (the `/store` card and its buttons), `src/durable-objects/store.ts` (wallets, ledger, gear, prices), `src/store-math.ts` (prices, `formatBeans`), `src/gear.ts` (rod/boat tiers, worms). Fish live in `src/durable-objects/fishing.ts`. `src/storage-service.ts` wraps every Durable Object call.
- Money is beans, always written with 🫘 as a currency sign (`formatBeans(18)` gives `🫘18`).
- The card keeps all its current quick buttons. This work adds a `🛒 Open store` button that opens the page.

## Telegram facts (verified against core.telegram.org)

1. A `web_app` inline button is "available only in private chats between a user and the bot". The group card must use a plain **URL button** pointing at a direct Mini App link: `https://t.me/<bot_username>/<short_name>?startapp=<start_param>`. Telegram docs: direct links "open a Mini App directly in the current chat".
2. A Mini App opened from a direct link gets **no chat id**. `initData.chat` is only set for attachment-menu and join-request launches. Direct-link launches get `chat_type` and `chat_instance` (an opaque id), and the `startapp` value as `start_param`. Mini Apps opened this way "have no access to the chat" (can't read or send messages).
3. So the card's link carries the group's chat id in `start_param`, **signed by us**. Anyone can type their own `startapp` value, so Telegram's signature on `initData` doesn't prove which group a link came from.
4. The docs don't state allowed characters or a maximum length for `startapp`. Keep it to `[A-Za-z0-9_-]` and at most 64 characters.
5. `initData` validation (HMAC): `secret_key = HMAC_SHA256(key = "WebAppData", message = bot_token)`. The data-check-string is every received field except `hash`, as `key=value`, sorted by key, joined with `\n`. The expected `hash` is `hex(HMAC_SHA256(key = secret_key, message = data_check_string))`. Newer clients also send a `signature` field (for third-party Ed25519 checks). Accept the HMAC computed with `signature` included in the data-check-string, and also accept it computed with `signature` left out, since it's still keyed by our token either way. Telegram suggests also checking `auth_date`.
6. Setting up the app is a BotFather step (expected: `/newapp`, choose the bot, short name `store`, URL `https://<worker host>/app/`). That's done by the user, not a worker.

## Architecture

```
Group chat: /store card ── [🛒 Open store] URL button ──► t.me/<bot>/store?startapp=<signed chat link>
                                                                   │ Telegram opens the page over the chat
Same Worker                                                        ▼
  GET  /app/*          static files from ./public (Workers static assets, free)
  /app/api/*           src/webapp/api.ts ─► validate initData ─► verify signed link ─► getChatMember
                                         ─► Store / Fishing Durable Objects (existing + small additions)
                                         ─► after a sale/upgrade: edit the chat's latest /store card
  POST /               Telegram webhook (unchanged)
```

- **Link expiry:** a signed link is good for 24 hours from when the card was posted or last edited (`STORE_LINK_TTL_SECONDS`). Every card edit puts a freshly signed link on the button.
- **Session expiry:** `initData` is accepted for 1 hour after the page was opened (`INIT_DATA_MAX_AGE_SECONDS`). After that the page asks the user to reopen it.
- **Card activity line:** the Store DO remembers the chat's most recent `/store` card (message id and thread). A sale or upgrade made in the page edits that card's activity line, through `ctx.waitUntil` so the response isn't delayed. Older cards are left alone.
- **Dev deployment:** a wrangler `dev` environment deploys a separate Worker, `rude-bot-dev`, with its own Durable Objects, secrets, and test bot. Prod is never touched by dev testing.

## Rules for every worker

- Touch **only the files your package owns** (listed per package). If you need a change elsewhere, stop and report it instead of making it.
- Don't commit, push, deploy, or set secrets or webhooks. Don't read or edit `.dev.vars`. The orchestrator does all of that.
- Don't run prettier (the repo has no config, and it reformats whole files). Make targeted edits that match the surrounding style: 2-space indent, double quotes, explanatory prose comments like the existing files, about 130-character lines.
- TypeScript is strict with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. Relative imports end in `.js`. Before reporting, run `npx tsc --noEmit -p .` and fix anything your files caused.
- Modules that `scripts/*.mjs` load directly under Node (`src/webapp/init-data.ts`, `src/webapp/store-link.ts`) must have **no runtime imports**. Type-only imports are fine. Use only `globalThis.crypto.subtle`, `TextEncoder`, `btoa`/`atob`, and `URLSearchParams`, which Node 24 and Workers both have.
- No emoji in log lines (`console.error` etc.). UI text keeps the existing emoji style.
- Finish with a short report: files changed, anything you couldn't do, and any place you deviated from a contract below (with the reason).

## Contracts

These are fixed so packages can be built in parallel. Don't change a signature without reporting it.

### `src/webapp/init-data.ts` (package B)

```ts
export const INIT_DATA_MAX_AGE_SECONDS = 3600;

export interface InitDataUser { id: number; first_name: string; username?: string }

export type InitDataResult =
  | { ok: true; user: InitDataUser; startParam: string | null; authDate: number; chatType: string | null; chatInstance: string | null }
  | { ok: false; reason: "MALFORMED" | "BAD_HASH" | "EXPIRED" };

// raw: the exact Telegram.WebApp.initData string. EXPIRED when nowSec - auth_date > maxAgeSec.
export function validateInitData(raw: string, botToken: string, nowSec: number, maxAgeSec?: number): Promise<InitDataResult>;
```

### `src/webapp/store-link.ts` (package B)

```ts
export const STORE_APP_SHORT_NAME = "store";
export const STORE_LINK_TTL_SECONDS = 24 * 3600;

// Returns e.g. "n1a2b3c4_t5u6v7_Ab3xK9pQ2mZ7wR4e": sign ("n" negative / "p" positive) + base36(|chatId|),
// "_", base36(issuedAtSec), "_", the first 16 base64url chars of HMAC_SHA256(key = botToken,
// message = "store-link:" + everything before the last "_"). Only [A-Za-z0-9_-], at most 64 chars.
export function signStoreLink(chatId: number, issuedAtSec: number, botToken: string): Promise<string>;

// EXPIRED past STORE_LINK_TTL_SECONDS, or if issuedAt is more than 300 s in the future. Constant-time compare.
export function verifyStoreLink(param: string, botToken: string, nowSec: number):
  Promise<{ ok: true; chatId: number; issuedAt: number } | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" }>;

// https://t.me/<botUsername>/<STORE_APP_SHORT_NAME>?startapp=<param>
export function storeAppUrl(botUsername: string, param: string): string;
```

### Durable Object and storage additions (package C)

In `src/durable-objects/store.ts`:

- `buyGear(input: { userId: number; firstName: string; item: StoreItem }): Promise<StoreBuyResult>`, where `StoreBuyResult = Exclude<StoreTapResult, { kind: "CONFIRM" }>`. It buys immediately with no confirm tap. Refactor so `tapGear` (after its confirm check) and `buyGear` share one private synchronous purchase function. No `await` between reading balance or gear and writing.
- `quoteFishes(chatId: number, fish: { species: string; weight: number }[]): Promise<number[]>` returns today's sale price for each, in order.
- `recordCard(messageId: number, threadId: number | null): Promise<void>` and `latestCard(): Promise<{ messageId: number; threadId: number | null } | null>`. A new migration (`version < 3`) adds a single-row `cards` table.

In `src/durable-objects/fishing.ts`: `BucketFish` gains `id: number`, and `bucket()` returns it. Order the bucket heaviest first.

In `src/storage-service.ts`, add wrappers: `buyStoreGear(chatId, input)`, `quoteFishes(chatId, fish)`, `recordStoreCard(chatId, messageId, threadId)`, `getLatestStoreCard(chatId)`.

### HTTP API (package E implements, package D consumes)

- Same origin as the page. Every request sends the header `Authorization: tma <Telegram.WebApp.initData>`. `start_param` is read from the validated `initData`; the page never sends a chat id.
- Every request is checked in this order. Errors are JSON `{ "error": CODE, "message": "<plain text for the user>" }`.

| Check | Failure |
|---|---|
| `validateInitData` | 401 `SESSION_EXPIRED` (EXPIRED) or 401 `BAD_SESSION` |
| `verifyStoreLink(startParam)` | 401 `LINK_EXPIRED` or 403 `BAD_LINK` (also when `startParam` is null) |
| `getChatMember(chatId, user.id)` is creator, administrator, member, or restricted with `is_member` | 403 `NOT_A_MEMBER` |
| `store` feature on in that chat | 403 `STORE_OFF` |

- `GET /app/api/state` returns:

```json
{
  "firstName": "Galen",
  "balance": 140,
  "fishing": true,
  "price": { "perLb": 0.38, "yesterdayPerLb": 0.35 },
  "bucket": [{ "id": 12, "species": "koi", "emoji": "🎏", "weight": 8.1, "quote": 9, "daysHeld": 2.4 }],
  "worms": { "count": 2, "max": 5, "price": 2 },
  "gear": [
    { "line": "rod", "emoji": "🎣", "current": "Fiberglass rod", "next": { "name": "Carbon rod", "price": 350, "pitch": "bigger fish on every cast" } },
    { "line": "boat", "emoji": "🚣", "current": "Inner tube", "next": { "name": "Rowboat", "price": 60, "pitch": "fish away from the crowd when the lake's busy" } }
  ]
}
```

  `next` is `null` at the top tier. When `fishing` is false, `bucket` is `[]` and selling and gear are unavailable (`409 FISHING_OFF`).

- `POST /app/api/sell` with body `{ "fishId": 12 }` returns `{ "amount": 9, "balance": 149, "fish": { "species": "koi", "emoji": "🎏", "weight": 8.1 } }`. Errors: 403 `NOT_YOURS`, 409 `GONE`, 409 `FISHING_OFF`. It uses `takeFishById(..., "store", "sold")`, then `sellFish`, then `returnFish` if the payout throws, the same as `StoreComposer.sell`.
- `POST /app/api/buy` with body `{ "item": "rod" | "boat" | "worms" }` returns `{ "name": "Carbon rod", "price": 350, "balance": 40, "worms": 2 }`. Errors: 409 `CANT_AFFORD`, `MAXED`, `FULL`, `FISHING_OFF`, and 400 `BAD_REQUEST` for an unknown item.
- After a successful sell, or a rod or boat buy, `ctx.waitUntil(refresh)` edits the chat's `latestCard`. It uses `new Api(env.BOT_TOKEN)` and `renderStoreCard`, and puts a freshly signed link on the button. Editing failures are logged and ignored.

### Card rendering (package E, in `src/store.ts`)

```ts
// The /store card's text and keyboard. storeUrl null leaves out the Open store button.
export function renderStoreCard(card: StoreCard, fishing: boolean, storeUrl: string | null): { text: string; reply_markup: InlineKeyboard };
```

## Work packages

Wave 1 packages (A-D) have no shared files and run in parallel. Wave 2 (E) starts when B and C are done.

### A: Dev environment, static assets, scripts, docs

- **Owns:** `wrangler.jsonc`, `package.json`, `README.md`, `.gitignore` (only if needed).
- **`wrangler.jsonc` changes:**
  - Add a top-level `"assets": { "directory": "./public" }`. Requests that match a file are served without running the Worker. Everything else (including `POST /` and `/app/api/*`) reaches the Worker. Don't add an `index.html` at the root of `public/`.
  - Add `"env": { "dev": { ... } }` with `"name": "rude-bot-dev"`, the full `durable_objects.bindings` list repeated (wrangler doesn't inherit it), and the same hourly trigger. Check which of `assets`, `migrations`, `observability`, `triggers`, and `rules` are inherited in the installed wrangler version, and repeat any that aren't.
  - Verify with `npx wrangler deploy --dry-run --env dev --outdir <scratch dir>` and with no `--env`. Report the bindings each one lists.
- **`package.json` scripts:** `"deploy:dev": "wrangler deploy --env dev"` and `"test:webapp": "node scripts/test-webapp.mjs"` (package B writes the script).
- **README:**
  - A "Dev deployment" section: what `rude-bot-dev` is, the `wrangler secret put <NAME> --env dev` commands for `BOT_TOKEN`, `BOT_INFO`, `OWNER_CHAT_ID`, and a dev-only `TIDE_SECRET`, pointing the test bot's webhook at `https://rude-bot-dev.<subdomain>.workers.dev/`, and `npm run deploy:dev`.
  - A "Store Mini App" section: the BotFather setup per bot (short name `store`, URL `https://<worker host>/app/`), how the signed link and 24-hour expiry work, and that `npm run dev` with the tunnel remains fine for non-page work.
  - Add `/app/` and `/app/api/*` to any place the README describes routes.

### B: initData validation, signed store links, tests

- **Owns:** `src/webapp/init-data.ts`, `src/webapp/store-link.ts`, `scripts/test-webapp.mjs`.
- Implement the contracts above exactly, with no runtime imports. Use constant-time comparison of digests (compare all bytes and fold differences), never `===` on strings.
- `scripts/test-webapp.mjs` imports the two `.ts` files directly, like `scripts/sim-fishing.mjs` does, and exits non-zero on any failure. It covers:
  - Link round trip for positive, negative, and `-100xxxxxxxxxx` supergroup ids.
  - Output always matches `^[A-Za-z0-9_-]{1,64}$`.
  - A tampered chat id or timestamp gives `BAD_SIGNATURE`.
  - Past the TTL gives `EXPIRED`, and more than 300 s in the future also gives `EXPIRED`.
  - Garbage gives `MALFORMED`.
  - `initData` the test signs itself with the algorithm in Telegram fact 5 validates, both with and without a `signature` field present.
  - A changed field gives `BAD_HASH`.
  - A stale `auth_date` gives `EXPIRED`.
  - The `user` JSON is parsed.

### C: Durable Object and storage additions

- **Owns:** `src/durable-objects/store.ts`, `src/durable-objects/fishing.ts`, `src/storage-service.ts`.
- Implement the contract above. Keep `tapGear`'s behavior identical for the card: rods and boats need a confirming second tap, worms are one tap.
- `cards` table: `id INTEGER PRIMARY KEY CHECK (id = 1), message_id INTEGER NOT NULL, thread_id INTEGER, updated_at TEXT NOT NULL DEFAULT (datetime('now'))`, upserted by `recordCard`.
- Don't change the existing ledger, wallet, or gear tables.

### D: The page

- **Owns:** `public/app/index.html`, `public/app/app.js`, `public/app/app.css`.
- **Stack:** plain HTML, CSS, and browser JS, with no build step and no libraries except `<script src="https://telegram.org/js/telegram-web-app.js"></script>`. Call `Telegram.WebApp.ready()` and `expand()`. Style only with Telegram's theme CSS variables (`--tg-theme-bg-color`, `--tg-theme-text-color`, `--tg-theme-hint-color`, `--tg-theme-button-color`, `--tg-theme-button-text-color`, `--tg-theme-secondary-bg-color`), with sensible fallbacks so it also looks right in a normal browser.
- **Layout, top to bottom:**
  - Header: "🏪 General Store", your balance (`🫘140`), today's fish price per lb with ▲ or ▼ versus yesterday.
  - **Bucket:** one row per fish (emoji, species, weight to 0.1 lb, its quote as `🫘9`), heaviest first. "Your bucket's empty. Go /fish." when empty.
  - **Gear:** rod and boat, each showing the current tier and, if there's one, the next tier's name, pitch, and price. "Top of the line" at the top tier.
  - **Worms:** count out of max, and a buy-one row.
- **Interaction:** tapping a fish or gear row selects it (highlighted), and Telegram's bottom button (`Telegram.WebApp.MainButton`) shows the action, e.g. "Sell 🎏 8.1 lb koi for 🫘9" or "Buy Carbon rod for 🫘350". Tapping the bottom button calls the API with `showProgress()`, then re-fetches state. On success use `HapticFeedback.notificationOccurred("success")` and show a short inline confirmation. On error show the API's `message`. Hide the bottom button when nothing's selected. Grey out unaffordable gear but keep it selectable, so the bottom button can say "Not enough beans".
- **Error and empty states:**
  - Not inside Telegram (no `initData`): "Open this from the 🏪 store card in your Telegram group."
  - `LINK_EXPIRED`: "This store link expired. Send /store in the chat for a fresh one."
  - `SESSION_EXPIRED`: "Close and reopen the store."
  - `NOT_A_MEMBER` and `STORE_OFF`: show the API message.
  - `fishing: false`: "Fishing is off in this chat, so there's nothing to sell or buy."
- **Mock mode:** `/app/?mock=1` uses built-in fixture data matching the `state` contract, fakes sell and buy responses, and works in a normal browser. It's for reviewing the page without Telegram.
- **Safety:** put all API text into the page with `textContent`, never `innerHTML`.
- **Format:** `toLocaleString("en-US")` for numbers, 🫘 as the currency sign everywhere.

### E (wave 2): API handler, routing, card button

- **Owns:** `src/webapp/api.ts` (new), `src/main.ts`, `src/store.ts`, `src/bot.ts`.
- **`src/webapp/api.ts`:** `export async function handleStoreApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>`, implementing the HTTP contract.
  - Build the `StorageService` the same way `main.ts` does. Export `buildStorage` from `main.ts` if needed, or move it to its own module.
  - `getChatMember` goes through `new Api(env.BOT_TOKEN)`.
  - The gear list comes from `GEAR_LINES` and `WORMS` in `src/gear.ts` plus the player's gear. Quotes come from `quoteFishes`.
  - Respond with JSON and `Cache-Control: no-store`.
- **`src/main.ts`:** `fetch(request, env, ctx)` sends `/app/api/*` to `handleStoreApi`, and everything else to the bot as now.
- **`src/store.ts`:**
  - Add `renderStoreCard`, used by both the composer and the API. The card's keyboard stays as it is, plus a last row with one URL button, `🛒 Open store`, to `storeAppUrl(botUsername, signedLink)`.
  - `sendCard` records the posted card with `recordStoreCard`.
  - Every card edit (`refreshCard`) re-signs the link.
  - Leave out the button if the bot has no username.
- **`src/bot.ts`:** give `StoreComposer` what it needs to sign links (for example a `signLink: (chatId) => Promise<string>` built from the token) and the bot's username (`botInfo.username`).
- **Checks:** run `npx tsc --noEmit -p .`, `npm run test:webapp`, and `npm run -s sim:fishing`.

## Orchestration (not for workers)

1. Launch A, B, C, and D in parallel, each with this file and its package letter. Review each report. Typecheck after all four.
2. Launch E. Review it, then run the full checks: `npx tsc --noEmit -p .`, `npm run test:webapp`, `npm run -s sim:fishing`, and `wrangler deploy --dry-run` for both environments.
3. Preview `/app/?mock=1` locally (`npm run dev`) for layout.
4. Run a code review over the branch diff. Fix findings, then commit on a new branch off `general-store`.
5. **The user, with orchestrator help:** set the `rude-bot-dev` secrets, `npm run deploy:dev`, point the test bot's webhook at `rude-bot-dev`, and BotFather-register the test bot's `store` app with the dev URL.
6. End-to-end on the test bot in a test group:
   - `/store` shows the Open store button, and the page opens over the chat.
   - Bucket, gear, and balance match the card's Wallet pop-up.
   - Sell a chosen fish and buy worms. With enough beans, buy a rod and confirm the card's activity line updates.
   - A link older than 24 hours is refused.
   - A non-member can't use a forwarded link.
   - Nothing is posted in the group.
7. Prod, only when the user asks: deploy, then BotFather-register the prod bot's `store` app with the prod URL.

## Open risks

- **BotFather's exact steps** for creating a direct-link app aren't in the Mini App docs. Confirm them during step 5.
- **Whether real clients include `signature`** in the HMAC data-check-string. The validator accepts both forms, and step 6 confirms it against real Telegram data.
- **`startapp` limits** aren't documented. The format stays at most 64 characters of `[A-Za-z0-9_-]`. If Telegram rejects it, shorten the signature to 12 characters.
- **Telegram may show a one-time "open this app?" prompt** on first launch. That's expected.
