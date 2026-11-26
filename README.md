# rude-bot

A Telegram bot built with [grammY](https://grammy.dev), deployed as a Cloudflare Worker. No always-on server, no polling — Telegram delivers updates straight to the Worker via webhook.

## How it's structured

- `src/main.ts` — the Worker entrypoint (`fetch` handler). Sends `/app/api/*` to the store Mini App's API, and everything else (Telegram's webhook `POST /`) to grammY's webhook adapter, with the bot built from env-provided secrets.
- `src/bot.ts` — the `RudeBot` class. Wires every feature's handlers together, in order, each behind its feature switch.
- `src/features.ts` — the list of switchable features and their defaults (see [Feature switches](#feature-switches)).
- `src/webapp/` — the store Mini App's API (`/app/api/*`), `initData` validation, and signed store links (see [Store Mini App](#store-mini-app)).
- `public/app/` — the store Mini App's page, served as static files at `/app/` without running the Worker.
- `wrangler.jsonc` — Worker config (name, entrypoint, compatibility date, static assets, and the `dev` environment).

Routes:

| Path | What answers it |
|---|---|
| `POST /` | Telegram's webhook, handled by the bot |
| `/app/` | The store Mini App's page, static files from `public/app/` |
| `/app/api/*` | The store Mini App's API, in `src/webapp/api.ts` |

This same setup can be reused as a template for any new bot — just swap the handler logic in `src/bot.ts`.

## Prerequisites

- Node.js
- A Cloudflare account (`npx wrangler login` once, if you haven't)

No global installs needed — everything runs through `npx wrangler`.

---

## 1. Create the Telegram bot

Talk to [@BotFather](https://t.me/BotFather) in Telegram:

1. `/newbot` — follow the prompts, save the token it gives you.
2. `/setprivacy` → select your bot → **Disable**, if you want the bot to see all messages in group chats (not just commands/mentions). Leave it enabled if it should only respond to commands.

Repeat this to make a **second, separate bot** for local testing, so you never have to flip your real bot's webhook back and forth between dev and prod.

## 2. Get the bot's info (for `BOT_INFO`)

The Worker rebuilds the `Bot` instance on every request (no long-lived process to cache it in), so we pass `botInfo` explicitly to skip an extra `getMe` API round-trip per request. Fetch it once per bot token:

```sh
curl -s "https://api.telegram.org/bot<TOKEN>/getMe" | jq -c '.result'
```

Save that JSON output — you'll need it alongside the token in every step below.

## 3. Local development

Install dependencies:

```sh
npm install
```

Create a `.dev.vars` file (gitignored, never commit this) with your **test bot's** credentials:

```
BOT_TOKEN=<test bot token>
BOT_INFO=<test bot getMe result, from step 2>
TIDE_SECRET=<any long random string>
```

Start the dev server with a public tunnel (Cloudflare manages `cloudflared` for you — no separate install):

```sh
npx wrangler dev --tunnel
```

This prints a random `https://<something>.trycloudflare.com` URL each time it starts — that's your public dev endpoint. It changes on every restart, so you re-register it with Telegram each time you start a new session (see step 4) using your **test bot's** token.

## 4. Register a webhook URL with Telegram

Whether it's the dev tunnel URL or the production deploy URL, registering a webhook is the same call:

```sh
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<URL>"
```

- For dev: `<TOKEN>` = test bot token, `<URL>` = the `trycloudflare.com` URL from step 3.
- For prod: `<TOKEN>` = real bot token, `<URL>` = the deployed `*.workers.dev` URL from step 5.

Useful checks:

```sh
# See current webhook status/errors
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"

# Remove a webhook (e.g. to go back to polling for local testing)
curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook"
```

## 5. Deploy to Cloudflare

Set the **production bot's** secrets on the Worker (one-time, or whenever the token/info changes):

```sh
npx wrangler secret put BOT_TOKEN
# paste the real bot's token when prompted

curl -s "https://api.telegram.org/bot<TOKEN>/getMe" | jq -c '.result' | npx wrangler secret put BOT_INFO

openssl rand -hex 32 | npx wrangler secret put TIDE_SECRET
```

`TIDE_SECRET` seeds the hidden daily fishing tides and the store's daily fish prices. Without it, tides stay normal and prices stay flat. Never commit it or change it casually: changing it reshuffles every chat's tides and prices.

Deploy:

```sh
npx wrangler deploy
```

This prints the live `https://rude-bot.<subdomain>.workers.dev` URL (here, `https://rude-bot.howlettga.workers.dev`). Register it with Telegram as in step 4, using the real bot's token.

## Dev deployment

`rude-bot-dev` is a second, separate Worker for testing on real Cloudflare without a tunnel: same code, but its own Durable Objects (so its own wallets, fish, pets, and markets), its own secrets, and the test bot. Nothing done on it touches prod. It's the `dev` environment in `wrangler.jsonc`. If you add a Durable Object binding, add it to both lists there, since environments don't inherit them.

Set the **test bot's** secrets on it (one-time):

```sh
npx wrangler secret put BOT_TOKEN --env dev
# paste the test bot's token when prompted

curl -s "https://api.telegram.org/bot<TEST TOKEN>/getMe" | jq -c '.result' | npx wrangler secret put BOT_INFO --env dev

npx wrangler secret put OWNER_CHAT_ID --env dev
# your own Telegram user id, same as prod's

openssl rand -hex 32 | npx wrangler secret put TIDE_SECRET --env dev
```

Use a fresh `TIDE_SECRET` for dev, not prod's, so dev testing can't be used to preview prod's tides and prices.

Deploy:

```sh
npm run deploy:dev
```

Then point the test bot's webhook at it, as in step 4:

```sh
curl "https://api.telegram.org/bot<TEST TOKEN>/setWebhook?url=https://rude-bot-dev.howlettga.workers.dev/"
```

The test bot can only have one webhook, so this replaces the `trycloudflare.com` one from step 3. To go back to local dev, re-register the tunnel URL. Logs: `npx wrangler tail rude-bot-dev`.

## Store Mini App

The `/store` card has a `🛒 Open store` button that opens a page over the chat, where a player sees their whole bucket, sells any fish, and buys gear without posting anything in the group. The page is static files in `public/app/` (served at `/app/`), and it talks to the Worker at `/app/api/*`.

Each bot needs its own app registered with [@BotFather](https://t.me/BotFather), once (test bot with the dev URL, real bot with the prod URL):

1. `/newapp`, pick the bot, and follow the prompts.
2. Short name: `store` (the code builds links as `https://t.me/<bot username>/store?startapp=...`, so it has to be exactly this).
3. URL: `https://<worker host>/app/`, so `https://rude-bot-dev.howlettga.workers.dev/app/` for the test bot and `https://rude-bot.howlettga.workers.dev/app/` for the real one.

How it knows which group you're in: Telegram doesn't tell a Mini App which chat it was opened from, so the card's button link carries the group's chat id, signed with the bot token. The API checks Telegram's signature on the page's `initData` (who you are), checks our signature on the link (which group), and then checks you're a member of that group and the store is on there. A link is good for 24 hours from when the card was posted or last edited, and every card edit puts a fresh link on the button, so an old card's button stops working after a day. Send `/store` for a fresh one. Separately, the page asks you to reopen it once it's been open for an hour.

To look at the page's layout without Telegram, open `/app/?mock=1` (for example under `npm run dev`). It uses built-in sample data. `npm run test:webapp` checks the link signing and `initData` validation.

`npm run dev` with the tunnel is still fine for anything that isn't the page. The page itself needs a fixed URL registered with BotFather, which the tunnel doesn't have, so test it on `rude-bot-dev`.

## 6. Set the command menu (optional)

Registering a command with `bot.command()` in `src/bot.ts` only wires up the handler — it doesn't make Telegram show it in the `/` autocomplete menu. That list is separate and comes from `setMyCommands`, and not every command belongs in it:

- **Visible** — normal gameplay commands. These should go in the `/` menu everyone sees.
- **Invisible** — owner-only admin controls, a redundant self-service variant, or the obligatory `/start` handler. These still work fine when typed, they just don't need to clutter the menu.

### Visible commands

| Command | Description |
|---|---|
| `wordle` | play ya game |
| `portfolio` | see what ya got |
| `market` | who's worth what |
| `delist` | remove yourself from the market |
| `scorecard` | see who drools |
| `leaderboard` | see who rules |
| `buy` | get em hot |
| `sell` | dump that fool |
| `value` | we all wanna know |
| `options` | to the moon |
| `setticker` | what ya called |
| `marketrules` | how to win |
| `instructions` | how's this work? |
| `fish` | cast a line |
| `fishing` | biggest catches |
| `store` | sell ya fish |
| `adopt` | get a group pet |
| `pet` | check on the pet |
| `graveyard` | pets we've lost |

Register these with `setMyCommands`. A heredoc avoids fighting bash over the apostrophes in the descriptions:

```sh
curl "https://api.telegram.org/bot<TOKEN>/setMyCommands" \
  -H "Content-Type: application/json" \
  -d @- <<'EOF'
{"commands":[
  {"command":"wordle","description":"play ya game"},
  {"command":"portfolio","description":"see what ya got"},
  {"command":"market","description":"who's worth what"},
  {"command":"delist","description":"remove yourself from the market"},
  {"command":"scorecard","description":"see who drools"},
  {"command":"leaderboard","description":"see who rules"},
  {"command":"buy","description":"get em hot"},
  {"command":"sell","description":"dump that fool"},
  {"command":"value","description":"we all wanna know"},
  {"command":"options","description":"to the moon"},
  {"command":"setticker","description":"what ya called"},
  {"command":"marketrules","description":"how to win"},
  {"command":"instructions","description":"how's this work?"},
  {"command":"fish","description":"cast a line"},
  {"command":"fishing","description":"biggest catches"},
  {"command":"store","description":"sell ya fish"},
  {"command":"adopt","description":"get a group pet"},
  {"command":"pet","description":"check on the pet"},
  {"command":"graveyard","description":"pets we've lost"}
]}
EOF
```

Run it once per bot (test and prod use separate tokens, so separate calls) whenever the command list changes — it persists on Telegram's side, no redeploy needed.

Alternatively, do it via chat: message [@BotFather](https://t.me/BotFather) with `/setcommands`, pick your bot, then send the list as `command - description` lines (no leading slash):

```
wordle - play ya game
portfolio - see what ya got
market - who's worth what
delist - remove yourself from the market
scorecard - see who drools
leaderboard - see who rules
buy - get em hot
sell - dump that fool
value - we all wanna know
options - to the moon
setticker - what ya called
marketrules - how to win
instructions - how's this work?
fish - cast a line
fishing - biggest catches
store - sell ya fish
adopt - get a group pet
pet - check on the pet
graveyard - pets we've lost
```

### Invisible commands (do not register these)

Still real commands — grammY dispatches on `bot.command()` regardless of what's in the menu — just deliberately left out of `setMyCommands` so they don't clutter it for regular players.

| Command | What it does | Why it's hidden |
|---|---|---|
| `/reset` | Self-service: cash everyone out of your stock at today's price and start fresh | Redundant next to `/delist` in the menu — the people who need it already know it exists |
| `/restart` | Owner-only: wipes the entire chat's market — every player, holding, and price event, gone | Destructive and owner-only, no reason to advertise it |
| `/setmarketthread` | Owner-only: pins market announcements (trading halts, etc.) to whichever topic you run it in | Admin config, not gameplay |
| `/setoptionsguard` | Owner-only: `on`/`off` toggle for the anti-pump guard (blocks trading shares of anyone you hold an option on) | Admin config, not gameplay |
| `/stimulus` | Owner-only: `/stimulus <amount>` gives every active player in the market a flat cash injection | Destructive to game balance and owner-only, no reason to advertise it |
| `/fishingwindow` | Owner-only: `/fishingwindow <days>` or `/fishingwindow forever` sets how far back the fishing leaderboard looks (default forever). Applies retroactively, since every catch is kept | Admin config, not gameplay |
| `/resetfishing` | Owner-only: starts the fishing leaderboard over. Soft reset: earlier catches stay stored but stop counting; nobody's daily cast, waiting bonus, or bucket changes | Admin control, not gameplay |
| `/petkill` | Owner-only: puts the chat's pet down (posts its eulogy) — for mercy or testing | Destructive and owner-only |
| `/petrevive` | Owner-only: brings the most recently dead pet back at full food and mood, if no pet is alive — for when a bug killed it | Admin control, not gameplay |
| `/start` | Telegram's default entry point for a private chat — just replies "Fuck off big boi" | Not a real feature, just the obligatory handler |
| `/features` | Owner-only: turn features on/off for this chat. `/features` shows a button per feature; `/features <key> on\|off` does it by typing. Only shows bare keys and on/off in chat, never what a feature does. See [Feature switches](#feature-switches) | Admin control, not gameplay |

When adding a new command, put it in whichever list it belongs in — visible if a player should discover it via the `/` menu, invisible if it's admin-only or already implied by another command.

### Feature switches

Every feature can be turned on or off per chat by the owner, with `/features` run inside that chat. Turning a feature off makes it go completely quiet in that chat (commands, ambient replies, and its scheduled jobs) without deleting anything — turning it back on picks up where it left off.

| Key | Feature | What it covers | Default |
|---|---|---|---|
| `wordle` | Wordle Golf | Rounds, score submissions, nightly reminders | on |
| `market` | Stock market | Every market command, price tracking, and the market's scheduled jobs | on |
| `fishing` | Fishing | `/fish` (at most once a day; catches are best when you've waited 4+ days and the chat hasn't cast much yet today, since everyone shares one lake), the `/fishing` leaderboard (everyone's best catch), and the owner's fishing commands. Every fish caught goes into the catcher's hidden bucket, which is what the pet eats. Every tuning number is in `FISHING_CONFIG` in `src/fishing-math.ts`; `npm run sim:fishing` checks the odds after a change | on |
| `pet` | Group pet | One shared pet per chat: `/adopt`, the `/pet` card with Feed / Pet / Play buttons, `/graveyard`, the pet begging in `/fish` replies when it's hungry or lonely, and a scheduled warning when it's dying and its eulogy when it dies. While fishing is on, feeding costs one of your own fish (small, medium, or large; bigger fish fill it more). Switching it off freezes the pet rather than letting it starve. Every tuning number (how fast it gets hungry, cooldowns, how long until it dies) is in `src/pet-config.ts` | on |
| `store` | General store | The `/store` card: today's fish price, the latest sale or upgrade, and two buttons: Sell a fish (a random one from your bucket; the pop-up says which) and Open store, which opens the [store Mini App](#store-mini-app), where you pick which fish to sell, buy rods, boats and worms, and see your beans. Fish replies from `/fish` also get a Sell button that only the catcher can use. Rods mean bigger fish, boats soften the busy-lake penalty, and a worm halves the junk chance on your next cast. Gear only counts while the store is on. The money is beans, written with 🫘 as the currency sign (🫘18). A fish sells for its weight times the day's price per lb times a hidden multiplier for rare species. Selling and gear need `fishing` on too. Price numbers are in `STORE_CONFIG` in `src/store-math.ts`, gear in `src/gear.ts`, and `npm run sim:fishing` checks both | on |
| `beans` | Been/bean counter | Counts "been", posts the tally on "bean". Reply to that post with a question (anything with a "?") to get the bean count | on |
| `replies` | Talk-back | Replies when someone names the bot, replies to one of its jokes, or says "galen" | on |
| `eastereggs` | Easter eggs | Keyword jokes in normal conversation (gas, commute, raise, ...) | on |
| `spicy` | Spicy | The spank chain, the butthole replies, and the crudest easter-egg lines | on |

Always on, not switchable: `/start`, `/features` itself, and forwarding @-mentions and polls to the owner.

Only switches the owner has flipped are stored; everything else uses its default from `src/features.ts`. Checking them costs one Durable Object read per incoming message, no matter how many features there are.

**Adding a feature:** add an entry to `FEATURES` in `src/features.ts` (a new key, label, description, and default), then register its handlers in `src/bot.ts` with `this.gate("<key>", composer)` at the right point in the handler order. If it has scheduled jobs, have them skip chats where `(await storage.getChatFeatures(chatId)).<key>.enabled` is false. Keys are stored in the database and typed into `/features`, so never rename one.

---

## Everyday commands

| Task | Command |
|---|---|
| Local dev with public tunnel | `npx wrangler dev --tunnel` |
| Deploy | `npx wrangler deploy` |
| Deploy the dev Worker | `npm run deploy:dev` |
| Live production logs | `npx wrangler tail rude-bot` |
| Live dev logs | `npx wrangler tail rude-bot-dev` |
| Store Mini App tests | `npm run test:webapp` |
| List/update secrets | `npx wrangler secret list` / `npx wrangler secret put <NAME>` |
| Check webhook status | `curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"` |

