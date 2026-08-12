import { DurableObject } from "cloudflare:workers";
import type { Env } from "../main.js";

const STARTING_PRICE = 100;
const STARTING_CASH = 500;
const WEEKLY_ALLOWANCE = 100;

// Your own messages move your price a little; replies you get from someone else move it a lot more, since
// that's an external signal rather than something you can just spam your way to. Both decay per-occurrence
// today so neither can be pumped by volume alone — messages and reactions (see recordMessage/recordReaction)
// decay by TOTAL received today regardless of who sent them.
//
// Replies (see recordReply) split into two exponents instead of one: repeats from the SAME sender still
// decay at IMPACT_DECAY, same rate as messages/reactions, so two people volleying replies back and forth
// all day can't pump a price just because no single person repeated a message. But each NEW distinct
// sender today decays at the much gentler DISTINCT_SENDER_DECAY instead — genuine breadth of attention
// (a lot of different people replying) is a much harder signal to fake than volume from any one relationship,
// so it's allowed to keep compounding much further before flattening out.
const MESSAGE_BASE_IMPACT = 0.5;
const REPLY_BASE_IMPACT = 2.0;
const IMPACT_DECAY = 0.85;
const DISTINCT_SENDER_DECAY = 0.95;

// Trading moves price too, same decay shape as replies above: buying/selling repeatedly against the same
// counterparty today decays fast at IMPACT_DECAY (can't pump/dump a stock alone), while distinct traders
// hitting the same stock today decay gently at DISTINCT_SENDER_DECAY (real breadth of buying/selling
// pressure is a harder signal to fake than volume from one relationship). 4% of price per share, before
// decay — a typical 1-2 share order moves price a few percent, a max ~4-share order noticeably more.
const TRADE_BASE_IMPACT_PCT = 0.04;

// Long call options — cash-settled bets on someone's price, never touching shares/holdings. Premium is
// currentPrice * OPTION_PREMIUM_BASE_RATE * strikeTierMultiplier * durationMultiplier. 'call' is the only
// allowed type today; 'put' can land later via the same rebuild-the-table technique migration 10 above
// already used for adding 'trade' to price_events — the schema doesn't need to change for that.
// Deliberately small relative to the strike distances below: a big base rate makes the real break-even
// price (strike + premium) land far past the strike itself, so "making the strike" barely dents a loss
// instead of feeling like a win. See computeOptionPayout for the other half of that fix.
const OPTION_PREMIUM_BASE_RATE = 0.05;

// Each duration offers its own three strikes, scaled up for longer durations — this bot's daily mean
// reversion (DAILY_DECAY_GRAVITY_UP/DOWN) and gain-dampening (dampenGain) resist runaway compounding, but
// not enough to keep a flat 8% strike meaningful out past a single session: observed 1-day moves average
// ~8% (with real spread — some 20%+, some under), so an 8% strike offered unchanged at 7D would be close
// to a sure thing instead of a real bet. Scaling the menu keeps each duration's "middle" tier feeling like
// roughly a coinflip instead of decaying into free money as duration grows. Not recalibrated alongside the
// premium/payout tuning above — that's pending a few days of real price_events data under the new,
// less-aggressive daily decay before touching strike distances themselves.
const OPTION_STRIKES_BY_DURATION: Record<StockMarketOptionDurationDays, readonly [StockMarketOptionStrikePct, StockMarketOptionStrikePct, StockMarketOptionStrikePct]> = {
  0: [0.08, 0.1, 0.15],
  1: [0.1, 0.15, 0.2],
  3: [0.15, 0.2, 0.3],
  7: [0.2, 0.3, 0.45],
};

// Applied by TIER POSITION (conservative/middle/aggressive) within whichever duration's three strikes are
// in play, not by the raw percentage — the same percentage can be one duration's aggressive tier and
// another's conservative tier (e.g. 15% is 0D's riskiest strike but 3D's safest), so a flat lookup keyed
// by percentage can't express this. Closer-to-ATM (conservative, more likely ITM) costs more; further OTM
// (aggressive, less likely) costs less — same shape as real options pricing.
const OPTION_STRIKE_TIER_MULTIPLIERS: readonly [number, number, number] = [1.15, 1.0, 0.75];

// Also keyed by TIER POSITION, same convention as OPTION_STRIKE_TIER_MULTIPLIERS above — but this scales
// the PAYOUT, not the premium. A further-OTM/cheaper strike is less likely to land, so when it does, it
// pays out a multiple of the raw settlementPrice-strikePrice difference instead of a flat 1:1 — same shape
// as real options, where a far-OTM contract's low delta at purchase becomes high leverage once it's deep
// ITM. Conservative/closest-to-ATM stays flat 1:1 since it's already the safest, cheapest-cushion bet.
const OPTION_PAYOUT_LEVERAGE_BY_TIER: readonly [number, number, number] = [1.0, 1.4, 2.0];

// Keyed by the real-DTE-style label the user picks (0/1/3/7), not the raw day-offset used in the actual
// expiry math — see quoteOption/buyOption's "+1" for why those two numbers deliberately differ by one
// session. 0 reuses what used to be the only "1-day" tier's multiplier verbatim (same underlying math,
// just renamed to match real 0DTE convention); 1 is a genuinely new tier, interpolated between 0 and 3
// along the existing progression's rough slope; 3 and 7 keep their pre-existing values even though their
// underlying runway is now one session longer — recalibrating those isn't part of this change.
const OPTION_DURATION_MULTIPLIERS: Record<StockMarketOptionDurationDays, number> = { 0: 0.4, 1: 0.6, 3: 1.0, 7: 1.7 };
const VALID_OPTION_DURATION_DAYS: readonly StockMarketOptionDurationDays[] = [0, 1, 3, 7];
const OPTION_RETENTION_DAYS = 180;
// Guards a near-$0 underlying producing a near-free, only-upside contract.
const MINIMUM_OPTION_PREMIUM = 0.5;

// Floor for the price column. Was implicitly 0 (see applyPriceChange's old MAX(0, ...)) — now that selling
// can drag a price down repeatedly in one day, a hard 0 would let a stock go permanently free to buy, which
// breaks the cash-affordability check rather than just being a "cheap stock" outcome.
const MIN_PRICE = 1;

// How much of the theoretical full dampening (see dampenGain) actually applies — 1.0 would be the raw
// average/price cut, trending toward keeping ~0% of a gain the further above average you get. 0.75 keeps
// that scaled down to 75% as severe, so the cut asymptotically approaches keeping a 25% floor of any gain
// instead of trending toward nothing.
const DAMPEN_SEVERITY = 0.75;

// Two mechanisms keep the market from being permanently dominated by whoever's most active/popular, on
// top of the same-day decay above (which only throttles a single day's spam, not growth across days):
//   1. Daily mean reversion (applyDailyDecay) pulls EVERY player toward the chat average each day, not
//      just the inactive — being active still earns on top of this, but no longer exempts you from it.
//      The pull is asymmetric: below-average players snap up at the full rate (keeps laggards
//      relevant), but above-average players only drift down gently, so a separating leader stays
//      separated instead of getting yanked back to the pack every night — the market average itself
//      can trend upward over time instead of just oscillating in place.
//   2. Gain dampening (applyPriceChange -> dampenGain) shrinks GAINS (never losses) once a player is
//      already above the average, proportional to how far ahead they are — easier to fall than to keep
//      climbing once you're on top, without a hard cap.
const DAILY_DECAY_GRAVITY_UP = 0.05;
const DAILY_DECAY_GRAVITY_DOWN = 0.01;

// Each day, a 15% chance the current leader (highest price, among anyone not already halted) gets a
// 24-hour trading halt — "pending review of irregular activity," and that's the only explanation anyone
// ever gets. Purely a market mechanic: the stock can't be bought or sold and its price freezes (see
// applyPriceChange) until the halt lifts, but the person can talk in the chat completely normally. Only
// even eligible once they've pulled at least HALT_LEAD_THRESHOLD ahead of second place — a narrow lead
// isn't "irregular activity," so there's nothing to roll the dice for until the gap actually looks
// suspicious.
const HALT_DAILY_CHANCE = 0.15;
const HALT_DURATION_HOURS = 24;
const HALT_LEAD_THRESHOLD = 100;

// The "trading day" rolls over at 5pm ET (21:00 UTC, optimized for EDT — same DST-drift tradeoff as the
// cron triggers in wrangler.jsonc, landing at 4pm EST once winter hits) rather than UTC midnight, so it
// means something to whoever's actually reading it instead of an arbitrary UTC hour. Used everywhere
// "today" matters here: diminishing returns on repeat messages/reactions/replies, the decay job's
// had-activity check, and the daily price change shown in /market and /portfolio — all one boundary, not
// several different ones, so "today" doesn't quietly mean different things in different queries.
//
// datetime('now', '-21 hours', 'start of day', '+21 hours') works by shifting back past the boundary,
// truncating to UTC midnight of that shifted day, then shifting forward the same amount — landing on the
// most recent 21:00 UTC at or before now. E.g. "now" = 22:30 UTC -> -21h = 01:30 UTC (same day) -> start
// of day = 00:00 UTC (same day) -> +21h = 21:00 UTC (same day, before now, so that's today's boundary).
// "now" = 10:00 UTC -> -21h = 13:00 UTC (previous day) -> start of day = 00:00 UTC (previous day) -> +21h
// = 21:00 UTC (previous day, since 10:00 UTC hasn't reached today's 21:00 UTC rollover yet).
const TRADING_DAY_START = `datetime('now', '-21 hours', 'start of day', '+21 hours')`;

// message_authors only exists to resolve a reaction back to who wrote the reacted-to message, and
// price_events doubles as an audit trail (only "today"'s rows are ever queried for the decay math above,
// via TRADING_DAY_START — nothing ever reads further back than that for any live computation). These used
// to be generous (60/180 days) on the theory that storage cost was negligible either way — but rows READ,
// not storage, turned out to be the actual constraint (see migration 15's indexes, the real fix for that),
// and every extra day of retention is extra rows any unindexed or partially-indexed query scans through.
// Trimmed down as a secondary, complementary measure now that the indexing is in place.
const MESSAGE_AUTHOR_RETENTION_DAYS = 30;
const PRICE_EVENT_RETENTION_DAYS = 30;

