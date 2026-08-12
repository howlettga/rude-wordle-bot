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

- **Daily mean reversion**: once a day (cron), everyone — active or not — gets pulled toward the chat average, but asymmetrically. Below-average players still snap up at the full `DAILY_DECAY_GRAVITY_UP = 0.05` (5% of the remaining gap/day). Above-average players only drift down at `DAILY_DECAY_GRAVITY_DOWN = 0.01` (1%/day) — a separating leader stays separated instead of getting yanked back to the pack every night, so the chat average itself can trend upward over time instead of just oscillating in place.
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

## Long call options (`/options`)

The beginning of a deeper feature — calls only for now (schema's ready for puts once the economy has an
engineered downside/crash mechanic to make betting *against* someone actually interesting). Entirely
cash-settled: never touches shares/holdings, no exercising, just an automatic payout at expiry.

`/options` walks a picker: which stock → expiration (**0 / 1 / 3 / 7 days**, real-DTE-style — "0D" settles
at the very next 5pm ET rollover) → strike (three OTM tiers, locked in at your current price the instant
you pick it — **the tiers themselves widen with duration**, since a flat 8% strike would be close to a
sure thing out at 7D) → a live quote → confirm. Premium is charged up front and is the absolute most you
can ever lose — long calls can't go negative by construction.

- **Strike menu** (`OPTION_STRIKES_BY_DURATION`), OTM %:

  |     | Conservative | Middle | Aggressive |
  |---|---|---|---|
  | 0D  | 8%  | 10% | 15% |
  | 1D  | 10% | 15% | 20% |
  | 3D  | 15% | 20% | 30% |
  | 7D  | 20% | 30% | 45% |

  Not recalibrated as part of the tuning below yet — pending a few days of real price data under the new
  asymmetric mean reversion above before touching strike distances themselves.

- **Premium**: `currentPrice × 0.05 × strikeTierMultiplier × durationMultiplier` (tier multiplier
  1.15 / 1.0 / 0.75 for conservative / middle / aggressive; duration multiplier 0.4 / 0.6 / 1.0 / 1.7 for
  0D / 1D / 3D / 7D), floored at $0.50. As a % of current price:

  |              | 0D    | 1D    | 3D    | 7D    |
  |---|---|---|---|---|
  | Conservative | 2.30% | 3.45% | 5.75% | 9.78% |
  | Middle       | 2.00% | 3.00% | 5.00% | 8.50% |
  | Aggressive   | 1.50% | 2.25% | 3.75% | 6.38% |

  Deliberately small relative to the strike distances above — true break-even is `strikePrice + premium`,
  not just `strikePrice`, so a bloated premium made clearing the strike *feel* like a win while still being
  a net loss (a $80 premium reduced to a $10 payout was still a $70 loss). At this rate, break-even sits
  roughly 1.3%–8.2% past the strike itself, not the 4%–24% the old flat-15%-base-rate formula produced.

- **Settlement is always anchored to 5pm ET** (a new daily cron, same boundary `TRADING_DAY_START` already
  defines) — not N raw hours after purchase. That means actual runway varies by time of day: buy right
  after 5pm ET and a "1D" contract gets nearly a full 24h; buy right before and it settles almost
  immediately. Every contract due settles in one batch, across every chat, with one summary message per
  chat (not one per contract) win-or-worthless, in the bot's usual rude/randomized voice.
- **Payout**: `max(0, settlementPrice − strikePrice) × payoutLeverage`, where `payoutLeverage`
  (`OPTION_PAYOUT_LEVERAGE_BY_TIER`) is 1.0 / 1.4 / 2.0 for conservative / middle / aggressive strikes —
  the cheaper/further-OTM the strike, the bigger a multiple of the raw ITM difference it pays out when it
  lands, same shape as a real option's leverage curve. Below or at strike, it expires worthless — you lose
  the premium and nothing else.
- **Delisting/resetting the underlying force-settles any open option against them early**, at their price
  at that exact moment, using the same `computeOptionPayout` formula — a buyer never just loses their
  premium to someone else's removal with zero chance to win.

**Self-pumping your own bet is allowed by default.** Buying now moves price directly (see the table up
top), so buying a call and then placing one big `/buy` order on the same person can push their price
straight through your strike — that's treated as a feature (chaos, self-pumping is part of the fun), not a
bug. If it gets out of hand in a given chat, `/setoptionsguard on` (owner-only) blocks anyone from trading
shares of someone they're currently holding an open option on, in either direction; `/setoptionsguard off`
reverts to the default.

## Cash (spendable, never touches price on its own)

- **Weekly allowance**: +$100/week, everyone.
- **Random bonus**: 2% chance per message, $1 / $5 / $10 / $20.
- **Necromancy**: revive a 30+ day old message, +$25, once per message.
- **Trading**: cash moves hand-to-house at whatever price the trade settles at (see "Trading moves price now" above) — the cash side is just bookkeeping, the price side is the new mechanic.
- **Options**: premium is charged up front on purchase; payout (if any) is credited at settlement — see "Long call options" above.

## Admin

`/delist` (permanently remove one player, cashing out their holders and force-settling any open options against them), `/reset` (same, but non-permanent — they're back the next time they post), `/restart` (wipe everyone), `/setmarketthread` (route Market Open's announcements), `/setoptionsguard on|off` (toggle the anti-self-pump guard for options, off by default). `/delist` and `/reset` also work as self-service, confirmation-gated commands for anyone targeting themselves.
