# rude-bot

A Telegram bot built with [grammY](https://grammy.dev), deployed as a Cloudflare Worker. No always-on server, no polling — Telegram delivers updates straight to the Worker via webhook.

## How it's structured

- `src/main.ts` — the Worker entrypoint (`fetch` handler). Builds the bot from env-provided secrets and hands the request to grammY's webhook adapter.
- `src/bot.ts` — the `RudeBot` class. All commands/handlers get registered here.
- `wrangler.jsonc` — Worker config (name, entrypoint, compatibility date).

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
```

Deploy:

```sh
npx wrangler deploy
```

This prints the live `https://rude-bot.<subdomain>.workers.dev` URL. Register it with Telegram as in step 4, using the real bot's token.

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
| `setticker` | what ya called? |
| `marketrules` | how to win |
| `instructions` | how's this work? |

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
  {"command":"setticker","description":"what ya called?"},
  {"command":"marketrules","description":"how to win"},
  {"command":"instructions","description":"how's this work?"}
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
setticker - what ya called?
marketrules - how to win
instructions - how's this work?
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
| `/start` | Telegram's default entry point for a private chat — just replies "Fuck off big boi" | Not a real feature, just the obligatory handler |

When adding a new command, put it in whichever list it belongs in — visible if a player should discover it via the `/` menu, invisible if it's admin-only or already implied by another command.

---

## Everyday commands

| Task | Command |
|---|---|
| Local dev with public tunnel | `npx wrangler dev --tunnel` |
| Deploy | `npx wrangler deploy` |
| Live production logs | `npx wrangler tail rude-bot` |
| List/update secrets | `npx wrangler secret list` / `npx wrangler secret put <NAME>` |
| Check webhook status | `curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"` |

