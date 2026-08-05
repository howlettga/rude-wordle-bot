# The full mechanics, as they stand

Earning price (organic activity) — all in `durable-objects/stock-market.ts`:

| Event | Base impact | Same-day decay |
|---|---|---|
| Your own message | +0.5 | `0.85^n` per message that day |
| A reply you receive | +2.0 (4x a message) | `0.85^s × 0.95^d` — `s` = replies today from *this* sender, `d` = distinct senders today so far (see below) |
| A reaction you receive | ±0.75 (mild) / ±1.5 (strong) / random ±1.5 (unlisted emoji) | `0.85^n` per reaction that day, total across everyone |
| Someone buys/sells your stock | ±4% of price per share | `0.85^t × 0.95^d` — `t` = trades today from *this* trader (buy or sell, either counts), `d` = distinct traders today so far — same shape as replies |

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

- **Conversation Terminator** — scoped **per forum topic**, and the only one of the two that's window/awake-hours-limited: it only evaluates between **10am and 10pm ET**, and only counts **awake hours** of silence — the 10pm–10am dead zone doesn't count at all, so a normal "good morning" message after a quiet night doesn't inherit a huge fake gap and trigger it. If the last message in *this* topic sat for 3+ awake-hours with nobody replying, its author gets paid `min($100, $10 × awake hours)`, and the bot **replies directly to that message** (not a fresh announcement) with one of several rude, randomized "you killed the conversation" lines. **Any genuine reaction on that last message blocks it outright** — a 👍 counts as real engagement even with zero text replies, so a reacted-to message can never be terminated.
- **Market Open** — stays **chat-wide** (not per-topic) and, unlike Terminator, is untouched by the awake-window/awake-hours logic: it can fire any hour of day or night, using the real raw gap. That's deliberate — "breaking the silence" is specifically supposed to mean breaking an *overnight* gap, so excluding overnight hours from its math would defeat the entire mechanic. Breaking a 6+ raw-hour silence anywhere in the chat pays the breaker a flat +$15, as a fresh (non-reply) announcement.

## Trading moves price now

- `/buy` / `/sell` clear against the house, and the trade itself moves the target's price — buying pushes it up, selling pushes it down, by the % impact in the table above (magnitude scales with share count, decays same-day like a reply does). **Both settle at the post-move price** — a buyer pays, and a seller receives, whatever the stock became worth *because of* their own order. This is deliberately symmetric: an earlier version paid sellers the price they last saw (pre-move) to avoid a "why did I get less than displayed" surprise, but since same-day repeat trades decay, that let anyone immediately buy back what they'd just sold for less than the sell paid out — a guaranteed, riskless profit on every sell-then-buy cycle. Settling both legs post-move closes that: round-tripping now nets zero (buy-then-sell) or a small guaranteed loss (sell-then-buy), never a gain.
- A trade that fails (insufficient cash, insufficient shares, target halted) never touches price — nothing is written unless the trade actually goes through.
- Trade-driven price changes go through the same gain-dampening and daily mean-reversion as every other price mover (see above) — no separate cap needed. Losses (including a sell's own price impact) always land at full strength, same as everywhere else in the market — only gains ever get dampened.
- Price has a hard floor of $1 (`MIN_PRICE`), so repeated selling can tank a stock but never make it literally free.

## Cash (spendable, never touches price on its own)

- **Weekly allowance**: +$100/week, everyone.
- **Random bonus**: 2% chance per message, $1 / $5 / $10 / $20.
- **Necromancy**: revive a 30+ day old message, +$25, once per message.
- **Trading**: cash moves hand-to-house at whatever price the trade settles at (see "Trading moves price now" above) — the cash side is just bookkeeping, the price side is the new mechanic.

## Admin

`/delist` (remove one player), `/restart` (wipe everyone), `/setmarketthread` (route Market Open's announcements).
