# The full mechanics, as they stand

Earning price (organic activity) — all in `durable-objects/stock-market.ts`:

| Event | Base impact | Same-day decay |
|---|---|---|
| Your own message | +0.5 | `0.85^n` per message that day |
| A reply you receive | +2.0 (4x a message) | `0.85^s × 0.95^d` — `s` = replies today from *this* sender, `d` = distinct senders today so far (see below) |
| A reaction you receive | ±0.75 (mild) / ±1.5 (strong) / random ±1.5 (unlisted emoji) | `0.85^n` per reaction that day, total across everyone |

**Reply decay is split in two**, unlike messages/reactions:
- Repeats from the *same* sender still decay at 0.85 — two people volleying replies back and forth all day can't pump a price just by not repeating a message, same anti-farm behavior as before.
- Each *new distinct* sender that day decays much more gently, at 0.95 — genuine breadth of attention (a lot of different people replying) is a much harder signal to fake than volume from one relationship, so it's allowed to keep compounding much further before flattening out. Ceiling if every reply today is from someone new: `2.0 / (1 - 0.95) = 40` points, vs. `2.0 / (1 - 0.85) = 13.33` if it's all one repeat sender.

## Keeping one leader from running away forever

- **Gain dampening** (`dampenGain`): once you're above the chat average, positive gains get cut. The raw cut would be `average / price` (at 2x average you'd keep 50%, at 4x you'd keep 25%, trending toward 0% the further ahead you get) — but `DAMPEN_SEVERITY = 0.75` scales that down to 75% as harsh, so the cut asymptotically approaches a 25% floor instead of trending toward nothing:

  | Your price | Kept |
  |---|---|
  | At/below average | 100% |
  | 2x average | 62.5% |
  | 4x average | 43.75% |
  | Way ahead | → 25% floor |

  Losses always land at full strength — no dampening on the way down, only the way up.

- **Daily mean reversion**: once a day (cron), everyone — active or not — gets pulled 5% of the remaining gap toward the chat average.
- **Trading halt**: once a day, 15% chance the current leader gets frozen for 24h (no price movement at all, can't be bought/sold) — but only if they're 100+ ahead of 2nd place. No reason ever given.

## Conversation Terminator & Market Open

Both are cash-only silence-gap payouts, evaluated only when a new message arrives (there's no polling/cron for these — a fully dead chat just never pays out again). Both guard against self-triggering — the same person can't post twice to farm either payout.

- **Conversation Terminator** — scoped **per forum topic**, and the only one of the two that's window/awake-hours-limited: it only evaluates between **8am and midnight ET**, and only counts **awake hours** of silence — the midnight–8am dead zone doesn't count at all, so a normal "good morning" message after a quiet night doesn't inherit a huge fake gap and trigger it. If the last message in *this* topic sat for 3+ awake-hours with nobody replying, its author gets paid `min($100, $10 × awake hours)`, and the bot **replies directly to that message** (not a fresh announcement) with one of several rude, randomized "you killed the conversation" lines. **Any genuine reaction on that last message blocks it outright** — a 👍 counts as real engagement even with zero text replies, so a reacted-to message can never be terminated.
- **Market Open** — stays **chat-wide** (not per-topic) and, unlike Terminator, is untouched by the awake-window/awake-hours logic: it can fire any hour of day or night, using the real raw gap. That's deliberate — "breaking the silence" is specifically supposed to mean breaking an *overnight* gap, so excluding overnight hours from its math would defeat the entire mechanic. Breaking a 6+ raw-hour silence anywhere in the chat pays the breaker a flat +$15, as a fresh (non-reply) announcement.

## Cash (spendable, never touches price)

- **Weekly allowance**: +$100/week, everyone.
- **Random bonus**: 2% chance per message, $1 / $5 / $10 / $20.
- **Necromancy**: revive a 30+ day old message, +$25, once per message.
- **Trading**: `/buy` / `/sell` clear against the house at the current listed price — trades themselves never move price (no peer-to-peer pump vector).

## Admin

`/delist` (remove one player), `/restart` (wipe everyone), `/setmarketthread` (route Market Open's announcements).