// Emoji with unambiguous sentiment get a fixed weight; everything else (🗿🌚🍌 etc. — anything not listed
// below) still moves price, just unpredictably — see randomMemeWeight.
const REACTION_WEIGHTS: Record<string, number> = {
  // Strong positive
  "🔥": 1.5,
  "😂": 1.5,
  "❤": 1.5,
  "🥰": 1.5,
  "😍": 1.5,
  "🏆": 1.5,
  "💯": 1.5,
  "🤩": 1.5,
  "😘": 1.5,
  "💘": 1.5,
  "🎉": 1.5,
  // Mild positive
  "👍": 0.75,
  "👏": 0.75,
  "🤝": 0.75,
  "🙏": 0.75,
  "😁": 0.75,
  "🤗": 0.75,
  "🫡": 0.75,
  "😭": 0.75,
  "✍": 0.75,
  "👌": 0.75,
  "😎": 0.75,
  // Mild negative
  "😢": -0.25,
  "👎": -0.75,
  "💔": -0.75,
  "😱": -0.75,
  "🥴": -0.75,
  // Strong negative
  "🤡": -1.5,
  "🤮": -1.5,
  "💩": -1.5,
  "🖕": -1.5,
  "😡": -1.5,
  "🤬": -1.5,
};

export interface StockMarketPlayer {
  userId: number;
  username: string | null;
  ticker: string | null;
  firstName: string;
  price: number;
  cash: number;
  dailyChange: number; // sum of this trading day's (since TRADING_DAY_START) price_events deltas — can be negative
  isHalted: boolean; // trading halted (see rollHalt) — can't be bought or sold, price frozen, until it lifts
}

export interface StockMarketHolding {
  stockUserId: number;
  username: string | null;
  ticker: string | null;
  firstName: string;
  shares: number;
  price: number;
  value: number;
  dailyChange: number; // the held stock's own daily change, same meaning as StockMarketPlayer.dailyChange
  isHalted: boolean; // same meaning as StockMarketPlayer.isHalted, for the held stock
}

// An option this player BOUGHT that hasn't settled yet — never one they're the underlying of (that's not
// "theirs" to see here any more than someone else's /buy order on your stock shows up in your portfolio).
// currentPrice rides along so /portfolio can show how far ITM/OTM it currently is without a second query.
export interface StockMarketOpenOption {
  optionId: number;
  underlyingUserId: number;
  underlyingTicker: string | null;
  underlyingFirstName: string;
  strikePrice: number;
  currentPrice: number;
  isHalted: boolean; // same meaning as StockMarketPlayer.isHalted, for the underlying
  expiresAtEpochSec: number;
  nowEpochSec: number;
}

export type StockMarketSetTickerResult = "OK" | "NOT_A_PLAYER" | "TAKEN";

type PriceEventReason = "message" | "reply" | "reaction" | "decay" | "trade";

export type StockMarketOptionStrikePct = 0.08 | 0.1 | 0.15 | 0.2 | 0.3 | 0.45;
export type StockMarketOptionDurationDays = 0 | 1 | 3 | 7;

export interface StockMarketPortfolio extends StockMarketPlayer {
  holdings: StockMarketHolding[];
  openOptions: StockMarketOpenOption[];
}

export type StockMarketTradeErrorType =
  | "INVALID_AMOUNT"
  | "CANNOT_TRADE_SELF"
  | "UNKNOWN_STOCK"
  | "INSUFFICIENT_CASH"
  | "INSUFFICIENT_SHARES"
  | "HALTED"
  | "BLOCKED"
  // Only possible when the per-chat anti-pump guard (/setoptionsguard) is on — see buy()/sell()'s
  // hasOpenOptionAgainst check and getOptionsSelfPumpGuard.
  | "OPTIONS_CONFLICT";

export type StockMarketTradeResult =
  | { ok: true; shares: number; price: number; total: number; totalShares: number }
  | { ok: false; type: StockMarketTradeErrorType };

export interface StockMarketOptionQuote {
  underlyingPrice: number;
  strikePrice: number;
  premium: number;
  expiresAtEpochSec: number;
  nowEpochSec: number;
}

// BLOCKED added on top of feature/options' original set — buyOption used to be reachable by a
// /delist'ed user the same way buy() was before it gained the isBlocked check (see buyOption below).
export type StockMarketBuyOptionErrorType = "INVALID_TERMS" | "CANNOT_TRADE_SELF" | "UNKNOWN_STOCK" | "HALTED" | "INSUFFICIENT_CASH" | "BLOCKED";

export type StockMarketBuyOptionResult =
  | {
      ok: true;
      optionId: number;
      underlyingUserId: number;
      underlyingPriceAtPurchase: number;
      strikePrice: number;
      premium: number;
      expiresAtEpochSec: number;
    }
  | { ok: false; type: StockMarketBuyOptionErrorType };

export interface StockMarketOptionSettlement {
  optionId: number;
  buyerUserId: number;
  buyerFirstName: string;
  buyerTicker: string | null;
  underlyingUserId: number;
  underlyingFirstName: string;
  underlyingTicker: string | null;
  strikePrice: number;
  settlementPrice: number;
  payout: number; // 0 means expired worthless
}

interface PlayerRow {
  [column: string]: SqlStorageValue;
  user_id: number;
  username: string | null;
  ticker: string | null;
  first_name: string;
  price: number;
  cash: number;
  halted_until: string | null;
}

// Deliberately not exposed as a raw halted_until string on the public interfaces — comparing SQLite's
// space-separated UTC datetime strings against a JS Date is a timezone footgun (some environments parse
// them as local time). Every "is this halted" check happens in SQL instead (isHaltedNow, isHalted below)
// and only the resulting boolean ever crosses into TypeScript.
function toPlayer(row: PlayerRow, dailyChange: number, isHalted: boolean): StockMarketPlayer {
  return {
    userId: row.user_id,
    username: row.username,
    ticker: row.ticker,
    firstName: row.first_name,
    price: row.price,
    cash: row.cash,
    dailyChange,
    isHalted,
  };
}

// A fresh coin flip every time, not a fixed weight per emoji — 🗿 doesn't become "the cursed one", it's just
// unpredictable, matching the joke spirit of reactions with no clear sentiment.
function randomMemeWeight(): number {
  return (Math.random() * 2 - 1) * 1.5;
}

