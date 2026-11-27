# Release Notes

## Unreleased - General Store

- Pet fund: the chat pools beans in the store page toward room for another pet. Goals of 🫘100, 🫘750, and 🫘2,500 unlock a 2nd, 3rd, and 4th pet slot, and reaching one posts a thank-you to the top 3 donors. `/adopt` works while there's a free slot.
- Several pets at once: `/pet` shows a summary with a button to check on each pet, and each pet's card has ◀ All pets to go back. The neediest pet begs in `/fish` replies, and `/petkill` takes a name when there's more than one.

- New `/store` card: one shared message with two buttons. **Sell a fish** sells a random fish from your bucket for beans (the pop-up tells you which one). **Open store** opens the store page.
- The store page (a Telegram Mini App) opens over the chat: your whole bucket, today's price, your beans, gear, and worms. Pick exactly which fish to sell, or buy gear, and nothing gets posted in the group. The card's latest-activity line updates when you do.
- Every fish reply from `/fish` gets a Sell button that only the catcher can use. Selling edits the reply in place.
- Fish prices change day to day (turning over at 5am ET with the fishing day), and rare species pay more.
- One new rare species per weight band, about 1 catch in 10: goldfish, blobfish, koi, electric eel, alligator gar, and coelacanth. Anything from 40 lb up can very occasionally be a megalodon (about 1 fish in 1,500), the rarest and most valuable catch.
- Gear: rods (Basic → Fiberglass → Carbon → Legendary) for bigger fish (each catch is rolled more than once and the biggest kept: a Legendary rod's typical fish is nearly twice as big), boats (Inner tube → Rowboat → Bass boat → Yacht) to fish away from a busy lake, and worms that halve the junk on your next cast, all bought in the store page.
- A new `store` feature switch, on by default.
- Message in a bottle: pay 🫘5 in the store page to throw an anonymous note out to sea (close to shore, past the buoys, or out to sea, for 1 day to 2 weeks of hidden drifting). Once it washes up, someone else's `/fish` has a 35% chance of reeling it in instead of a fish and reading it to the chat. At most 5 of yours in the water at once. The card says when someone throws one, never who. Owner-only `/bottles`, `/bottlepull`, and `/bottlewho` moderate them from the owner's private chat.

## Fishing v2

- Fishing math rebuilt around a single cast quality: how long since your last cast (full strength from 4 days on; casting daily is a mild penalty instead of a 60%-junk, 0.1 lb grind), the hidden tide, and how many casts the whole chat has already made today. The first few casts of the day get a bonus; past about the 5th, the lake is fished out for everyone. Typical fish are bigger, so the old leaderboard is beatable; tuning lives in `FISHING_CONFIG`, checked by `npm run sim:fishing`.
- Every `/fish` reply says how busy the lake is today, and a poor catch can say why (your spot, or a low tide).
- `/fishing` shows everyone, not just the top 10.
- The fishing day (your one cast, the lake count, and the tide) now turns over at 5am ET instead of midnight (`DAY_STARTS_HOUR_ET`).
- Every fish caught now goes into the catcher's hidden bucket, including everything caught before this release. The leaderboard is unaffected by what happens to a fish afterwards.
- The pet eats fish: the Feed button is now Small / Medium / Large, taking that size from your own bucket, and bigger fish fill it more. An empty bucket gets turned away. With fishing switched off, feeding works as before.
- The pet no longer posts hungry/starving/miserable warnings on its own; it begs in people's `/fish` replies instead. The "it's dying" warning and the eulogy still post.
- New pet trick: Drive a car. Every time the pet performs it there's a 33% chance it crashes and dies (`CAR_CRASH_CHANCE`).
- A pet that learned Parallel park before Drive a car botches it every time: a collision, a lawsuit, and -90 mood (`PARKING_LAWSUIT_MOOD`).

## 2.1.0 - Storage features

- Added a Durable Object–backed `StorageService`, replacing the old KV counter with strongly-consistent per-chat state (KV's eventual consistency could otherwise let fast-fired counters/chains silently miss a write).
- `been`/`beens` counter is now scoped per-chat instead of per-user, counts every occurrence in a single message rather than one per trigger, and replies with a randomly-picked photo instead of plain text.
- Added a "spank chain": `bad bot` starts it, and replying to the bot's own message in the chain with a spank-themed emoji (😈🍑✋👋👏) continues it indefinitely. The active chain tail is tracked per-chat via a new `SpankChain` Durable Object.
- Added a general fallback: replying to any bot message that wasn't already handled by a more specific trigger now gets a random retort from a new `GENERAL_RETORT` pool.
- Expanded the `SPANK` reply pool and added `GENERAL_RETORT` in `replies.ts`.

## 2.0.0 — Rude Bot v2 release

- Rewritten as a Cloudflare Worker (grammY + webhook delivery), replacing the original always-on Express/GCP deployment.
- Mention matching switched from Telegram username to user ID, since usernames aren't guaranteed to be set.
- Easter egg replies and round/score commands carried over from the original bot.
