# Release Notes

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