// One instance per chat, same pattern as WordleGolf — every member's stock, holdings, and price-moving
// activity for this chat lives in one place so leaderboard/portfolio queries are a single local join.
export class StockMarket extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.migrate();
  }

  // DO SQLite has no PRAGMA user_version, so schema version is tracked in its own table instead. Needed
  // because CREATE TABLE IF NOT EXISTS is a no-op against an already-existing table — changing a column's
  // CHECK constraint (like adding 'reaction' below) requires an actual migration, not just editing the DDL
  // string, or every already-running instance keeps enforcing the old constraint forever.
  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    const version = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; version: number }>(`SELECT COALESCE(MAX(id), 0) as version FROM _schema_migrations`)
      .one().version;

    if (version < 1) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS players (
          user_id INTEGER PRIMARY KEY,
          username TEXT,
          first_name TEXT NOT NULL,
          price REAL NOT NULL DEFAULT ${STARTING_PRICE},
          cash REAL NOT NULL DEFAULT ${STARTING_CASH},
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS holdings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          owner_user_id INTEGER NOT NULL REFERENCES players(user_id),
          stock_user_id INTEGER NOT NULL REFERENCES players(user_id),
          shares INTEGER NOT NULL DEFAULT 0,
          UNIQUE(owner_user_id, stock_user_id)
        )
      `);
      // reason: 'message' (own post) or 'decay' (daily gravity) at this version — 'reply'/'reaction' land in
      // migration 2 below. counterparty_user_id is the other person for those, used for pairwise decay.
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS price_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES players(user_id),
          counterparty_user_id INTEGER,
          reason TEXT NOT NULL CHECK (reason IN ('message', 'reply', 'decay')),
          delta REAL NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (1)`);
    }

    if (version < 2) {
      // SQLite can't alter a CHECK constraint in place — rebuild the table with 'reaction' added.
      this.ctx.storage.sql.exec(`
        CREATE TABLE price_events_v2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES players(user_id),
          counterparty_user_id INTEGER,
          reason TEXT NOT NULL CHECK (reason IN ('message', 'reply', 'reaction', 'decay')),
          delta REAL NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      this.ctx.storage.sql.exec(`INSERT INTO price_events_v2 SELECT * FROM price_events`);
      this.ctx.storage.sql.exec(`DROP TABLE price_events`);
      this.ctx.storage.sql.exec(`ALTER TABLE price_events_v2 RENAME TO price_events`);

      // Telegram's message_reaction updates only give a message_id, never who wrote it — this is how we
      // resolve a reaction back to whose stock it should move.
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS message_authors (
          message_id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES players(user_id)
        )
      `);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (2)`);
    }

    if (version < 3) {
      // Adds created_at so purgeOldData (below) can age out rows. Existing rows backfill to "now" via the
      // column default — harmless, it just delays their purge eligibility rather than losing anything.
      this.ctx.storage.sql.exec(`
        CREATE TABLE message_authors_v3 (
          message_id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES players(user_id),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      this.ctx.storage.sql.exec(`INSERT INTO message_authors_v3 (message_id, user_id) SELECT message_id, user_id FROM message_authors`);
      this.ctx.storage.sql.exec(`DROP TABLE message_authors`);
      this.ctx.storage.sql.exec(`ALTER TABLE message_authors_v3 RENAME TO message_authors`);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (3)`);
    }

    if (version < 4) {
      // Plain ADD COLUMN is enough here (unlike the price_events rebuilds above) since there's no CHECK
      // constraint involved. SQLite won't let ADD COLUMN declare UNIQUE directly, so that's enforced via
      // a separate index instead — which also means multiple NULL tickers (the common case: nobody's set
      // one yet) are allowed side by side, since SQL treats NULLs as distinct for uniqueness purposes.
      this.ctx.storage.sql.exec(`ALTER TABLE players ADD COLUMN ticker TEXT`);
      this.ctx.storage.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_players_ticker ON players(ticker)`);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (4)`);
    }

    if (version < 5) {
      // NULL means never halted / halt has lifted — "currently halted" is always computed as
      // halted_until IS NOT NULL AND halted_until > datetime('now'), never a separate boolean flag, so
      // there's nothing to remember to clear when a halt expires.
      this.ctx.storage.sql.exec(`ALTER TABLE players ADD COLUMN halted_until TEXT`);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (5)`);
    }

    if (version < 6) {
      // Single-row settings table (same id=1 upsert pattern as SpankChain's chain table) — currently just
      // holds which forum topic cron-driven market announcements (the halt announcement, and any future
      // ones) should post into, instead of always landing in the General topic. NULL means no preference set.
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS market_settings (
          id INTEGER PRIMARY KEY,
          announcement_thread_id INTEGER
        )
      `);
      this.ctx.storage.sql.exec(`INSERT INTO market_settings (id, announcement_thread_id) VALUES (1, NULL) ON CONFLICT(id) DO NOTHING`);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (6)`);
    }

    if (version < 7) {
      // Anti-farming for the Necromancy payout (see claimNecromancy) — first person to reply to a given
      // old message claims it; replying to the same one again pays nothing. No CHECK constraint, so a
      // plain create is enough.
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS necromancy_claims (
          message_id INTEGER PRIMARY KEY,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (7)`);
    }

    if (version < 8) {
      // Lets Conversation Terminator scope "the last message" per forum topic instead of chat-wide (see
      // getThreadSilenceGap) — a topic going quiet is its own event, distinct from the rest of the chat
      // being active. NULL means the General/no-topic chat, same convention as halted_until's "NULL means
      // not halted".
      this.ctx.storage.sql.exec(`ALTER TABLE message_authors ADD COLUMN thread_id INTEGER`);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (8)`);
    }

    if (version < 9) {
      // Lets Conversation Terminator treat "somebody reacted to it" as real engagement even without a
      // text reply — see recordReaction and getThreadSilenceGap's has_reaction. NULL means never reacted
      // to (only genuine, non-self reactions set this — same guard recordReaction already applies to
      // price movement).
      this.ctx.storage.sql.exec(`ALTER TABLE message_authors ADD COLUMN last_reacted_at TEXT`);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (9)`);
    }

    if (version < 10) {
      // Same rebuild-for-CHECK-constraint pattern as migration 2 — trades now move price (see buy/sell
      // below), so they need their own price_events reason alongside message/reply/reaction/decay.
      this.ctx.storage.sql.exec(`
        CREATE TABLE price_events_v10 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES players(user_id),
          counterparty_user_id INTEGER,
          reason TEXT NOT NULL CHECK (reason IN ('message', 'reply', 'reaction', 'decay', 'trade')),
          delta REAL NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      this.ctx.storage.sql.exec(`INSERT INTO price_events_v10 SELECT * FROM price_events`);
      this.ctx.storage.sql.exec(`DROP TABLE price_events`);
      this.ctx.storage.sql.exec(`ALTER TABLE price_events_v10 RENAME TO price_events`);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (10)`);
    }

    if (version < 11) {
      // Survives independently of the players row (which /delist deletes outright, same as /reset) — a
      // block has to outlive the very row whose re-creation it's meant to prevent. Kept separate from
      // players.halted_until on purpose: that's a temporary, market-driven freeze (see rollHalt) that
      // still shows up in /market; this is a permanent, owner/self-driven opt-out that means "no row at
      // all," checked by isBlocked before upsertPlayer ever gets a chance to recreate one.
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS blocked_players (
          user_id INTEGER PRIMARY KEY,
          blocked_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (11)`);
    }

    if (version < 12) {
      // Drops the REFERENCES players(user_id) constraint message_authors has carried since migration 2 —
      // deletePlayerRow used to have to delete a removed player's rows here just to satisfy that FK before
      // it could delete their players row, but message_authors doubles as getChatSilenceGap/
      // getThreadSilenceGap's "when did anyone last post" ledger (see checkSilenceEvents), and wiping a
      // recently-active player's own rows out from under it made their very next post look like it broke a
      // long silence — Market Open/Terminator firing off a false positive right when someone resets or
      // delists themselves back in. recordReaction now guards the FK that used to be implicit here (see
      // its existence check) instead, so rows survive removal same as any other message history, and only
      // age out via the existing MESSAGE_AUTHOR_RETENTION_DAYS purge.
      this.ctx.storage.sql.exec(`
        CREATE TABLE message_authors_v12 (
          message_id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          thread_id INTEGER,
          last_reacted_at TEXT
        )
      `);
      this.ctx.storage.sql.exec(`INSERT INTO message_authors_v12 SELECT * FROM message_authors`);
      this.ctx.storage.sql.exec(`DROP TABLE message_authors`);
      this.ctx.storage.sql.exec(`ALTER TABLE message_authors_v12 RENAME TO message_authors`);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (12)`);
    }

    if (version < 13) {
      // Long call options (see buyOption/settleExpiredOptions) — cash-settled bets on someone's price,
      // completely separate from holdings/shares. 'type' stays CHECK-constrained to 'call' for now; 'put'
      // lands later via the same rebuild-table technique migration 10 above already used, not a redesign.
      // strike_pct/duration_days/underlying_price_at_purchase are kept alongside the derived
      // strike_price/expires_at so a future "my open options" view can show the original terms without
      // trying to back-compute a percent against the underlying's CURRENT (since-moved) price. NULL
      // settled_at means still open, same convention as halted_until's "NULL means not halted".
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS options (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          buyer_user_id INTEGER NOT NULL REFERENCES players(user_id),
          underlying_user_id INTEGER NOT NULL REFERENCES players(user_id),
          type TEXT NOT NULL CHECK (type IN ('call')),
          strike_pct REAL NOT NULL,
          duration_days INTEGER NOT NULL,
          underlying_price_at_purchase REAL NOT NULL,
          strike_price REAL NOT NULL,
          premium_paid REAL NOT NULL,
          purchased_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL,
          settled_at TEXT,
          settlement_price REAL,
          payout REAL
        )
      `);
      // Scoped to exactly the settlement query's WHERE clause — self-prunes as contracts settle, so it
      // stays small forever regardless of how much settled history accumulates in the table.
      this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_options_settlement ON options(expires_at) WHERE settled_at IS NULL`);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (13)`);
    }

    if (version < 14) {
      // Per-chat, owner-toggleable (/setoptionsguard) — off by default, since self-pumping your own
      // option via a big buy order is deliberately allowed chaos, not a bug. When on, buy()/sell() block
      // trading anyone you're currently holding an open option on (see getOptionsSelfPumpGuard).
      this.ctx.storage.sql.exec(`ALTER TABLE market_settings ADD COLUMN block_self_pump_options INTEGER NOT NULL DEFAULT 0`);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (14)`);
    }

    if (version < 15) {
      // Every one of these was previously an unindexed scan on a hot path — idx_price_events_user_reason_
      // created covers recordMessage/recordReaction/recordReply/tradeImpactPct's "count today's events for
      // this user" queries and getDailyChange's single-user lookup (all filter user_id, most also reason,
      // with a created_at range — equality columns first, range column last, the standard composite-index
      // shape). idx_message_authors_created and idx_message_authors_thread_created cover getChatSilenceGap
      // (no WHERE clause at all — a full table scan on EVERY non-command message before this) and
      // getThreadSilenceGap respectively, letting SQLite satisfy their `ORDER BY created_at DESC LIMIT 1`
      // straight from the index instead of scanning the table. This is the fix for
      // "Exceeded allowed rows read in Durable Objects free tier" in production — missing indexes, not
      // retained data volume, were the dominant cost on these two tables.
      this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_price_events_user_reason_created ON price_events(user_id, reason, created_at)`);
      this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_message_authors_created ON message_authors(created_at)`);
      this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_message_authors_thread_created ON message_authors(thread_id, created_at)`);
      this.ctx.storage.sql.exec(`INSERT INTO _schema_migrations (id) VALUES (15)`);
    }
  }

  private isBlocked(userId: number): boolean {
    return this.ctx.storage.sql.exec(`SELECT user_id FROM blocked_players WHERE user_id = ?`, userId).toArray().length > 0;
  }

  async recordMessage(input: { messageId: number; userId: number; username?: string; firstName: string; threadId?: number }): Promise<void> {
    // The block check for "rejoining" — every other path into the market (buy, reply-bumps) is already
    // gated on either upsertPlayer or an existing players row, and reactions carry their own existence
    // check now (see recordReaction) since message_authors rows survive a blocked player's removal — so
    // stopping a blocked user's own messages from ever reaching upsertPlayer here is the one choke point
    // still needed for recordMessage specifically.
    if (this.isBlocked(input.userId)) {
      return;
    }

    this.upsertPlayer(input);
    this.ctx.storage.sql.exec(
      `INSERT INTO message_authors (message_id, user_id, thread_id) VALUES (?, ?, ?) ON CONFLICT(message_id) DO NOTHING`,
      input.messageId,
      input.userId,
      input.threadId ?? null
    );

    const countToday = this.ctx.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) as count FROM price_events
         WHERE user_id = ? AND reason = 'message' AND created_at >= ${TRADING_DAY_START}`,
        input.userId
      )
      .one().count;

    this.applyPriceChange(input.userId, MESSAGE_BASE_IMPACT * Math.pow(IMPACT_DECAY, countToday), "message", null);
  }

  // Telegram tells us the message_id that was reacted to and who reacted, but never who wrote the original
  // message — resolved via message_authors, populated in recordMessage above. No-ops for self-reactions or
  // messages we never saw (sent before this feature existed, for instance).
  async recordReaction(input: { messageId: number; reactorUserId: number; emoji: string }): Promise<void> {
    const weight = REACTION_WEIGHTS[input.emoji] ?? randomMemeWeight();

    const author = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; user_id: number }>(
        `SELECT user_id FROM message_authors WHERE message_id = ?`,
        input.messageId
      )
      .toArray()[0];
    if (!author || author.user_id === input.reactorUserId) {
      return;
    }

    // message_authors rows outlive a reset/delisted player (see migration 12) so silence-gap detection
    // keeps seeing real chat history — which means an old reaction can now resolve to someone with no
    // players row anymore. applyPriceChange would otherwise violate price_events' FK on user_id trying to
    // record it, so this is now the explicit version of the check message_authors row-deletion used to
    // give for free.
    const authorExists = this.ctx.storage.sql.exec(`SELECT user_id FROM players WHERE user_id = ?`, author.user_id).toArray().length > 0;
    if (!authorExists) {
      return;
    }

    this.ctx.storage.sql.exec(`UPDATE message_authors SET last_reacted_at = datetime('now') WHERE message_id = ?`, input.messageId);

    const countToday = this.ctx.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) as count FROM price_events
         WHERE user_id = ? AND reason = 'reaction' AND created_at >= ${TRADING_DAY_START}`,
        author.user_id
      )
      .one().count;

    this.applyPriceChange(author.user_id, weight * Math.pow(IMPACT_DECAY, countToday), "reaction", input.reactorUserId);
  }

  async recordReply(input: {
    recipientUserId: number;
    recipientUsername?: string;
    recipientFirstName: string;
    replierUserId: number;
  }): Promise<void> {
    // Only bumps an existing stock — never creates one. Telegram still resolves reply_to_message.from
    // for a reply to someone's old message even after they've left the chat (or if they've simply never
    // posted since this feature launched), so without this check a stale reply alone could conjure up a
    // stock for someone who never generated any activity of their own.
    const recipientExists = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; user_id: number }>(`SELECT user_id FROM players WHERE user_id = ?`, input.recipientUserId)
      .toArray().length > 0;
    if (!recipientExists) {
      return;
    }

    this.upsertPlayer({
      userId: input.recipientUserId,
      ...(input.recipientUsername !== undefined && { username: input.recipientUsername }),
      firstName: input.recipientFirstName,
    });

    const sameSenderCountToday = this.ctx.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) as count FROM price_events
         WHERE user_id = ? AND counterparty_user_id = ? AND reason = 'reply' AND created_at >= ${TRADING_DAY_START}`,
        input.recipientUserId,
        input.replierUserId
      )
      .one().count;

    const distinctSendersSoFarToday = this.ctx.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(DISTINCT counterparty_user_id) as count FROM price_events
         WHERE user_id = ? AND reason = 'reply' AND created_at >= ${TRADING_DAY_START}`,
        input.recipientUserId
      )
      .one().count;

    this.applyPriceChange(
      input.recipientUserId,
      REPLY_BASE_IMPACT * Math.pow(IMPACT_DECAY, sameSenderCountToday) * Math.pow(DISTINCT_SENDER_DECAY, distinctSendersSoFarToday),
      "reply",
      input.replierUserId
    );
  }

  async getPortfolio(userId: number): Promise<StockMarketPortfolio | null> {
    const row = this.ctx.storage.sql.exec<PlayerRow>(`SELECT * FROM players WHERE user_id = ?`, userId).toArray()[0];
    if (!row) {
      return null;
    }

    const holdings = this.ctx.storage.sql
      .exec<{
        [column: string]: SqlStorageValue;
        stock_user_id: number;
        shares: number;
        username: string | null;
        ticker: string | null;
        first_name: string;
        price: number;
      }>(
        `SELECT h.stock_user_id, h.shares, p.username, p.ticker, p.first_name, p.price
         FROM holdings h
         JOIN players p ON p.user_id = h.stock_user_id
         WHERE h.owner_user_id = ? AND h.shares > 0
         ORDER BY (h.shares * p.price) DESC`,
        userId
      )
      .toArray();

    // Open (unsettled) options this player bought — never ones they're the underlying of, see
    // StockMarketOpenOption. Soonest-expiring first, since that's the most actionable to see at a glance.
    const openOptions = this.ctx.storage.sql
      .exec<{
        [column: string]: SqlStorageValue;
        id: number;
        underlying_user_id: number;
        underlying_ticker: string | null;
        underlying_first_name: string;
        strike_price: number;
        current_price: number;
        expires_at_epoch_sec: number;
        now_epoch_sec: number;
      }>(
        `SELECT o.id, o.underlying_user_id, up.ticker as underlying_ticker, up.first_name as underlying_first_name,
                o.strike_price, up.price as current_price,
                CAST(strftime('%s', o.expires_at) AS INTEGER) as expires_at_epoch_sec,
                CAST(strftime('%s', 'now') AS INTEGER) as now_epoch_sec
         FROM options o
         JOIN players up ON up.user_id = o.underlying_user_id
         WHERE o.buyer_user_id = ? AND o.settled_at IS NULL
         ORDER BY o.expires_at ASC`,
        userId
      )
      .toArray();

    const changes = this.getDailyChanges();
    const halted = this.haltedUserIds();

    return {
      ...toPlayer(row, changes.get(row.user_id) ?? 0, halted.has(row.user_id)),
      holdings: holdings.map((h) => ({
        stockUserId: h.stock_user_id,
        username: h.username,
        ticker: h.ticker,
        firstName: h.first_name,
        shares: h.shares,
        price: h.price,
        value: h.shares * h.price,
        dailyChange: changes.get(h.stock_user_id) ?? 0,
        isHalted: halted.has(h.stock_user_id),
      })),
      openOptions: openOptions.map((o) => ({
        optionId: o.id,
        underlyingUserId: o.underlying_user_id,
        underlyingTicker: o.underlying_ticker,
        underlyingFirstName: o.underlying_first_name,
        strikePrice: o.strike_price,
        currentPrice: o.current_price,
        isHalted: halted.has(o.underlying_user_id),
        expiresAtEpochSec: o.expires_at_epoch_sec,
        nowEpochSec: o.now_epoch_sec,
      })),
    };
  }

  async getMarket(): Promise<StockMarketPlayer[]> {
    const changes = this.getDailyChanges();
    const halted = this.haltedUserIds();
    return this.ctx.storage.sql
      .exec<PlayerRow>(`SELECT * FROM players ORDER BY price DESC`)
      .toArray()
      .map((row) => toPlayer(row, changes.get(row.user_id) ?? 0, halted.has(row.user_id)));
  }

  // For /buy $TICKER <n> and /sell $TICKER <n> — tickers are opt-in (see setTicker) and only reachable
  // once set. Not everyone has a Telegram username, which was confusing people when username lookup was
  // the fallback for targeting, so there's no username-based lookup anymore — /value is reply-only, and
  // /buy and /sell use tickers.
  async findPlayerByTicker(ticker: string): Promise<StockMarketPlayer | null> {
    const row = this.ctx.storage.sql.exec<PlayerRow>(`SELECT * FROM players WHERE ticker = ? COLLATE NOCASE`, ticker).toArray()[0];
    return row ? toPlayer(row, this.getDailyChange(row.user_id), this.isHalted(row.user_id)) : null;
  }

  async getPlayer(userId: number): Promise<StockMarketPlayer | null> {
    const row = this.ctx.storage.sql.exec<PlayerRow>(`SELECT * FROM players WHERE user_id = ?`, userId).toArray()[0];
    return row ? toPlayer(row, this.getDailyChange(userId), this.isHalted(userId)) : null;
  }

  // Requires the caller to already be a player (i.e. have posted a real message) — otherwise a ticker
  // could be assigned to someone who'd just get swept up by purgeGhostPlayers's weekly sweep anyway.
  // Enforced case-insensitively even though the composer already uppercases before calling, since the
  // unique index below is itself case-sensitive (TEXT compares byte-for-byte by default in SQLite).
  async setTicker(userId: number, ticker: string): Promise<StockMarketSetTickerResult> {
    const exists = this.ctx.storage.sql.exec<PlayerRow>(`SELECT user_id FROM players WHERE user_id = ?`, userId).toArray().length > 0;
    if (!exists) {
      return "NOT_A_PLAYER";
    }

    const takenBy = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; user_id: number }>(
        `SELECT user_id FROM players WHERE ticker = ? COLLATE NOCASE AND user_id != ?`,
        ticker,
        userId
      )
      .toArray()[0];
    if (takenBy) {
      return "TAKEN";
    }

    this.ctx.storage.sql.exec(`UPDATE players SET ticker = ?, updated_at = datetime('now') WHERE user_id = ?`, ticker, userId);
    return "OK";
  }

  // This trading day's net price movement for one player — every price mutation already inserts a
  // timestamped price_events row (see applyPriceChange), so this needs no separate snapshot.
  private getDailyChange(userId: number): number {
    return this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; change: number }>(
        `SELECT COALESCE(SUM(delta), 0) as change FROM price_events
         WHERE user_id = ? AND created_at >= ${TRADING_DAY_START}`,
        userId
      )
      .one().change;
  }

  // Same as getDailyChange, but for every player in this chat at once — used wherever a whole roster's
  // worth of changes are needed in one call (getMarket, getPortfolio's owner + all holdings).
  private getDailyChanges(): Map<number, number> {
    const rows = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; user_id: number; change: number }>(
        `SELECT user_id, SUM(delta) as change FROM price_events
         WHERE created_at >= ${TRADING_DAY_START}
         GROUP BY user_id`
      )
      .toArray();
    return new Map(rows.map((r) => [r.user_id, r.change]));
  }

  // True if this player currently has an active trading halt (see rollHalt). Always computed in SQL
  // rather than comparing halted_until against a JS Date — SQLite's space-separated UTC datetime strings
  // are a timezone footgun there (some environments parse them as local time instead of UTC).
  private isHalted(userId: number): boolean {
    const row = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; halted: number }>(
        `SELECT (halted_until IS NOT NULL AND halted_until > datetime('now')) as halted FROM players WHERE user_id = ?`,
        userId
      )
      .toArray()[0];
    return row?.halted === 1;
  }

  // Same idea as isHalted, but every currently-halted player in this chat at once — same pattern as
  // getDailyChanges, for wherever a whole roster is being built (getMarket, getPortfolio).
  private haltedUserIds(): Set<number> {
    const rows = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; user_id: number }>(
        `SELECT user_id FROM players WHERE halted_until IS NOT NULL AND halted_until > datetime('now')`
      )
      .toArray();
    return new Set(rows.map((r) => r.user_id));
  }

  // Runs weekly alongside the allowance/purge sweep. Removes anyone who's never authored a genuine
  // message themselves — a player only ever gets a 'message' reason event by posting, so this catches
  // ghosts (e.g. someone who left before the feature launched but still got upserted via a stale reply)
  // without punishing anyone who's actually participated, no matter how long ago.
  async purgeGhostPlayers(): Promise<void> {
    const ghosts = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; user_id: number }>(
        `SELECT user_id FROM players WHERE user_id NOT IN (SELECT DISTINCT user_id FROM price_events WHERE reason = 'message')`
      )
      .toArray();

    for (const { user_id: userId } of ghosts) {
      this.deletePlayerRow(userId);
    }
  }

  // Cashes out everyone holding shares in this stock at its CURRENT price (a snapshot, not a simulated
  // cascade of individual sells the way sell() decays repeat trades — the stock is coming off the market
  // either way, so there's no "next price" for a second holder's sale to react to). Shared by delist and
  // reset below, both of which pull someone off the market and owe every holder a real refund for it,
  // unlike deletePlayerRow's plain delete (still used for the target's OWN holdings/cash, which vanish
  // with their row rather than being refunded to them).
  private forceSelloutHolders(stockUserId: number): void {
    const target = this.ctx.storage.sql.exec<{ [column: string]: SqlStorageValue; price: number }>(
      `SELECT price FROM players WHERE user_id = ?`,
      stockUserId
    ).toArray()[0];
    if (!target) {
      return;
    }

    const holders = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; owner_user_id: number; shares: number }>(
        `SELECT owner_user_id, shares FROM holdings WHERE stock_user_id = ? AND shares > 0`,
        stockUserId
      )
      .toArray();

    for (const holder of holders) {
      const proceeds = holder.shares * target.price;
      this.ctx.storage.sql.exec(
        `UPDATE players SET cash = cash + ?, updated_at = datetime('now') WHERE user_id = ?`,
        proceeds,
        holder.owner_user_id
      );
    }

    this.ctx.storage.sql.exec(`DELETE FROM holdings WHERE stock_user_id = ?`, stockUserId);
  }

  // Same "owe the other side a real resolution" precedent as forceSelloutHolders, applied to open options
  // instead of shares: settles every OPEN option where underlyingUserId is the bet-on stock, right now, at
  // their CURRENT price — same computeOptionPayout formula settleExpiredOptions uses at real expiry.
  // Without this, deletePlayerRow's later blind DELETE FROM options would just erase a real buyer's
  // premium with zero chance to win, the same silent-forfeiture bug forceSelloutHolders already fixed for
  // share holders. Doesn't touch options where userId is the BUYER — those settle for nobody but the
  // target themselves, and their whole row (cash included) is about to vanish either way.
  private forceSettleOptionsAgainst(underlyingUserId: number): void {
    const underlying = this.ctx.storage.sql.exec<{ [column: string]: SqlStorageValue; price: number }>(
      `SELECT price FROM players WHERE user_id = ?`,
      underlyingUserId
    ).toArray()[0];
    if (!underlying) {
      return;
    }

    const openOptions = this.ctx.storage.sql
      .exec<{
        [column: string]: SqlStorageValue;
        id: number;
        buyer_user_id: number;
        strike_pct: number;
        duration_days: number;
        strike_price: number;
      }>(
        `SELECT id, buyer_user_id, strike_pct, duration_days, strike_price FROM options WHERE underlying_user_id = ? AND settled_at IS NULL`,
        underlyingUserId
      )
      .toArray();

    for (const option of openOptions) {
      const payout = this.computeOptionPayout(
        option.strike_pct as StockMarketOptionStrikePct,
        option.duration_days as StockMarketOptionDurationDays,
        option.strike_price,
        underlying.price
      );
      this.ctx.storage.sql.exec(
        `UPDATE options SET settled_at = datetime('now'), settlement_price = ?, payout = ? WHERE id = ?`,
        underlying.price,
        payout,
        option.id
      );
      if (payout > 0) {
        this.ctx.storage.sql.exec(
          `UPDATE players SET cash = cash + ?, updated_at = datetime('now') WHERE user_id = ?`,
          payout,
          option.buyer_user_id
        );
      }
    }
  }

  // Pulls someone off the market until they start talking again — every holder of their stock gets cashed
  // out first (forceSelloutHolders), every open option against their price gets force-settled
  // (forceSettleOptionsAgainst), then their own row/holdings/history is wiped (deletePlayerRow), same as
  // before. No block recorded: the very next message they post runs upsertPlayer again and they're back
  // at STARTING_PRICE/STARTING_CASH, same as anyone posting for the first time. Also clears any lingering
  // block from a prior /delist — reset is the deliberately non-permanent of the two, so running it is the
  // way to undo one.
  async reset(userId: number): Promise<boolean> {
    const existed = this.ctx.storage.sql.exec<PlayerRow>(`SELECT user_id FROM players WHERE user_id = ?`, userId).toArray().length > 0;
    if (existed) {
      this.forceSelloutHolders(userId);
      this.forceSettleOptionsAgainst(userId);
      this.deletePlayerRow(userId);
    }
    this.ctx.storage.sql.exec(`DELETE FROM blocked_players WHERE user_id = ?`, userId);
    return existed;
  }

  // Same holder cashout, option settlement, and wipe as reset, but permanent: also blocks the user_id in
  // blocked_players, which recordMessage and buy() both check before ever calling upsertPlayer — so unlike
  // reset, talking (or trading) again doesn't bring them back. For someone who's actually left the chat, or
  // who never wants to be a tradeable stock again, as opposed to reset's "sit out for now."
  async delist(userId: number): Promise<boolean> {
    const existed = this.ctx.storage.sql.exec<PlayerRow>(`SELECT user_id FROM players WHERE user_id = ?`, userId).toArray().length > 0;
    if (existed) {
      this.forceSelloutHolders(userId);
      this.forceSettleOptionsAgainst(userId);
      this.deletePlayerRow(userId);
    }
    this.ctx.storage.sql.exec(`INSERT INTO blocked_players (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING`, userId);
    return existed;
  }

  // Owner-only full wipe — every player, holding, option, price event, and message-author record in this
  // chat's market, gone. For clearing out an economy corrupted by a bug (e.g. the topic-auto-reply
  // mismeasurement — see realReplyTo in context.ts) rather than correcting one player at a time; removing
  // individual players one-by-one is already what delist/reset are for. Deliberately doesn't touch
  // blocked_players — a restart clears the economy, not anyone's standing opt-out. Schema/migration state
  // is untouched, so the next message from anyone just starts them fresh at STARTING_PRICE/STARTING_CASH.
  async restart(): Promise<void> {
    this.ctx.storage.sql.exec(`DELETE FROM holdings`);
    this.ctx.storage.sql.exec(`DELETE FROM options`);
    this.ctx.storage.sql.exec(`DELETE FROM price_events`);
    this.ctx.storage.sql.exec(`DELETE FROM message_authors`);
    this.ctx.storage.sql.exec(`DELETE FROM players`);
  }

  // message_authors is deliberately left alone here — see migration 12 for why deleting a removed player's
  // rows out of it broke Market Open/Terminator's "when did anyone last post" read on their very next post.
  // options is safe to blind-delete (unlike message_authors, nothing derives a live calculation from
  // historical rows here) — by the time this runs, reset/delist have already called
  // forceSettleOptionsAgainst, so every row still matching underlying_user_id = userId is already settled
  // and its buyer already paid; what's left is either that now-settled audit trail or userId's own
  // purchased options, which vanish with the rest of their row same as their cash and price history.
  private deletePlayerRow(userId: number): void {
    this.ctx.storage.sql.exec(`DELETE FROM holdings WHERE owner_user_id = ? OR stock_user_id = ?`, userId, userId);
    this.ctx.storage.sql.exec(`DELETE FROM options WHERE buyer_user_id = ? OR underlying_user_id = ?`, userId, userId);
    this.ctx.storage.sql.exec(`DELETE FROM price_events WHERE user_id = ?`, userId);
    this.ctx.storage.sql.exec(`DELETE FROM players WHERE user_id = ?`, userId);
  }

  // Buying pushes price up before the trade settles (see tradeImpactPct/computeDampedDelta below), so the
  // buyer pays the POST-move price — the prospective price is computed first, checked against the buyer's
  // cash, and only actually committed (moving price, writing the price_events row) once the trade is known
  // to go through. A failed trade must never move price or leave an audit row behind.
  async buy(input: { buyerUserId: number; buyerUsername?: string; buyerFirstName: string; targetUserId: number; shares: number }): Promise<StockMarketTradeResult> {
    if (input.shares <= 0) {
      return { ok: false, type: "INVALID_AMOUNT" };
    }
    if (input.buyerUserId === input.targetUserId) {
      return { ok: false, type: "CANNOT_TRADE_SELF" };
    }
    // Buying is the other path (besides recordMessage) that would otherwise recreate a blocked user's
    // player row via upsertPlayer below — without this, /delist's whole point ("block them rejoining")
    // could be sidestepped just by placing a trade instead of posting a message.
    if (this.isBlocked(input.buyerUserId)) {
      return { ok: false, type: "BLOCKED" };
    }

    this.upsertPlayer({
      userId: input.buyerUserId,
      ...(input.buyerUsername !== undefined && { username: input.buyerUsername }),
      firstName: input.buyerFirstName,
    });

    const target = this.ctx.storage.sql.exec<PlayerRow>(`SELECT * FROM players WHERE user_id = ?`, input.targetUserId).toArray()[0];
    if (!target) {
      return { ok: false, type: "UNKNOWN_STOCK" };
    }
    if (this.isHalted(input.targetUserId)) {
      return { ok: false, type: "HALTED" };
    }
    // Only checked when the per-chat guard is on (see hasOpenOptionAgainst/getOptionsSelfPumpGuard) — off
    // by default, since self-pumping your own option via a big buy order is deliberately allowed chaos.
    if ((await this.getOptionsSelfPumpGuard()) && this.hasOpenOptionAgainst(input.buyerUserId, input.targetUserId)) {
      return { ok: false, type: "OPTIONS_CONFLICT" };
    }

    const buyer = this.ctx.storage.sql.exec<PlayerRow>(`SELECT * FROM players WHERE user_id = ?`, input.buyerUserId).one();

    const pctImpact = this.tradeImpactPct(input.targetUserId, input.buyerUserId, input.shares);
    const dampedDelta = this.computeDampedDelta(input.targetUserId, target.price * pctImpact, "trade");
    const prospectivePrice = Math.max(MIN_PRICE, target.price + dampedDelta);
    const cost = prospectivePrice * input.shares;
    if (buyer.cash < cost) {
      return { ok: false, type: "INSUFFICIENT_CASH" };
    }

    const newPrice = this.commitPriceChange(input.targetUserId, dampedDelta, "trade", input.buyerUserId);

    this.ctx.storage.sql.exec(`UPDATE players SET cash = cash - ?, updated_at = datetime('now') WHERE user_id = ?`, cost, input.buyerUserId);
    this.ctx.storage.sql.exec(
      `INSERT INTO holdings (owner_user_id, stock_user_id, shares) VALUES (?, ?, ?)
       ON CONFLICT(owner_user_id, stock_user_id) DO UPDATE SET shares = shares + excluded.shares`,
      input.buyerUserId,
      input.targetUserId,
      input.shares
    );

    const totalShares = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; shares: number }>(
        `SELECT shares FROM holdings WHERE owner_user_id = ? AND stock_user_id = ?`,
        input.buyerUserId,
        input.targetUserId
      )
      .one().shares;

    return { ok: true, shares: input.shares, price: newPrice, total: cost, totalShares };
  }

  // Symmetric with buy(): both settle at the POST-move price. This used to pay the seller the pre-move
  // price instead (what they last saw, no retroactive discount) — but that asymmetry turned out to be a
  // real arbitrage: since same-day repeat trades decay (see tradeImpactPct), immediately buying back what
  // you just sold cost LESS than the sell's own (undiscounted) proceeds, for a guaranteed, riskless,
  // repeatable profit on every sell-then-buy cycle. Settling both legs post-move closes that: round-
  // tripping now nets exactly zero (buy-then-sell) or a small guaranteed loss (sell-then-buy), never a
  // gain, the same way it already couldn't for buy().
  async sell(input: { sellerUserId: number; targetUserId: number; shares: number }): Promise<StockMarketTradeResult> {
    if (input.shares <= 0) {
      return { ok: false, type: "INVALID_AMOUNT" };
    }

    const target = this.ctx.storage.sql.exec<PlayerRow>(`SELECT * FROM players WHERE user_id = ?`, input.targetUserId).toArray()[0];
    if (!target) {
      return { ok: false, type: "UNKNOWN_STOCK" };
    }
    if (this.isHalted(input.targetUserId)) {
      return { ok: false, type: "HALTED" };
    }
    // Symmetric with buy()'s guard — see the comment there. Blocking both directions (not just buy) keeps
    // the rule simple to explain and future-proofs it for puts, whose equivalent manipulation is dumping
    // shares to tank a price rather than pumping one.
    if ((await this.getOptionsSelfPumpGuard()) && this.hasOpenOptionAgainst(input.sellerUserId, input.targetUserId)) {
      return { ok: false, type: "OPTIONS_CONFLICT" };
    }

    const holding = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; shares: number }>(
        `SELECT shares FROM holdings WHERE owner_user_id = ? AND stock_user_id = ?`,
        input.sellerUserId,
        input.targetUserId
      )
      .toArray()[0];
    if (!holding || holding.shares < input.shares) {
      return { ok: false, type: "INSUFFICIENT_SHARES" };
    }

    const pctImpact = this.tradeImpactPct(input.targetUserId, input.sellerUserId, input.shares);
    const dampedDelta = this.computeDampedDelta(input.targetUserId, -(target.price * pctImpact), "trade");
    const newPrice = this.commitPriceChange(input.targetUserId, dampedDelta, "trade", input.sellerUserId);
    const proceeds = newPrice * input.shares;

    this.ctx.storage.sql.exec(
      `UPDATE holdings SET shares = shares - ? WHERE owner_user_id = ? AND stock_user_id = ?`,
      input.shares,
      input.sellerUserId,
      input.targetUserId
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM holdings WHERE owner_user_id = ? AND stock_user_id = ? AND shares <= 0`,
      input.sellerUserId,
      input.targetUserId
    );
    this.ctx.storage.sql.exec(`UPDATE players SET cash = cash + ?, updated_at = datetime('now') WHERE user_id = ?`, proceeds, input.sellerUserId);

    return { ok: true, shares: input.shares, price: newPrice, total: proceeds, totalShares: holding.shares - input.shares };
  }

  // Tier position (0=conservative/closest-to-ATM, 1=middle, 2=aggressive/furthest-OTM) of strikePct
  // within whichever duration's three-strike menu is in play — shared by computeOptionPricing (which
  // multiplier scales the premium) and computeOptionPayout (which multiplier scales the payout), so the
  // two can never disagree about which tier a given strike/duration pair belongs to. Callers validate
  // strikePct/durationDays against OPTION_STRIKES_BY_DURATION before ever reaching here, so indexOf is
  // always found (see quoteOption/buyOption) — falls back to the middle tier rather than throwing if that
  // invariant is ever violated.
  private strikeTierIndex(strikePct: StockMarketOptionStrikePct, durationDays: StockMarketOptionDurationDays): 0 | 1 | 2 {
    const tierIndex = OPTION_STRIKES_BY_DURATION[durationDays].indexOf(strikePct);
    return tierIndex === 0 || tierIndex === 1 || tierIndex === 2 ? tierIndex : 1;
  }

  // strikePrice = currentPrice * (1 + strikePct); premium floors at MINIMUM_OPTION_PREMIUM so a
  // near-$0 underlying never produces a near-free, only-upside contract. Shared by quoteOption and
  // buyOption so the confirm-step preview and the actual charge can only ever differ from live price
  // drift between the two calls, never a formula mismatch.
  private computeOptionPricing(
    currentPrice: number,
    strikePct: StockMarketOptionStrikePct,
    durationDays: StockMarketOptionDurationDays
  ): { strikePrice: number; premium: number } {
    const strikePrice = currentPrice * (1 + strikePct);
    const strikeMultiplier = OPTION_STRIKE_TIER_MULTIPLIERS[this.strikeTierIndex(strikePct, durationDays)];
    const premium = Math.max(
      MINIMUM_OPTION_PREMIUM,
      currentPrice * OPTION_PREMIUM_BASE_RATE * strikeMultiplier * OPTION_DURATION_MULTIPLIERS[durationDays]
    );
    return { strikePrice, premium };
  }

  // Payout leverage mirrors computeOptionPricing's tier lookup but in the other direction: the cheaper/
  // further-OTM the strike was, the bigger a multiple of the raw ITM difference it pays out when it lands.
  // See OPTION_PAYOUT_LEVERAGE_BY_TIER above for the rationale. Shared by settleExpiredOptions (real
  // expiry) and forceSettleOptionsAgainst (early force-settlement on delist/reset) so both payout paths
  // can never drift apart.
  private computeOptionPayout(
    strikePct: StockMarketOptionStrikePct,
    durationDays: StockMarketOptionDurationDays,
    strikePrice: number,
    settlementPrice: number
  ): number {
    const leverage = OPTION_PAYOUT_LEVERAGE_BY_TIER[this.strikeTierIndex(strikePct, durationDays)];
    return Math.max(0, settlementPrice - strikePrice) * leverage;
  }

  // Read-only preview for the composer's confirm step — never mutates anything. Epoch seconds (via
  // SQLite's own strftime, never a JS Date parse of the space-separated UTC string) so the composer can
  // show "expires in ~Xh Ym" without hitting the timezone footgun documented on isHalted above.
  async quoteOption(
    underlyingUserId: number,
    strikePct: StockMarketOptionStrikePct,
    durationDays: StockMarketOptionDurationDays
  ): Promise<StockMarketOptionQuote | null> {
    if (!VALID_OPTION_DURATION_DAYS.includes(durationDays) || !OPTION_STRIKES_BY_DURATION[durationDays].includes(strikePct)) {
      return null;
    }

    const underlying = this.ctx.storage.sql.exec<PlayerRow>(`SELECT * FROM players WHERE user_id = ?`, underlyingUserId).toArray()[0];
    if (!underlying) {
      return null;
    }

    const { strikePrice, premium } = this.computeOptionPricing(underlying.price, strikePct, durationDays);

    // durationDays here is the real-DTE-style label the user picked (0/1/3/7), not the actual day-offset —
    // "0D" means "expires at the very next close" (matching real 0DTE), which is TRADING_DAY_START + 1
    // day, not +0 (which would resolve at-or-before now). Every label is one session short of its raw
    // offset by design; see OPTION_DURATION_MULTIPLIERS' comment for the same +1 in the pricing table's keys.
    const times = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; expires_at_epoch_sec: number; now_epoch_sec: number }>(
        `SELECT CAST(strftime('%s', ${TRADING_DAY_START}, '+' || ? || ' days') AS INTEGER) as expires_at_epoch_sec,
                CAST(strftime('%s', 'now') AS INTEGER) as now_epoch_sec`,
        durationDays + 1
      )
      .one();

    return {
      underlyingPrice: underlying.price,
      strikePrice,
      premium,
      expiresAtEpochSec: times.expires_at_epoch_sec,
      nowEpochSec: times.now_epoch_sec,
    };
  }

  // Always recomputes strike/premium fresh off the LIVE price at purchase — never trusts an earlier
  // quoteOption call — same "DO is the source of truth, price is read fresh at execution" philosophy as
  // buy()/sell(). expires_at is the most-recent 5pm-ET boundary at-or-before purchase (TRADING_DAY_START)
  // plus (durationDays + 1) — the label is one session short of the actual offset (see quoteOption's
  // comment), so "0D" lands on the very next close and "1D"/"3D"/"7D" each land one close further out.
  // Actual runway still varies by time of day within that (buy right after 5pm ET and "0D" gets nearly
  // 24h; buy right before and it settles almost immediately) — an accepted quirk, same spirit as
  // TRADING_DAY_START's own documented EDT/DST approximation, and exactly how real 0DTE/short-dated
  // options behave. durationDays is bound as a parameter, not template-interpolated, even though it only
  // ever comes from a fixed picker.
  async buyOption(input: {
    buyerUserId: number;
    buyerUsername?: string;
    buyerFirstName: string;
    underlyingUserId: number;
    strikePct: StockMarketOptionStrikePct;
    durationDays: StockMarketOptionDurationDays;
  }): Promise<StockMarketBuyOptionResult> {
    if (!VALID_OPTION_DURATION_DAYS.includes(input.durationDays) || !OPTION_STRIKES_BY_DURATION[input.durationDays].includes(input.strikePct)) {
      return { ok: false, type: "INVALID_TERMS" };
    }
    if (input.buyerUserId === input.underlyingUserId) {
      return { ok: false, type: "CANNOT_TRADE_SELF" };
    }
    // Same rationale as buy()'s isBlocked check — without this, a /delist'ed user could sidestep the
    // block just by buying an option instead of posting or trading shares.
    if (this.isBlocked(input.buyerUserId)) {
      return { ok: false, type: "BLOCKED" };
    }

    this.upsertPlayer({
      userId: input.buyerUserId,
      ...(input.buyerUsername !== undefined && { username: input.buyerUsername }),
      firstName: input.buyerFirstName,
    });

    const underlying = this.ctx.storage.sql.exec<PlayerRow>(`SELECT * FROM players WHERE user_id = ?`, input.underlyingUserId).toArray()[0];
    if (!underlying) {
      return { ok: false, type: "UNKNOWN_STOCK" };
    }
    // Same rationale as buy()/sell()'s halt check — a derivative on a frozen stock is just as frozen.
    if (this.isHalted(input.underlyingUserId)) {
      return { ok: false, type: "HALTED" };
    }

    const buyer = this.ctx.storage.sql.exec<PlayerRow>(`SELECT * FROM players WHERE user_id = ?`, input.buyerUserId).one();
    const { strikePrice, premium } = this.computeOptionPricing(underlying.price, input.strikePct, input.durationDays);
    if (buyer.cash < premium) {
      return { ok: false, type: "INSUFFICIENT_CASH" };
    }

    this.ctx.storage.sql.exec(`UPDATE players SET cash = cash - ?, updated_at = datetime('now') WHERE user_id = ?`, premium, input.buyerUserId);

    const inserted = this.ctx.storage.sql
      .exec<{
        [column: string]: SqlStorageValue;
        id: number;
        strike_price: number;
        premium_paid: number;
        underlying_price_at_purchase: number;
        expires_at_epoch_sec: number;
      }>(
        `INSERT INTO options (buyer_user_id, underlying_user_id, type, strike_pct, duration_days, underlying_price_at_purchase, strike_price, premium_paid, expires_at)
         VALUES (?, ?, 'call', ?, ?, ?, ?, ?, datetime(${TRADING_DAY_START}, '+' || ? || ' days'))
         RETURNING id, strike_price, premium_paid, underlying_price_at_purchase, CAST(strftime('%s', expires_at) AS INTEGER) as expires_at_epoch_sec`,
        input.buyerUserId,
        input.underlyingUserId,
        input.strikePct,
        input.durationDays,
        underlying.price,
        strikePrice,
        premium,
        input.durationDays + 1
      )
      .one();

    return {
      ok: true,
      optionId: inserted.id,
      underlyingUserId: input.underlyingUserId,
      underlyingPriceAtPurchase: inserted.underlying_price_at_purchase,
      strikePrice: inserted.strike_price,
      premium: inserted.premium_paid,
      expiresAtEpochSec: inserted.expires_at_epoch_sec,
    };
  }

  // Called by the daily 5pm-ET options-settlement cron, once per chat. A halted underlying is read
  // normally here — halts only block price MUTATION (see applyPriceChange's guard), never reads, and
  // getMarket/getPortfolio/`/value` already show a frozen price the same way, so no special case is
  // needed. expires_at <= datetime('now') is a plain string comparison, not an epoch one — safe for the
  // same fixed-width-string lexical-order reason halted_until > datetime('now') already relies on; epoch
  // conversion is only needed for values that cross into TypeScript, which this query doesn't return.
  //
  // Zero internal `await` points — every mutation below is a synchronous exec() call, same style as
  // applyDailyDecay/rollHalt/buy/sell — so one call to this method runs to completion as a single atomic
  // JS turn. Even an overlapping cron firing just finds nothing left under `settled_at IS NULL`, so
  // double-payout isn't possible. Deliberately doesn't call the public awardCash() (an avoidable `await`
  // per row) — the cash credit is inlined instead.
  async settleExpiredOptions(): Promise<StockMarketOptionSettlement[]> {
    const rows = this.ctx.storage.sql
      .exec<{
        [column: string]: SqlStorageValue;
        id: number;
        buyer_user_id: number;
        buyer_first_name: string;
        buyer_ticker: string | null;
        underlying_user_id: number;
        underlying_first_name: string;
        underlying_ticker: string | null;
        strike_pct: number;
        duration_days: number;
        strike_price: number;
        settlement_price: number;
      }>(
        `SELECT o.id, o.buyer_user_id, bp.first_name as buyer_first_name, bp.ticker as buyer_ticker,
                o.underlying_user_id, up.first_name as underlying_first_name, up.ticker as underlying_ticker,
                o.strike_pct, o.duration_days, o.strike_price, up.price as settlement_price
         FROM options o
         JOIN players bp ON bp.user_id = o.buyer_user_id
         JOIN players up ON up.user_id = o.underlying_user_id
         WHERE o.settled_at IS NULL AND o.expires_at <= datetime('now')`
      )
      .toArray();

    const results: StockMarketOptionSettlement[] = [];
    for (const row of rows) {
      const payout = this.computeOptionPayout(
        row.strike_pct as StockMarketOptionStrikePct,
        row.duration_days as StockMarketOptionDurationDays,
        row.strike_price,
        row.settlement_price
      );

      this.ctx.storage.sql.exec(
        `UPDATE options SET settled_at = datetime('now'), settlement_price = ?, payout = ? WHERE id = ?`,
        row.settlement_price,
        payout,
        row.id
      );
      if (payout > 0) {
        this.ctx.storage.sql.exec(`UPDATE players SET cash = cash + ?, updated_at = datetime('now') WHERE user_id = ?`, payout, row.buyer_user_id);
      }

      results.push({
        optionId: row.id,
        buyerUserId: row.buyer_user_id,
        buyerFirstName: row.buyer_first_name,
        buyerTicker: row.buyer_ticker,
        underlyingUserId: row.underlying_user_id,
        underlyingFirstName: row.underlying_first_name,
        underlyingTicker: row.underlying_ticker,
        strikePrice: row.strike_price,
        settlementPrice: row.settlement_price,
        payout,
      });
    }
    return results;
  }

  // True if traderUserId currently holds an open (unsettled) option on underlyingUserId — only ever
  // consulted when getOptionsSelfPumpGuard() is on, so this query costs nothing in the (default) off case.
  private hasOpenOptionAgainst(traderUserId: number, underlyingUserId: number): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ [column: string]: SqlStorageValue; id: number }>(
          `SELECT id FROM options WHERE buyer_user_id = ? AND underlying_user_id = ? AND settled_at IS NULL LIMIT 1`,
          traderUserId,
          underlyingUserId
        )
        .toArray().length > 0
    );
  }

  // Off by default — self-pumping your own option via a big buy order is deliberately allowed chaos, not
  // a bug (see TRADE_BASE_IMPACT_PCT above). Toggled per chat by the bot owner via /setoptionsguard.
  async setOptionsSelfPumpGuard(enabled: boolean): Promise<void> {
    this.ctx.storage.sql.exec(`UPDATE market_settings SET block_self_pump_options = ? WHERE id = 1`, enabled ? 1 : 0);
  }

  async getOptionsSelfPumpGuard(): Promise<boolean> {
    const row = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; block_self_pump_options: number }>(`SELECT block_self_pump_options FROM market_settings WHERE id = 1`)
      .toArray()[0];
    return row?.block_self_pump_options === 1;
  }

  async applyWeeklyAllowance(): Promise<void> {
    this.ctx.storage.sql.exec(`UPDATE players SET cash = cash + ?, updated_at = datetime('now')`, WEEKLY_ALLOWANCE);
  }

  // Flat cash grant — used for the random per-message bonus (see the composer's maybeAwardCashBonus).
  // Cash only, never price, so it's completely orthogonal to dampenGain/decay/halts — just spendable
  // currency, same as the weekly allowance above. Requires an existing player, but the composer only
  // ever calls this from inside trackActivity, right after recordMessage has already upserted them.
  async awardCash(userId: number, amount: number): Promise<void> {
    this.ctx.storage.sql.exec(`UPDATE players SET cash = cash + ?, updated_at = datetime('now') WHERE user_id = ?`, amount, userId);
  }

  // Owner-triggered flat cash injection to every active player in this chat's market at once (see the
  // composer's /stimulus) — a bulk version of awardCash so N players costs one UPDATE instead of N. Same
  // "cash only, never price" contract as awardCash/applyWeeklyAllowance. Returns the player count so the
  // composer can report how many people got paid, and skip announcing anything if the market's empty.
  async stimulus(amount: number): Promise<number> {
    const count = this.ctx.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) as count FROM players`).one().count;
    if (count > 0) {
      this.ctx.storage.sql.exec(`UPDATE players SET cash = cash + ?, updated_at = datetime('now')`, amount);
    }
    return count;
  }

  // The most recently tracked message in one specific forum topic (or the General/no-topic chat, if
  // threadId is null) — used by Conversation Terminator, which is scoped per-thread so one topic going
  // quiet doesn't get lumped in with unrelated activity happening in a different topic. Must be called
  // BEFORE recordMessage inserts the current message's own row, or this would just find the message
  // calling it. Returns raw epoch seconds (via SQLite's own strftime, never a JS Date parse of the
  // space-separated UTC string) so the composer can do awake-hours-aware gap math itself without hitting
  // the timezone footgun described on isHalted above. hasReaction lets the composer treat a reaction on
  // that last message as real engagement and skip Terminator entirely, even with zero text replies.
  async getThreadSilenceGap(threadId: number | null): Promise<
    | {
        userId: number;
        firstName: string;
        ticker: string | null;
        messageId: number;
        lastEpochSec: number;
        nowEpochSec: number;
        hasReaction: boolean;
      }
    | null
  > {
    const row = this.ctx.storage.sql
      .exec<{
        [column: string]: SqlStorageValue;
        user_id: number;
        first_name: string;
        ticker: string | null;
        message_id: number;
        last_epoch_sec: number;
        now_epoch_sec: number;
        has_reaction: number;
      }>(
        `SELECT ma.user_id, p.first_name, p.ticker, ma.message_id,
                CAST(strftime('%s', ma.created_at) AS INTEGER) as last_epoch_sec,
                CAST(strftime('%s', 'now') AS INTEGER) as now_epoch_sec,
                (ma.last_reacted_at IS NOT NULL) as has_reaction
         FROM message_authors ma
         JOIN players p ON p.user_id = ma.user_id
         WHERE ma.thread_id IS ?
         ORDER BY ma.created_at DESC LIMIT 1`,
        threadId
      )
      .toArray()[0];
    return row
      ? {
          userId: row.user_id,
          firstName: row.first_name,
          ticker: row.ticker,
          messageId: row.message_id,
          lastEpochSec: row.last_epoch_sec,
          nowEpochSec: row.now_epoch_sec,
          hasReaction: row.has_reaction === 1,
        }
      : null;
  }

  // Same idea as getThreadSilenceGap, but chat-wide across every thread — used by Market Open, which
  // deliberately stays global (breaking the silence anywhere in the chat counts, not just in one topic).
  async getChatSilenceGap(): Promise<{ userId: number; lastEpochSec: number; nowEpochSec: number } | null> {
    const row = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; user_id: number; last_epoch_sec: number; now_epoch_sec: number }>(
        `SELECT ma.user_id,
                CAST(strftime('%s', ma.created_at) AS INTEGER) as last_epoch_sec,
                CAST(strftime('%s', 'now') AS INTEGER) as now_epoch_sec
         FROM message_authors ma
         ORDER BY ma.created_at DESC LIMIT 1`
      )
      .toArray()[0];
    return row ? { userId: row.user_id, lastEpochSec: row.last_epoch_sec, nowEpochSec: row.now_epoch_sec } : null;
  }

  // True (and claims it) if nobody's necromanced this message before — false, no-op, if it's already
  // been claimed, so the same old message can't be repeatedly replied to for repeat payouts.
  async claimNecromancy(messageId: number): Promise<boolean> {
    const already = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; message_id: number }>(`SELECT message_id FROM necromancy_claims WHERE message_id = ?`, messageId)
      .toArray().length > 0;
    if (already) {
      return false;
    }
    this.ctx.storage.sql.exec(`INSERT INTO necromancy_claims (message_id) VALUES (?)`, messageId);
    return true;
  }

  async applyDailyDecay(): Promise<void> {
    const players = this.ctx.storage.sql.exec<PlayerRow>(`SELECT * FROM players`).toArray();
    if (players.length === 0) {
      return;
    }

    const average = players.reduce((sum, p) => sum + p.price, 0) / players.length;

    for (const player of players) {
      const gravity = player.price < average ? DAILY_DECAY_GRAVITY_UP : DAILY_DECAY_GRAVITY_DOWN;
      const delta = (average - player.price) * gravity;
      if (Math.abs(delta) < 0.01) {
        continue;
      }
      this.applyPriceChange(player.user_id, delta, "decay", null);
    }
  }

  // Driven by the same daily cron as applyDailyDecay, but kept separate since this one needs to tell the
  // composer who (if anyone) to announce — applyDailyDecay is pure storage mutation with nothing to say.
  // Considers only the current leader, and only among players not already halted, so this can't re-halt
  // someone mid-halt or ever leave the market with zero tradeable stocks if everyone's somehow halted.
  // Eligibility (the lead requirement) is checked before the dice roll, not after — a lead that doesn't
  // clear the bar means there's nothing to roll for at all, not just a roll that happens to fail.
  async rollHalt(): Promise<{ userId: number; firstName: string; ticker: string | null } | null> {
    const [leader, runnerUp] = this.ctx.storage.sql
      .exec<PlayerRow>(
        `SELECT * FROM players WHERE halted_until IS NULL OR halted_until <= datetime('now') ORDER BY price DESC LIMIT 2`
      )
      .toArray();
    if (!leader || !runnerUp || leader.price - runnerUp.price < HALT_LEAD_THRESHOLD) {
      return null;
    }

    if (Math.random() >= HALT_DAILY_CHANCE) {
      return null;
    }

    this.ctx.storage.sql.exec(
      `UPDATE players SET halted_until = datetime('now', '+${HALT_DURATION_HOURS} hours'), updated_at = datetime('now') WHERE user_id = ?`,
      leader.user_id
    );

    return { userId: leader.user_id, firstName: leader.first_name, ticker: leader.ticker };
  }

  // NULL clears the preference (announcements fall back to the General topic / main chat).
  async setAnnouncementThread(threadId: number | null): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO market_settings (id, announcement_thread_id) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET announcement_thread_id = ?`,
      threadId,
      threadId
    );
  }

  async getAnnouncementThread(): Promise<number | null> {
    const row = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; announcement_thread_id: number | null }>(
        `SELECT announcement_thread_id FROM market_settings WHERE id = 1`
      )
      .toArray()[0];
    return row?.announcement_thread_id ?? null;
  }

  async purgeOldData(): Promise<void> {
    this.ctx.storage.sql.exec(`DELETE FROM message_authors WHERE created_at < datetime('now', '-${MESSAGE_AUTHOR_RETENTION_DAYS} days')`);
    this.ctx.storage.sql.exec(`DELETE FROM price_events WHERE created_at < datetime('now', '-${PRICE_EVENT_RETENTION_DAYS} days')`);
    this.ctx.storage.sql.exec(
      `DELETE FROM options WHERE settled_at IS NOT NULL AND settled_at < datetime('now', '-${OPTION_RETENTION_DAYS} days')`
    );
  }

  private upsertPlayer(input: { userId: number; username?: string; firstName: string }): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO players (user_id, username, first_name) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name, updated_at = datetime('now')`,
      input.userId,
      input.username ?? null,
      input.firstName
    );
  }

  private applyPriceChange(userId: number, delta: number, reason: PriceEventReason, counterpartyUserId: number | null): void {
    // Halted means frozen, full stop — no price movement of any kind, not even the daily gravity pull,
    // until the halt lifts. Single choke point for every price-moving code path (recordMessage,
    // recordReaction, recordReply, applyDailyDecay all funnel through here), so the check only needs to
    // live in one place.
    if (this.isHalted(userId)) {
      return;
    }

    const dampedDelta = this.computeDampedDelta(userId, delta, reason);
    this.commitPriceChange(userId, dampedDelta, reason, counterpartyUserId);
  }

  // Read-only half of applyPriceChange, split out so buy/sell (see below) can find out what a trade WOULD
  // move price to — to price the trade and check affordability against it — before deciding whether the
  // trade actually happens. decay's delta is already computed relative to the average (see
  // applyDailyDecay) — dampening it again here would fight itself, so only message/reply/reaction/trade
  // gains go through dampenGain.
  private computeDampedDelta(userId: number, delta: number, reason: PriceEventReason): number {
    return reason === "decay" ? delta : this.dampenGain(userId, delta);
  }

  // Mutating half of applyPriceChange — actually writes the new price and its audit row. Callers are
  // responsible for their own halted-check beforehand (applyPriceChange does it once for its callers; buy
  // and sell already gate on isHalted earlier, before ever computing a prospective price). Returns the
  // resulting price so trade settlement can use it without a redundant re-SELECT.
  private commitPriceChange(userId: number, dampedDelta: number, reason: PriceEventReason, counterpartyUserId: number | null): number {
    this.ctx.storage.sql.exec(
      `UPDATE players SET price = MAX(${MIN_PRICE}, price + ?), updated_at = datetime('now') WHERE user_id = ?`,
      dampedDelta,
      userId
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO price_events (user_id, counterparty_user_id, reason, delta) VALUES (?, ?, ?, ?)`,
      userId,
      counterpartyUserId,
      reason,
      dampedDelta
    );
    return this.ctx.storage.sql.exec<{ [column: string]: SqlStorageValue; price: number }>(`SELECT price FROM players WHERE user_id = ?`, userId).one()
      .price;
  }

  // Unsigned magnitude of a trade's price impact — same decay shape as recordReply's sameSenderCountToday/
  // distinctSendersSoFarToday (see TRADE_BASE_IMPACT_PCT above), just keyed on 'trade' price_events instead
  // of 'reply'. Caller applies the sign (buy pushes up, sell pushes down) and multiplies by the pre-trade
  // price to get a raw delta.
  private tradeImpactPct(targetUserId: number, traderUserId: number, shares: number): number {
    const occurrencesToday = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; count: number }>(
        `SELECT COUNT(*) as count FROM price_events
         WHERE user_id = ? AND counterparty_user_id = ? AND reason = 'trade' AND created_at >= ${TRADING_DAY_START}`,
        targetUserId,
        traderUserId
      )
      .one().count;

    const distinctTradersToday = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; count: number }>(
        `SELECT COUNT(DISTINCT counterparty_user_id) as count FROM price_events
         WHERE user_id = ? AND reason = 'trade' AND created_at >= ${TRADING_DAY_START}`,
        targetUserId
      )
      .one().count;

    return TRADE_BASE_IMPACT_PCT * shares * Math.pow(IMPACT_DECAY, occurrencesToday) * Math.pow(DISTINCT_SENDER_DECAY, distinctTradersToday);
  }

  // Shrinks GAINS (never losses — a bad reaction/reply-decay always lands at full strength) once a
  // player is already above the chat average, proportional to how far ahead they are. Makes it
  // progressively harder to pull further ahead the further ahead you already are — DAMPEN_SEVERITY keeps
  // that cut from ever fully choking a gain, asymptotically approaching a (1 - DAMPEN_SEVERITY) floor
  // instead of trending toward zero. Complements applyDailyDecay's pull-back, which only fires once a
  // day, with something that applies to every single gain as it happens.
  private dampenGain(userId: number, delta: number): number {
    if (delta <= 0) {
      return delta;
    }

    const row = this.ctx.storage.sql.exec<PlayerRow>(`SELECT price FROM players WHERE user_id = ?`, userId).toArray()[0];
    if (!row) {
      return delta;
    }

    const { count, total } = this.ctx.storage.sql
      .exec<{ [column: string]: SqlStorageValue; count: number; total: number }>(
        `SELECT COUNT(*) as count, COALESCE(SUM(price), 0) as total FROM players`
      )
      .one();
    if (count === 0) {
      return delta;
    }

    const average = total / count;
    if (row.price <= average) {
      return delta;
    }

    const fullCut = 1 - average / row.price;
    return delta * (1 - DAMPEN_SEVERITY * fullCut);
  }
}
